import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSettings, root, validateSettings, workerConfigPath, wrangler } from "./control-center/shared.mjs";

const command = process.argv[2];
const confirmation = process.argv.find((argument) => argument.startsWith("--confirm="))?.slice("--confirm=".length);
if (!["prepare", "finalize", "abort"].includes(command)) throw new Error("Usage: npm run rotate:service-token -- prepare|finalize|abort --confirm=ROTATE_SERVICE_TOKEN");
if (confirmation !== "ROTATE_SERVICE_TOKEN") throw new Error("Add --confirm=ROTATE_SERVICE_TOKEN to authorize remote secret changes");

const oldToken = process.env.OLD_STATUS_SERVICE_TOKEN?.trim() || "";
const newToken = process.env.NEW_STATUS_SERVICE_TOKEN?.trim() || "";
if (oldToken.length < 32 || newToken.length < 32 || oldToken === newToken) throw new Error("OLD_STATUS_SERVICE_TOKEN and NEW_STATUS_SERVICE_TOKEN must be distinct values of at least 32 characters");

const settings = readSettings({ requireCloudflare: true });
if (!settings.statusApiToken) throw new Error("STATUS_API_TOKEN is required to verify service-token rotation through the Worker");
const validation = validateSettings({ ...settings, statusServiceToken: newToken, statusServiceTokenPrevious: oldToken }, { requireCloudflare: true });
if (validation.errors.length) throw new Error(validation.errors.join("; "));
const stateDirectory = join(root, ".control-center", "rotations");
const statePath = join(stateDirectory, "status-service-token.json");

if (command === "prepare") await prepare();
if (command === "finalize") await finalize();
if (command === "abort") await abort();

async function prepare() {
  try {
    deployVps(newToken, oldToken);
    putWorkerToken(newToken);
    await verifyWorker();
    writeState("prepared");
    console.log("Rotation prepared: Worker uses the new token and VPS nodes temporarily accept new + previous tokens.");
  } catch (error) {
    const recoveryErrors = [];
    try { putWorkerToken(oldToken); } catch (recoveryError) { recoveryErrors.push(`Worker recovery failed: ${message(recoveryError)}`); }
    try { deployVps(oldToken, ""); } catch (recoveryError) { recoveryErrors.push(`VPS recovery failed: ${message(recoveryError)}`); }
    throw new Error(`Rotation prepare failed: ${message(error)}${recoveryErrors.length ? `; ${recoveryErrors.join("; ")}` : "; old token restored"}`);
  }
}

async function finalize() {
  requirePreparedState();
  await verifyWorker();
  deployVps(newToken, "");
  writeState("completed");
  console.log("Rotation completed: the previous token has been removed from all VPS nodes.");
}

async function abort() {
  requirePreparedState();
  putWorkerToken(oldToken);
  deployVps(oldToken, "");
  await verifyWorker();
  writeState("aborted");
  console.log("Rotation aborted: the old token is active and the new token has been removed from VPS nodes.");
}

function deployVps(current, previous) {
  execFileSync(process.execPath, [join(root, "scripts", "deploy-vps-status-api.mjs"), "upgrade"], {
    cwd: root,
    env: { ...process.env, STATUS_SERVICE_TOKEN: current, STATUS_SERVICE_TOKEN_PREVIOUS: previous },
    stdio: "inherit",
  });
}

function putWorkerToken(token) {
  const result = spawnSync(wrangler, ["secret", "put", "STATUS_SERVICE_TOKEN", "--config", workerConfigPath], {
    cwd: root,
    env: process.env,
    input: `${token}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error("Worker STATUS_SERVICE_TOKEN update failed");
}

async function verifyWorker() {
  let lastError = "verification did not run";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`${settings.statusWorkerUrl}/api/status`, {
        headers: { Authorization: `Bearer ${settings.statusApiToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.hosts) && payload.hosts.length === 3 && payload.hosts.every((host) => host.reachable)) return;
      lastError = `HTTP ${response.status}; reachable hosts ${payload?.hosts?.filter((host) => host.reachable).length || 0}/3`;
    } catch (error) { lastError = message(error); }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Worker cannot reach all VPS nodes with the active token: ${lastError}`);
}

function requirePreparedState() {
  if (!existsSync(statePath)) throw new Error("No prepared rotation state was found");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.stage !== "prepared" || state.oldFingerprint !== fingerprint(oldToken) || state.newFingerprint !== fingerprint(newToken)) {
    throw new Error("Rotation state does not match the supplied old/new tokens");
  }
}

function writeState(stage) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(statePath, `${JSON.stringify({
    schemaVersion: 1,
    stage,
    updatedAt: new Date().toISOString(),
    workerName: "developer-control-center-status",
    oldFingerprint: fingerprint(oldToken),
    newFingerprint: fingerprint(newToken),
  }, null, 2)}\n`, { mode: 0o600 });
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
