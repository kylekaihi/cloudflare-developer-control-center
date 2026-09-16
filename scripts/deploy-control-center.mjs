import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudflareApi,
  generatedWorkerConfig,
  parseWorkerDeploymentVersion,
  readSettings,
  root,
  runWrangler,
  selectProductionPagesDeployment,
  workerConfigPath,
  workerName,
  wrangler,
} from "./control-center/shared.mjs";
import {
  createReleaseState,
  findOutputIdentifier,
  markPhase,
  parseWranglerOutput,
  writeReleaseState,
} from "./control-center/release-state.mjs";
import { rollbackRelease } from "./control-center/rollback-operations.mjs";

const settings = readSettings({ requireCloudflare: true });
const tempPagesRoot = mkdtempSync(join(tmpdir(), "dcc-pages-"));
const state = createReleaseState(settings);
const statePath = writeReleaseState(state);

try {
  console.log("[1/14] Running deployment preflight and quality gates");
  runNode([join(root, "scripts", "control-center", "preflight.mjs"), "--deploy", "--quality"]);
  markAndSave("preflight");

  console.log("[2/14] Validating Cloudflare credentials");
  await cloudflareApi(settings, `/accounts/${settings.accountId}`);
  markAndSave("credentials");

  console.log("[3/14] Exporting a pre-change recovery backup");
  const backupOutputPath = join(tempPagesRoot, "backup-output.json");
  runNode([join(root, "scripts", "backup-control-center.mjs")], { BACKUP_OUTPUT_FILE: backupOutputPath });
  state.backupDirectory = JSON.parse(readFileSync(backupOutputPath, "utf8")).backupDirectory;
  markAndSave("recovery-backup");

  console.log("[4/14] Capturing the current Worker and Pages rollback targets");
  await captureRollbackTargets();
  markAndSave("rollback-baseline");

  console.log("[5/14] Validating existing Worker secrets");
  validateRequiredWorkerSecrets();
  markAndSave("worker-secrets-validation");

  console.log("[6/14] Installing or upgrading the status API on all configured VPS nodes");
  if (settings.skipVpsDeploy) {
    markPhase(state, "vps-deploy", "skipped", "SKIP_VPS_DEPLOY=true");
    writeReleaseState(state, statePath);
  } else {
    const vpsOutputPath = join(tempPagesRoot, "vps-output.json");
    runNode([join(root, "scripts", "deploy-vps-status-api.mjs"), "upgrade"], { VPS_DEPLOY_OUTPUT_FILE: vpsOutputPath });
    const vpsOutput = JSON.parse(readFileSync(vpsOutputPath, "utf8"));
    state.changes.vps = vpsOutput.outcomes.some((outcome) => outcome.status === "ok" && outcome.changed);
    markAndSave("vps-deploy");
  }

  console.log("[7/14] Creating or locating the D1 monitoring database");
  const database = ensureD1Database(settings.databaseName);
  state.databaseId = database.uuid;
  markAndSave("d1-provisioning");

  console.log("[8/14] Provisioning Cloudflare Access application and policy");
  const accessResult = await provisionAccess(settings);
  const access = accessResult.application;
  state.accessApplicationId = access.id;
  state.changes.accessCreated = accessResult.created;
  writeWorkerConfig(database.uuid, access.aud, settings.teamDomain);
  markAndSave("access-provisioning");

  console.log("[9/14] Applying backward-compatible D1 migrations");
  runWrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", generatedWorkerConfig], { env: { CI: "1" } });
  markAndSave("d1-migrations");

  console.log("[10/14] Deploying the status Worker, D1 binding, and five-minute Cron Trigger");
  state.changes.worker = true;
  writeReleaseState(state, statePath);
  const workerOutputPath = join(tempPagesRoot, "worker-output.ndjson");
  runWrangler(["deploy", "--config", generatedWorkerConfig, "--keep-vars"], { env: { WRANGLER_OUTPUT_FILE_PATH: workerOutputPath } });

  console.log("[11/14] Configuring Worker and optional Telegram secrets");
  if (settings.statusServiceToken) putWorkerSecret("STATUS_SERVICE_TOKEN", settings.statusServiceToken);
  if (settings.vpsControlToken) putWorkerSecret("VPS_CONTROL_TOKEN", settings.vpsControlToken);
  if (settings.statusApiToken) putWorkerSecret("STATUS_API_TOKEN", settings.statusApiToken);
  if (settings.vapidPrivateKey) putWorkerSecret("VAPID_PRIVATE_KEY", settings.vapidPrivateKey);
  if (settings.telegramBotToken && settings.telegramChatId) {
    putWorkerSecret("TELEGRAM_BOT_TOKEN", settings.telegramBotToken);
    putWorkerSecret("TELEGRAM_CHAT_ID", settings.telegramChatId);
  } else {
    console.log("      Telegram credentials not supplied; notifications remain disabled until both secrets are set.");
  }
  markAndSave("worker-secrets");
  state.deployed.workerVersionId = await currentWorkerVersion()
    || outputId(workerOutputPath, "deploy", ["version_id", "worker_tag"]);
  markAndSave("worker-deploy");

  console.log("[12/14] Preparing the Access-enabled Pages deployment");
  preparePagesDeployment();
  markAndSave("pages-prepare");

  console.log("[13/14] Deploying Pages Functions and static assets");
  const pagesOutputPath = join(tempPagesRoot, "pages-output.ndjson");
  runWrangler([
    "pages", "deploy", "dist", "--project-name", settings.pagesProjectName,
    "--branch", "main", "--commit-dirty=true",
  ], { cwd: tempPagesRoot, env: { WRANGLER_OUTPUT_FILE_PATH: pagesOutputPath } });
  state.changes.pages = true;
  state.deployed.pagesDeploymentId = outputId(pagesOutputPath, "pages-deploy", ["deployment_id", "id"])
    || (await currentPagesDeployment())?.id
    || null;
  markAndSave("pages-deploy");

  console.log("[14/14] Running post-deploy acceptance checks");
  runNode([join(root, "scripts", "postdeploy-control-center.mjs")]);
  markAndSave("postdeploy-verification");

  state.status = "complete";
  writeReleaseState(state, statePath);
  console.log("\nDeployment completed.");
  console.log(`Dashboard: https://${settings.dashboardHost}/dashboard/`);
  console.log(`D1 database: ${settings.databaseName} (${database.uuid})`);
  console.log(`Access audience: ${access.aud}`);
  console.log(`Release state: ${statePath}`);
} catch (error) {
  state.status = "failed";
  state.error = error instanceof Error ? error.message : String(error);
  markPhase(state, "deployment", "failed", state.error);
  writeReleaseState(state, statePath);
  if (settings.autoRollback && (state.changes.vps || state.changes.worker || state.changes.pages || state.changes.accessCreated)) {
    console.error("\nDeployment failed; attempting automatic rollback of versioned components.");
    const result = await rollbackRelease(settings, state, { statePath, reason: `Automatic rollback after failed release ${state.releaseId}` });
    if (!result.completed) console.error(`Rollback needs attention: ${result.errors.join("; ")}`);
  } else {
    console.error(`\nDeployment failed. Run: npm run rollback:control-center -- ${statePath}`);
  }
  throw error;
} finally {
  rmSync(generatedWorkerConfig, { force: true });
  rmSync(tempPagesRoot, { recursive: true, force: true });
}

function validateRequiredWorkerSecrets() {
  const existing = JSON.parse(runWrangler(["secret", "list", "--config", workerConfigPath, "--format", "json"], { capture: true }));
  const names = new Set(existing.map((secret) => secret.name));
  const missing = [
    !settings.statusServiceToken && !names.has("STATUS_SERVICE_TOKEN") ? "STATUS_SERVICE_TOKEN" : null,
    !settings.statusApiToken && !names.has("STATUS_API_TOKEN") ? "STATUS_API_TOKEN" : null,
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Required Worker secrets are missing. Set them in the environment before deployment: ${missing.join(", ")}`);
  }
}

async function provisionAccess(config) {
  const domain = `${config.dashboardHost}/dashboard/*`;
  const applications = await cloudflareApi(config, `/accounts/${config.accountId}/access/apps?per_page=100`);
  let application = applications.find((item) => item.domain === domain);
  const created = !application;
  const applicationBody = {
    name: "Developer Control Center",
    domain,
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    auto_redirect_to_identity: false,
  };
  if (application) {
    application = await cloudflareApi(config, `/accounts/${config.accountId}/access/apps/${application.id}`, {
      method: "PUT",
      body: applicationBody,
    });
  } else {
    application = await cloudflareApi(config, `/accounts/${config.accountId}/access/apps`, {
      method: "POST",
      body: applicationBody,
    });
  }

  const policyName = "Allow Developer Control Center operators";
  const policies = await cloudflareApi(config, `/accounts/${config.accountId}/access/apps/${application.id}/policies?per_page=100`);
  const existingPolicy = policies.find((item) => item.name === policyName);
  const policyBody = {
    name: policyName,
    decision: "allow",
    precedence: 1,
    include: config.allowedEmails.map((email) => ({ email: { email } })),
    require: [],
    exclude: [],
  };
  await cloudflareApi(
    config,
    `/accounts/${config.accountId}/access/apps/${application.id}/policies${existingPolicy ? `/${existingPolicy.id}` : ""}`,
    { method: existingPolicy ? "PUT" : "POST", body: policyBody },
  );
  if (!application.aud) throw new Error("Cloudflare Access application response did not include an audience tag");
  return { application, created };
}

function ensureD1Database(name) {
  let databases = JSON.parse(runWrangler(["d1", "list", "--json"], { capture: true }));
  let database = databases.find((item) => item.name === name);
  if (!database) {
    runWrangler(["d1", "create", name, "--location", "apac"]);
    databases = JSON.parse(runWrangler(["d1", "list", "--json"], { capture: true }));
    database = databases.find((item) => item.name === name);
  }
  if (!database?.uuid) throw new Error(`Unable to locate D1 database ${name} after creation`);
  return database;
}

function writeWorkerConfig(databaseId, accessAudience, teamDomain) {
  const config = JSON.parse(readFileSync(workerConfigPath, "utf8"));
  config.d1_databases = [{
    binding: "DB",
    database_name: settings.databaseName,
    database_id: databaseId,
    migrations_dir: "migrations",
  }];
  config.vars = { ...config.vars, ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: accessAudience, VPS_CONTROL_CATALOG: buildControlCatalog() };
  if (settings.vapidPublicKey) config.vars.VAPID_PUBLIC_KEY = settings.vapidPublicKey;
  if (settings.vapidSubject) config.vars.VAPID_SUBJECT = settings.vapidSubject;
  writeFileSync(generatedWorkerConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function buildControlCatalog() {
  const actions = JSON.parse(process.env.VPS_CONTROL_ACTIONS_BY_TARGET_JSON || "{}");
  return JSON.stringify(settings.vpsTargets.flatMap((target) => (actions[target.name] || []).map((item) => ({ host: target.meshHost, name: item.name, canRestart: item.canRestart === true, canReadLogs: item.canReadLogs !== false }))));
}

function preparePagesDeployment() {
  // Wrangler creates and resolves build artifacts below the current directory.
  // Real directories avoid macOS /var -> /private/var symlink canonicalization
  // producing a duplicated temporary path during Pages Functions compilation.
  cpSync(join(root, "dist"), join(tempPagesRoot, "dist"), { recursive: true });
  cpSync(join(root, "functions"), join(tempPagesRoot, "functions"), { recursive: true });
  const pagesConfig = JSON.parse(readFileSync(join(root, "infra", "pages.wrangler.jsonc"), "utf8"));
  pagesConfig.name = settings.pagesProjectName;
  pagesConfig.$schema = join(root, "node_modules", "wrangler", "config-schema.json");
  writeFileSync(join(tempPagesRoot, "wrangler.jsonc"), `${JSON.stringify(pagesConfig, null, 2)}\n`);
}

function putWorkerSecret(name, value) {
  const result = spawnSync(wrangler, ["secret", "put", name, "--config", generatedWorkerConfig], {
    cwd: root,
    env: process.env,
    input: `${value}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error(`Failed to configure Worker secret ${name}`);
}

async function captureRollbackTargets() {
  state.previous.workerVersionId = await currentWorkerVersion();
  state.previous.pagesDeploymentId = (await currentPagesDeployment())?.id || null;
  writeReleaseState(state, statePath);
}

async function currentWorkerVersion() {
  try {
    const payload = JSON.parse(runWrangler(["deployments", "status", "--name", workerName, "--json"], { capture: true }));
    return parseWorkerDeploymentVersion(payload);
  } catch {
    console.log("      No existing Worker deployment was found; Worker rollback will be unavailable for an initial deployment.");
    return null;
  }
}

async function currentPagesDeployment() {
  try {
    const deployments = await cloudflareApi(
      settings,
      `/accounts/${settings.accountId}/pages/projects/${encodeURIComponent(settings.pagesProjectName)}/deployments?env=production&per_page=25`,
    );
    return selectProductionPagesDeployment(deployments);
  } catch {
    console.log("      No existing Pages production deployment was found; Pages rollback will be unavailable for an initial deployment.");
    return null;
  }
}

function outputId(path, eventType, keys) {
  if (!existsSync(path)) return null;
  return findOutputIdentifier(parseWranglerOutput(readFileSync(path, "utf8")), eventType, keys);
}

function markAndSave(name) {
  markPhase(state, name);
  writeReleaseState(state, statePath);
}

function runNode(args, extraEnv = {}) {
  execFileSync(process.execPath, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: "inherit" });
}
