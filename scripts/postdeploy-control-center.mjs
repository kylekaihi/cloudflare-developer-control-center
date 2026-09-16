import {
  cloudflareApi,
  readJson,
  readSettings,
  validateSettings,
  workerConfigPath,
  workerName,
} from "./control-center/shared.mjs";
import {
  hasCronSchedule,
  isAccessProtectedResponse,
  readExpectedHosts,
  validateManifest,
  validateStatusPayload,
} from "./control-center/postdeploy-checks.mjs";

const settings = readSettings({ requireCloudflare: true });
const settingsValidation = validateSettings(settings, { requireCloudflare: true });
if (settingsValidation.errors.length) throw new Error(settingsValidation.errors.join("; "));
const dashboardBase = `https://${settings.dashboardHost}/dashboard/`;
const workerConfig = readJson(workerConfigPath);
const expectedHosts = readExpectedHosts(workerConfig);
const timeoutSeconds = clamp(Number(process.env.POST_DEPLOY_TIMEOUT_SECONDS || 90), 15, 300);
const results = [];

await check("Cloudflare Access blocks unauthenticated Dashboard requests", verifyAccessProtection);
await check("status Worker health endpoint", verifyWorkerHealth);
await check("five-minute Cron Trigger", verifyCronTrigger);
await check("configured VPS nodes through Mesh", verifyStatusAndMesh);
await check("D1 metrics receive scheduled samples", verifyMetricsPersistence);
await check("authenticated Pages Function service binding", verifyPagesBinding, { optional: !settings.accessClientId });
await check("PWA manifest, Service Worker, and offline page", verifyPwa, { optional: !settings.accessClientId });

console.log("\nControl Center post-deploy verification");
for (const item of results) console.log(`${item.status === "PASS" ? "✓" : item.status === "WARN" ? "!" : "✗"} ${item.name}${item.message ? ` — ${item.message}` : ""}`);
const failures = results.filter((item) => item.status === "FAIL");
const warnings = results.filter((item) => item.status === "WARN");
console.log(`\n${results.length - failures.length - warnings.length} passed, ${warnings.length} warnings, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;

async function check(name, operation, { optional = false } = {}) {
  if (optional) {
    results.push({ status: "WARN", name, message: "CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET not provided" });
    return;
  }
  try {
    await operation();
    results.push({ status: "PASS", name });
  } catch (error) {
    results.push({ status: "FAIL", name, message: error instanceof Error ? error.message : String(error) });
  }
}

async function verifyAccessProtection() {
  const response = await fetch(dashboardBase, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (!isAccessProtectedResponse(response.status, response.headers.get("location") || "")) {
    throw new Error(`expected an Access redirect or rejection, received HTTP ${response.status}`);
  }
}

async function verifyWorkerHealth() {
  const response = await fetch(`${settings.statusWorkerUrl}/healthz`, { signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) throw new Error(`health endpoint returned HTTP ${response.status}`);
}

async function verifyCronTrigger() {
  const schedules = await cloudflareApi(settings, `/accounts/${settings.accountId}/workers/scripts/${workerName}/schedules`);
  if (!hasCronSchedule(schedules, "*/5 * * * *")) throw new Error("five-minute schedule was not found");
}

async function verifyStatusAndMesh() {
  const { response, payload } = await fetchStatus();
  if (!response.ok) throw new Error(`status API returned HTTP ${response.status}`);
  const errors = validateStatusPayload(payload, expectedHosts);
  if (errors.length) throw new Error(errors.join("; "));
  if (!/no-store/i.test(response.headers.get("cache-control") || "")) throw new Error("status API is missing Cache-Control: no-store");
}

async function verifyMetricsPersistence() {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let lastError = "no D1 metric samples were returned";
  while (Date.now() < deadline) {
    try {
      const endpoint = settings.statusApiToken
        ? `${settings.statusWorkerUrl}/api/metrics?range=1h`
        : `${dashboardBase}api/metrics?range=1h`;
      const response = await fetch(endpoint, { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.data) && payload.data.length > 0) return;
      lastError = `metrics endpoint returned HTTP ${response.status} with ${payload?.data?.length || 0} samples`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(5_000);
  }
  throw new Error(`${lastError} after ${timeoutSeconds}s`);
}

async function verifyPagesBinding() {
  const response = await fetch(`${dashboardBase}api/status`, { headers: accessHeaders(), signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Pages API returned HTTP ${response.status}`);
  const errors = validateStatusPayload(payload, expectedHosts);
  if (errors.length) throw new Error(errors.join("; "));
}

async function verifyPwa() {
  const [manifestResponse, workerResponse, offlineResponse] = await Promise.all([
    fetch(`${dashboardBase}manifest.webmanifest`, { headers: accessHeaders(), signal: AbortSignal.timeout(15_000) }),
    fetch(`${dashboardBase}sw.js`, { headers: accessHeaders(), signal: AbortSignal.timeout(15_000) }),
    fetch(`${dashboardBase}offline.html`, { headers: accessHeaders(), signal: AbortSignal.timeout(15_000) }),
  ]);
  if (![manifestResponse, workerResponse, offlineResponse].every((response) => response.ok)) throw new Error("one or more PWA assets are unavailable");
  const manifest = await manifestResponse.json();
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(errors.join("; "));
  const workerSource = await workerResponse.text();
  if (!workerSource.includes("CACHE_STATIC_ASSETS") || !workerSource.includes("/dashboard/api/")) throw new Error("deployed Service Worker lacks the expected cache/privacy contract");
  if (!(await offlineResponse.text()).includes("当前处于离线状态")) throw new Error("offline page content is incorrect");
}

async function fetchStatus() {
  const endpoint = settings.statusApiToken ? `${settings.statusWorkerUrl}/api/status` : `${dashboardBase}api/status`;
  const response = await fetch(endpoint, { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
  return { response, payload: await response.json().catch(() => null) };
}

function authHeaders() {
  if (settings.statusApiToken) return { Authorization: `Bearer ${settings.statusApiToken}` };
  return accessHeaders();
}

function accessHeaders() {
  return {
    "CF-Access-Client-Id": settings.accessClientId,
    "CF-Access-Client-Secret": settings.accessClientSecret,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum);
}
