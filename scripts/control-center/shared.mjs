import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const wrangler = join(root, "node_modules", ".bin", "wrangler");
export const workerName = "developer-control-center-status";
export const workerConfigPath = join(root, "worker", "status-api", "wrangler.jsonc");
export const generatedWorkerConfig = join(root, "worker", "status-api", ".wrangler.deploy.jsonc");
export const releaseStateDir = join(root, ".control-center", "releases");

export function readSettings({ requireCloudflare = false } = {}) {
  const required = requireCloudflare
    ? ["CLOUDFLARE_ACCOUNT_ID", "ACCESS_TEAM_DOMAIN", "ACCESS_ALLOWED_EMAILS"]
    : [];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

  const allowedEmails = splitCommaSeparated(process.env.ACCESS_ALLOWED_EMAILS || "");
  return {
    apiToken: process.env.CLOUDFLARE_API_TOKEN?.trim() || (requireCloudflare ? readWranglerAuthToken() : ""),
    accessApiToken: process.env.CLOUDFLARE_ACCESS_API_TOKEN?.trim() || "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "",
    teamDomain: normalizeHostname(process.env.ACCESS_TEAM_DOMAIN || ""),
    allowedEmails,
    dashboardHost: normalizeHostname(process.env.DASHBOARD_HOST || "dashboard.example.com"),
    databaseName: process.env.D1_DATABASE_NAME?.trim() || "developer-control-center-monitoring",
    pagesProjectName: process.env.PAGES_PROJECT_NAME?.trim() || "developer-control-center",
    statusWorkerUrl: normalizeUrl(process.env.STATUS_WORKER_URL || "https://developer-control-center-status.your-subdomain.workers.dev"),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || "",
    statusServiceToken: process.env.STATUS_SERVICE_TOKEN?.trim() || "",
    statusServiceTokenPrevious: process.env.STATUS_SERVICE_TOKEN_PREVIOUS?.trim() || "",
    statusApiToken: process.env.STATUS_API_TOKEN?.trim() || "",
    vpsControlToken: process.env.VPS_CONTROL_TOKEN?.trim() || "",
    accessClientId: process.env.CF_ACCESS_CLIENT_ID?.trim() || "",
    accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET?.trim() || "",
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.trim() || "",
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY?.trim() || "",
    vapidSubject: process.env.VAPID_SUBJECT?.trim() || "mailto:you@example.com",
    autoRollback: process.env.AUTO_ROLLBACK_ON_FAILURE !== "false",
    skipVpsDeploy: process.env.SKIP_VPS_DEPLOY === "true",
    vpsTargets: parseVpsTargets(process.env.VPS_DEPLOY_TARGETS || ""),
  };
}

export function validateSettings(settings, {
  requireCloudflare = false,
  requireVerification = requireCloudflare,
  requireVps = requireCloudflare,
} = {}) {
  const errors = [];
  const warnings = [];
  if (requireCloudflare) {
    if (!/^[a-f0-9]{32}$/i.test(settings.accountId)) errors.push("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID");
    if (settings.apiToken.length < 20) errors.push("CLOUDFLARE_API_TOKEN is missing or unexpectedly short");
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(settings.teamDomain)) errors.push("ACCESS_TEAM_DOMAIN must look like team.cloudflareaccess.com");
    if (!settings.allowedEmails.length || settings.allowedEmails.some((email) => !/^\S+@\S+\.\S+$/.test(email))) {
      errors.push("ACCESS_ALLOWED_EMAILS must contain valid comma-separated email addresses");
    }
  }
  if (requireVerification && !settings.statusApiToken && !settings.accessClientId) errors.push("Provide STATUS_API_TOKEN or a CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET pair for post-deploy verification");
  if (requireVps && !settings.skipVpsDeploy && settings.vpsTargets.length < 1) errors.push("VPS_DEPLOY_TARGETS must describe at least one node, or set SKIP_VPS_DEPLOY=true");
  if (requireVps && !settings.skipVpsDeploy && settings.statusServiceToken.length < 32) errors.push("STATUS_SERVICE_TOKEN is required to deploy the VPS status API");
  if (requireVps && !settings.skipVpsDeploy && (settings.vpsControlToken || "").length < 32) errors.push("VPS_CONTROL_TOKEN is required to deploy the allowlisted VPS control agent");
  if (!isHostname(settings.dashboardHost)) errors.push("DASHBOARD_HOST must be a hostname without a path");
  if (!/^[a-z0-9-]{1,58}$/i.test(settings.databaseName)) errors.push("D1_DATABASE_NAME contains unsupported characters");
  if (!/^[a-z0-9-]{1,58}$/i.test(settings.pagesProjectName)) errors.push("PAGES_PROJECT_NAME contains unsupported characters");
  if (!isHttpsUrl(settings.statusWorkerUrl)) errors.push("STATUS_WORKER_URL must be an HTTPS URL");
  if (Boolean(settings.telegramBotToken) !== Boolean(settings.telegramChatId)) errors.push("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together");
  if (settings.statusApiToken && settings.statusApiToken.length < 32) errors.push("STATUS_API_TOKEN must contain at least 32 characters");
  if (settings.statusServiceToken && settings.statusServiceToken.length < 32) errors.push("STATUS_SERVICE_TOKEN must contain at least 32 characters");
  if (settings.vpsControlToken && settings.vpsControlToken.length < 32) errors.push("VPS_CONTROL_TOKEN must contain at least 32 characters");
  if (settings.vpsControlToken && [settings.statusApiToken, settings.statusServiceToken, settings.statusServiceTokenPrevious].includes(settings.vpsControlToken)) errors.push("VPS_CONTROL_TOKEN must be distinct from status tokens");
  if (settings.statusServiceTokenPrevious && settings.statusServiceTokenPrevious.length < 32) errors.push("STATUS_SERVICE_TOKEN_PREVIOUS must contain at least 32 characters");
  if (settings.statusServiceTokenPrevious && settings.statusServiceTokenPrevious === settings.statusServiceToken) errors.push("STATUS_SERVICE_TOKEN_PREVIOUS must differ from STATUS_SERVICE_TOKEN");
  if (settings.statusApiToken && settings.statusApiToken === settings.statusServiceToken) errors.push("STATUS_API_TOKEN and STATUS_SERVICE_TOKEN must be different");
  if (settings.statusApiToken && settings.statusApiToken === settings.statusServiceTokenPrevious) errors.push("STATUS_API_TOKEN and STATUS_SERVICE_TOKEN_PREVIOUS must be different");
  if (settings.accessApiToken && settings.accessApiToken.length < 20) errors.push("CLOUDFLARE_ACCESS_API_TOKEN is unexpectedly short");
  if (Boolean(settings.accessClientId) !== Boolean(settings.accessClientSecret)) errors.push("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together");
  if (!settings.accessClientId) warnings.push("Access service-token credentials are absent; authenticated Pages smoke checks will be skipped");
  validateVpsTargets(settings.vpsTargets, errors, warnings);
  return { errors, warnings };
}

export function parseVpsTargets(value) {
  if (!value.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("VPS_DEPLOY_TARGETS must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("VPS_DEPLOY_TARGETS must be a JSON array");
  return parsed.map((target) => ({
    name: String(target?.name || "").trim(),
    sshHost: String(target?.sshHost || "").trim(),
    sshPort: Number(target?.sshPort || 22),
    sshUser: String(target?.sshUser || "root").trim(),
    meshHost: String(target?.meshHost || "").trim(),
    identityFile: String(target?.identityFile || "").trim(),
  }));
}

export function parseVpsServicesByTarget(value) {
  if (!value.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("VPS_STATUS_SERVICES_BY_TARGET_JSON must be valid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("VPS_STATUS_SERVICES_BY_TARGET_JSON must be a JSON object");
  }
  for (const [target, services] of Object.entries(parsed)) {
    if (!Array.isArray(services)) throw new Error(`Service list for ${target} must be an array`);
  }
  return parsed;
}

export function validateVpsTargets(targets, errors = [], warnings = []) {
  if (!targets.length) {
    warnings.push("VPS_DEPLOY_TARGETS is absent; VPS orchestration checks will be skipped");
    return { errors, warnings };
  }
  if (targets.length < 1) errors.push("VPS_DEPLOY_TARGETS must describe at least one VPS node");
  const names = new Set();
  const meshHosts = new Set();
  for (const target of targets) {
    if (!target.name || names.has(target.name)) errors.push(`VPS target name is missing or duplicated: ${target.name || "<empty>"}`);
    names.add(target.name);
    if (!target.sshHost) errors.push(`VPS target ${target.name || "<unnamed>"} is missing sshHost`);
    if (!Number.isInteger(target.sshPort) || target.sshPort < 1 || target.sshPort > 65535) errors.push(`VPS target ${target.name || "<unnamed>"} has an invalid sshPort`);
    if (!target.sshUser) errors.push(`VPS target ${target.name || "<unnamed>"} is missing sshUser`);
    if (target.identityFile && !target.identityFile.startsWith("/")) errors.push(`VPS target ${target.name || "<unnamed>"} identityFile must be an absolute path`);
    if (!isIpv4(target.meshHost) || meshHosts.has(target.meshHost)) errors.push(`VPS target ${target.name || "<unnamed>"} has a missing, invalid, or duplicate meshHost`);
    meshHosts.add(target.meshHost);
  }
  return { errors, warnings };
}

export function runWrangler(args, { cwd = root, env = {}, capture = false } = {}) {
  return execFileSync(wrangler, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  }) || "";
}

export function runNpm(args, { capture = false } = {}) {
  return execFileSync("npm", args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  }) || "";
}

export async function cloudflareApi(settings, path, options = {}) {
  const token = path.includes("/access/") && settings.accessApiToken ? settings.accessApiToken : settings.apiToken;
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal || AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const message = payload?.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API request failed for ${path}: ${message}`);
  }
  return payload.result;
}

export function parseWorkerDeploymentVersion(payload) {
  const deployments = Array.isArray(payload) ? payload : payload?.versions ? [payload] : payload?.deployments || payload?.items || [];
  const active = deployments.find((item) => item?.active || item?.status === "active") || deployments[0];
  const versions = active?.versions || active?.version_traffic || [];
  const version = versions.find((item) => Number(item?.percentage ?? item?.traffic ?? 100) > 0) || versions[0];
  return version?.version_id || version?.id || active?.version_id || active?.version?.id || null;
}

export function selectProductionPagesDeployment(deployments) {
  if (!Array.isArray(deployments)) return null;
  return deployments.find((item) => item?.environment === "production" && item?.latest_stage?.status === "success" && !item?.is_skipped)
    || deployments.find((item) => item?.environment === "production" && !item?.is_skipped)
    || null;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readWranglerAuthToken() {
  try {
    const payload = JSON.parse(execFileSync(wrangler, ["auth", "token", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
    return typeof payload.token === "string" ? payload.token.trim() : "";
  } catch {
    return "";
  }
}

function splitCommaSeparated(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeHostname(value) {
  return String(value).trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function normalizeUrl(value) {
  return String(value).trim().replace(/\/$/, "");
}

function isHostname(value) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isIpv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
