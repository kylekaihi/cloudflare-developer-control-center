import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVpsServicesByTarget, readSettings, root, validateVpsTargets } from "./control-center/shared.mjs";

const command = process.argv[2];
if (!["install", "upgrade", "healthcheck", "rollback"].includes(command)) {
  throw new Error("Usage: npm run vps:status-api -- install|upgrade|healthcheck|rollback");
}

const settings = readSettings();
const servicesByTarget = parseVpsServicesByTarget(process.env.VPS_STATUS_SERVICES_BY_TARGET_JSON || "");
const controlActionsByTarget = parseVpsServicesByTarget(process.env.VPS_CONTROL_ACTIONS_BY_TARGET_JSON || "");
const validation = validateVpsTargets(settings.vpsTargets);
if (validation.errors.length) throw new Error(validation.errors.join("; "));
if (!settings.vpsTargets.length) throw new Error("VPS_DEPLOY_TARGETS is required");
if (["install", "upgrade"].includes(command) && settings.statusServiceToken.length < 32) {
  throw new Error("STATUS_SERVICE_TOKEN with at least 32 characters is required for install/upgrade");
}

const temporary = mkdtempSync(join(tmpdir(), "dcc-vps-release-"));
const bundle = join(temporary, "status-api");
try {
  cpSync(join(root, "status-api"), bundle, { recursive: true });
  cpSync(join(root, "scripts", "vps-status-api.sh"), join(temporary, "vps-status-api.sh"));
  if (["install", "upgrade"].includes(command)) {
    for (const target of settings.vpsTargets) writeEnvironmentFile(environmentPath(target), target);
  }

  const outcomes = [];
  for (const target of settings.vpsTargets) {
    try {
      const result = deployTarget(target, command);
      outcomes.push({ target: target.name, status: "ok", changed: result.changed });
    } catch (error) {
      outcomes.push({ target: target.name, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (settings.autoRollback && ["install", "upgrade"].includes(command) && outcomes.some((outcome) => outcome.status === "failed")) {
    for (const outcome of outcomes.filter((item) => item.status === "ok" && item.changed).reverse()) {
      const target = settings.vpsTargets.find((item) => item.name === outcome.target);
      try {
        deployTarget(target, "rollback");
        outcome.rollback = "completed";
      } catch (error) {
        outcome.rollback = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  console.log("\nVPS status-api results");
  for (const outcome of outcomes) console.log(`${outcome.status === "ok" ? "✓" : "✗"} ${outcome.target}${outcome.changed ? " — changed" : ""}${outcome.error ? ` — ${outcome.error}` : ""}${outcome.rollback ? ` — rollback ${outcome.rollback}` : ""}`);
  if (process.env.VPS_DEPLOY_OUTPUT_FILE) writeFileSync(process.env.VPS_DEPLOY_OUTPUT_FILE, `${JSON.stringify({ command, outcomes }, null, 2)}\n`, { mode: 0o600 });
  if (outcomes.some((outcome) => outcome.status === "failed")) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function deployTarget(target, requestedCommand) {
  const destination = `${target.sshUser}@${target.sshHost}`;
  const sshArgs = connectionArgs(target);
  const remoteDirectory = execFileSync("ssh", [...sshArgs, destination, "mktemp -d /tmp/dcc-status-api.XXXXXX"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  if (!/^\/tmp\/dcc-status-api\.[A-Za-z0-9]+$/.test(remoteDirectory)) throw new Error(`unexpected remote temporary path: ${remoteDirectory}`);
  try {
    execFileSync("scp", [...scpConnectionArgs(target), "-r", bundle, join(temporary, "vps-status-api.sh"), `${destination}:${remoteDirectory}/`], { stdio: "inherit" });
    if (["install", "upgrade"].includes(requestedCommand)) {
      execFileSync("scp", [...scpConnectionArgs(target), environmentPath(target), `${destination}:${remoteDirectory}/status-api.env`], { stdio: "inherit" });
    }
    const output = execFileSync("ssh", [...sshArgs, destination, remoteInstallCommand(target, remoteDirectory, requestedCommand)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    process.stdout.write(output);
    return { changed: ["install", "upgrade"].includes(requestedCommand) && output.includes("status-api release active:") };
  } finally {
    try {
      execFileSync("ssh", [...sshArgs, destination, `rm -rf -- ${shellQuote(remoteDirectory)}`], { stdio: "ignore" });
    } catch {
      console.error(`Warning: temporary directory cleanup failed on ${target.name}: ${remoteDirectory}`);
    }
  }
}

function remoteInstallCommand(target, remoteDirectory, requestedCommand) {
  const privilege = target.sshUser === "root" ? "" : "sudo -n ";
  const script = `${remoteDirectory}/vps-status-api.sh`;
  const options = ["install", "upgrade"].includes(requestedCommand)
    ? ` --source ${shellQuote(`${remoteDirectory}/status-api`)} --env-source ${shellQuote(`${remoteDirectory}/status-api.env`)}`
    : "";
  return `chmod 700 ${shellQuote(script)} && chmod 600 ${shellQuote(`${remoteDirectory}/status-api.env`)} 2>/dev/null || true; ${privilege}bash ${shellQuote(script)} ${requestedCommand}${options}`;
}

function writeEnvironmentFile(path, target) {
  const fallbackServices = JSON.parse(process.env.VPS_STATUS_SERVICES_JSON || "[]");
  const services = JSON.stringify(servicesByTarget[target.name] || fallbackServices);
  const pnl = JSON.stringify(JSON.parse(process.env.VPS_STATUS_PNL_SUMMARY_JSON || "null"));
  const release = process.env.STATUS_RELEASE || new Date().toISOString();
  const commit = process.env.STATUS_GIT_COMMIT || gitCommit();
  const content = [
    "STATUS_API_PORT=18787",
    "CONTROL_API_PORT=18788",
    `CONTROL_BIND_HOST=${envValue(target.meshHost)}`,
    `STATUS_SERVICE_TOKEN=${envValue(settings.statusServiceToken)}`,
    `STATUS_SERVICE_TOKEN_PREVIOUS=${envValue(settings.statusServiceTokenPrevious)}`,
    `VPS_CONTROL_TOKEN=${envValue(settings.vpsControlToken)}`,
    `STATUS_GIT_COMMIT=${envValue(commit)}`,
    `STATUS_RELEASE=${envValue(release)}`,
    `STATUS_DEPLOYED_AT=${envValue(new Date().toISOString())}`,
    `STATUS_SERVICES_JSON=${envValue(services)}`,
    `STATUS_PNL_SUMMARY_JSON=${envValue(pnl)}`,
    `STATUS_ENABLE_DOCKER_DISCOVERY=${envValue(process.env.STATUS_ENABLE_DOCKER_DISCOVERY === "true" ? "true" : "false")}`,
    `STATUS_DOCKER_DISCOVERY_MODE=${envValue(process.env.STATUS_DOCKER_DISCOVERY_MODE === "all" ? "all" : "running")}`,
    `STATUS_SERVICE_DISCOVERY_MODE=${envValue(process.env.VPS_STATUS_DISCOVERY_MODE === "replace" ? "replace" : "merge")}`,
    `STATUS_ALERT_RULES_JSON=${envValue(process.env.VPS_STATUS_ALERT_RULES_JSON || "{}")}`,
    `STATUS_EXTERNAL_CHECKS_JSON=${envValue(process.env.VPS_STATUS_EXTERNAL_CHECKS_JSON || "[]")}`,
    `VPS_CONTROL_ACTIONS_JSON=${envValue(JSON.stringify(controlActionsByTarget[target.name] || []))}`,
    "",
  ].join("\n");
  writeFileSync(path, content, { mode: 0o600 });
}

function environmentPath(target) {
  return join(temporary, `status-api-${target.name}.env`);
}

function gitCommit() {
  try { return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

function connectionArgs(target) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-p", String(target.sshPort)];
  const identityFile = target.identityFile || process.env.VPS_SSH_IDENTITY_FILE;
  if (identityFile) args.push("-i", identityFile);
  return args;
}

function scpConnectionArgs(target) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-P", String(target.sshPort)];
  const identityFile = target.identityFile || process.env.VPS_SSH_IDENTITY_FILE;
  if (identityFile) args.push("-i", identityFile);
  return args;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function envValue(value) {
  return `"${String(value)
    .replace(/[\r\n]/g, "")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}
