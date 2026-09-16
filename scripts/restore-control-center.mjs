import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { cloudflareApi, readSettings, root, runWrangler, validateSettings } from "./control-center/shared.mjs";

const requestedDirectory = process.argv[2] || "";
const backupDirectory = resolve(requestedDirectory);
const confirmation = process.argv.find((argument) => argument.startsWith("--confirm="))?.slice("--confirm=".length);
const restoreD1 = process.argv.includes("--restore-d1");
const expectedRoot = join(root, ".control-center", "backups") + sep;
if (!requestedDirectory || !isAbsolute(requestedDirectory) || !backupDirectory.startsWith(expectedRoot)) {
  throw new Error("Pass an absolute backup directory under .control-center/backups/");
}
if (confirmation !== "RESTORE_CONTROL_CENTER") throw new Error("Add --confirm=RESTORE_CONTROL_CENTER to authorize remote rollback");

const manifestPath = join(backupDirectory, "manifest.json");
if (!existsSync(manifestPath)) throw new Error("Backup manifest not found");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1) throw new Error("Unsupported backup manifest");
const exportArtifact = manifest.artifacts?.d1Export || null;
const exportPath = exportArtifact ? join(backupDirectory, exportArtifact.file) : null;
if (exportArtifact && (basename(exportArtifact.file) !== exportArtifact.file || !resolve(exportPath).startsWith(`${backupDirectory}${sep}`))) throw new Error("Invalid D1 export artifact path");
if (exportPath && (!existsSync(exportPath) || sha256(exportPath) !== exportArtifact.sha256)) throw new Error("D1 export checksum mismatch");

const settings = readSettings({ requireCloudflare: true });
const validation = validateSettings(settings, { requireCloudflare: true, requireVerification: false, requireVps: false });
if (validation.errors.length) throw new Error(validation.errors.join("; "));
if (settings.accountId !== manifest.accountId
  || settings.dashboardHost !== manifest.dashboardHost
  || settings.pagesProjectName !== manifest.pagesProjectName
  || settings.databaseName !== manifest.databaseName
  || manifest.workerName !== "developer-control-center-status") {
  throw new Error("Backup target does not match current deployment settings");
}

if (manifest.pagesDeploymentId) {
  await cloudflareApi(settings, `/accounts/${settings.accountId}/pages/projects/${encodeURIComponent(settings.pagesProjectName)}/deployments/${encodeURIComponent(manifest.pagesDeploymentId)}/rollback`, { method: "POST", body: {} });
  console.log(`Pages rolled back to ${manifest.pagesDeploymentId}`);
}
if (manifest.workerVersionId) {
  runWrangler(["rollback", manifest.workerVersionId, "--name", manifest.workerName, "--message", `Restore backup ${manifest.backupId}`, "--yes"]);
  console.log(`Worker rolled back to ${manifest.workerVersionId}`);
}
if (restoreD1) {
  if (!manifest.d1Bookmark) throw new Error("Backup has no D1 Time Travel bookmark");
  runWrangler(["d1", "time-travel", "restore", manifest.databaseName, "--bookmark", manifest.d1Bookmark]);
  console.log(`D1 restored to bookmark ${manifest.d1Bookmark}`);
} else {
  console.log("D1 was not restored. Add --restore-d1 only after confirming data loss is acceptable.");
}

console.log("Access configuration is retained as evidence in manifest.json; it is not overwritten automatically.");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
