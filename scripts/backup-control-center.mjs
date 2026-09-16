import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cloudflareApi,
  parseWorkerDeploymentVersion,
  readSettings,
  root,
  runWrangler,
  selectProductionPagesDeployment,
  validateSettings,
  workerName,
} from "./control-center/shared.mjs";

const settings = readSettings({ requireCloudflare: true });
const validation = validateSettings(settings, { requireCloudflare: true, requireVerification: false, requireVps: false });
if (validation.errors.length) throw new Error(validation.errors.join("; "));

const backupId = new Date().toISOString().replace(/[:.]/g, "-");
const backupDirectory = join(root, ".control-center", "backups", backupId);
mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });

await cloudflareApi(settings, `/accounts/${settings.accountId}`);
const warnings = [];
const workerPayload = attempt(() => JSON.parse(runWrangler(["deployments", "status", "--name", workerName, "--json"], { capture: true })), null, "No existing Worker rollback target was captured");
const pagesDeployments = await attemptAsync(() => cloudflareApi(settings, `/accounts/${settings.accountId}/pages/projects/${encodeURIComponent(settings.pagesProjectName)}/deployments?env=production&per_page=25`), [], "No existing Pages rollback target was captured");
const pagesDeployment = selectProductionPagesDeployment(pagesDeployments);
const accessApps = await cloudflareApi(settings, `/accounts/${settings.accountId}/access/apps?per_page=100`);
const accessApp = accessApps.find((item) => item.domain === `${settings.dashboardHost}/dashboard/*`) || null;
const accessPolicies = accessApp
  ? await cloudflareApi(settings, `/accounts/${settings.accountId}/access/apps/${accessApp.id}/policies?per_page=100`)
  : [];
const databases = JSON.parse(runWrangler(["d1", "list", "--json"], { capture: true }));
const databaseExists = databases.some((database) => database.name === settings.databaseName);
const timeTravel = databaseExists
  ? attempt(() => JSON.parse(runWrangler(["d1", "time-travel", "info", settings.databaseName, "--json"], { capture: true })), null, "D1 Time Travel bookmark was unavailable; SQL export remains available")
  : null;
const databaseFile = databaseExists ? join(backupDirectory, "d1-export.sql") : null;
if (databaseFile) runWrangler(["d1", "export", settings.databaseName, "--remote", "--skip-confirmation", "--output", databaseFile]);

const manifest = {
  schemaVersion: 1,
  backupId,
  createdAt: new Date().toISOString(),
  warnings,
  accountId: settings.accountId,
  dashboardHost: settings.dashboardHost,
  pagesProjectName: settings.pagesProjectName,
  databaseName: settings.databaseName,
  workerName,
  workerVersionId: parseWorkerDeploymentVersion(workerPayload),
  pagesDeploymentId: pagesDeployment?.id || null,
  d1Bookmark: findBookmark(timeTravel),
  access: accessApp ? {
    application: pick(accessApp, ["id", "name", "domain", "type", "session_duration", "app_launcher_visible", "auto_redirect_to_identity", "aud"]),
    policies: accessPolicies.map((policy) => pick(policy, ["id", "name", "decision", "precedence", "include", "exclude", "require"])),
  } : null,
  artifacts: { d1Export: databaseFile ? { file: "d1-export.sql", sha256: sha256(databaseFile), bytes: readFileSync(databaseFile).byteLength } : null },
};

const manifestPath = join(backupDirectory, "manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
if (databaseFile) chmodSync(databaseFile, 0o600);
if (process.env.BACKUP_OUTPUT_FILE) writeFileSync(process.env.BACKUP_OUTPUT_FILE, `${JSON.stringify({ backupDirectory, manifestPath })}\n`, { mode: 0o600 });
console.log(`Control Center backup completed: ${backupDirectory}`);
console.log(`Worker version: ${manifest.workerVersionId || "not found"}`);
console.log(`Pages deployment: ${manifest.pagesDeploymentId || "not found"}`);
console.log(`D1 Time Travel bookmark: ${manifest.d1Bookmark || "not returned"}`);
for (const warning of warnings) console.warn(`Warning: ${warning}`);

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

function findBookmark(value) {
  if (typeof value?.bookmark === "string") return value.bookmark;
  if (typeof value?.result?.bookmark === "string") return value.result.bookmark;
  const match = JSON.stringify(value).match(/"bookmark"\s*:\s*"([^"]+)"/);
  return match?.[1] || null;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function attempt(operation, fallback, warning) {
  try { return operation(); } catch { if (warning) warnings.push(warning); return fallback; }
}

async function attemptAsync(operation, fallback, warning) {
  try { return await operation(); } catch { if (warning) warnings.push(warning); return fallback; }
}
