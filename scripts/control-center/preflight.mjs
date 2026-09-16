import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readJson,
  readSettings,
  root,
  runNpm,
  runWrangler,
  validateSettings,
  workerConfigPath,
} from "./shared.mjs";

const deployMode = process.argv.includes("--deploy");
const qualityMode = process.argv.includes("--quality");
const results = [];

await check("supported Node.js and Wrangler runtimes", checkRuntimeVersions);
await check("required release files", checkRequiredFiles);
await check("Worker bindings, hosts, port, and Cron", checkWorkerConfig);
await check("Pages service binding and Function routes", checkPagesConfig);
await check("PWA privacy and cache contract", checkPwaContract);
await check("ordered backward-compatible D1 migrations", checkMigrations);
await check("Status API service contract", checkStatusApi);
await check("deployment settings", () => checkSettings(deployMode));
await check("tracked secret exposure", checkTrackedSecrets);
await check("Wrangler status Worker dry run", checkWranglerDryRun);

if (qualityMode) {
  await check("runtime script syntax", () => runNpm(["run", "check:runtime"]));
  await check("site and PWA tests", () => runNpm(["test"]));
  await check("Worker and Pages Function tests", () => runNpm(["run", "test:worker"]));
  await check("production build", () => runNpm(["run", "build"]));
}

const failures = results.filter((item) => item.status === "FAIL");
const warnings = results.filter((item) => item.status === "WARN");
console.log("\nControl Center preflight");
for (const item of results) console.log(`${item.status === "PASS" ? "✓" : item.status === "WARN" ? "!" : "✗"} ${item.name}${item.message ? ` — ${item.message}` : ""}`);
console.log(`\n${results.length - failures.length - warnings.length} passed, ${warnings.length} warnings, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;

async function check(name, operation) {
  try {
    const outcome = await operation();
    if (outcome?.warnings?.length) {
      results.push({ status: "WARN", name, message: outcome.warnings.join("; ") });
    } else {
      results.push({ status: "PASS", name });
    }
  } catch (error) {
    results.push({ status: "FAIL", name, message: error instanceof Error ? error.message : String(error) });
  }
}

function checkRequiredFiles() {
  const required = [
    "src/pages/dashboard.astro",
    "functions/dashboard/api/[[path]].js",
    "public/_routes.json",
    "public/_headers",
    "public/dashboard/manifest.webmanifest",
    "public/dashboard/sw.js",
    "status-api/server.mjs",
    "status-api/control-server.mjs",
    "status-api/security.mjs",
    "status-api/developer-control-center-status.service",
    "status-api/developer-control-center-control.service",
    "worker/status-api/src/index.js",
    "worker/status-api/wrangler.jsonc",
    "worker/status-api/migrations/0001_monitoring.sql",
    "infra/pages.wrangler.jsonc",
  ];
  const missing = required.filter((path) => !readable(path));
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
}

function checkRuntimeVersions() {
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
    throw new Error(`Node.js 22.12 or newer is required; found ${process.versions.node}`);
  }
  const wranglerVersion = runWrangler(["--version"], { capture: true }).trim();
  const match = wranglerVersion.match(/(?:wrangler\s+)?(\d+)\./i);
  if (!match || Number(match[1]) < 4) throw new Error(`Wrangler 4 or newer is required; found ${wranglerVersion || "unknown"}`);
}

function checkWorkerConfig() {
  const config = readJson(workerConfigPath);
  const mesh = config.vpc_networks?.find((binding) => binding.binding === "MESH");
  if (!mesh?.network_id) throw new Error("MESH VPC binding is missing");
  if (!config.triggers?.crons?.includes("*/5 * * * *")) throw new Error("five-minute Cron Trigger is missing");
  const hosts = JSON.parse(config.vars?.STATUS_SERVICE_HOSTS || "[]");
  if (!Array.isArray(hosts) || hosts.length < 1 || new Set(hosts).size !== hosts.length) throw new Error("STATUS_SERVICE_HOSTS must contain at least one unique host");
  if (hosts.some((host) => !isPrivateIpv4(host))) throw new Error("STATUS_SERVICE_HOSTS must contain private IPv4 addresses");
  if (config.vars?.STATUS_SERVICE_PORT !== "18787") throw new Error("STATUS_SERVICE_PORT must be 18787");
  const origins = String(config.vars?.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length || origins.includes("*") || origins.some((origin) => {
    try { return new URL(origin).protocol !== "https:"; } catch { return true; }
  })) throw new Error("ALLOWED_ORIGINS must contain explicit HTTPS origins and cannot use a wildcard");
  const settings = readSettings();
  if (settings.vpsTargets.length) {
    const targetHosts = settings.vpsTargets.map((target) => target.meshHost).sort();
    if (JSON.stringify([...hosts].sort()) !== JSON.stringify(targetHosts)) throw new Error("VPS_DEPLOY_TARGETS meshHost values do not match STATUS_SERVICE_HOSTS");
  }
}

function checkPagesConfig() {
  const config = readJson(join(root, "infra", "pages.wrangler.jsonc"));
  const binding = config.services?.find((item) => item.binding === "STATUS_WORKER");
  if (binding?.service !== "developer-control-center-status") throw new Error("STATUS_WORKER service binding is missing or points to the wrong Worker");
  const routes = readJson(join(root, "public", "_routes.json"));
  if (!routes.include?.includes("/dashboard/api/*")) throw new Error("Pages Functions route does not include /dashboard/api/*");
}

function checkPwaContract() {
  const worker = text("public/dashboard/sw.js");
  const securityHeaders = text("public/_headers");
  const manifest = readJson(join(root, "public", "dashboard", "manifest.webmanifest"));
  if (!worker.includes('requestUrl.pathname.startsWith("/dashboard/api/")')) throw new Error("Service Worker lacks the network-only API branch");
  if (!worker.includes("CACHE_STATIC_ASSETS")) throw new Error("Service Worker does not cache hashed app-shell assets");
  if (manifest.scope !== "/dashboard/" || manifest.id !== "/dashboard/") throw new Error("PWA scope or id is incorrect");
  for (const header of ["Content-Security-Policy", "Strict-Transport-Security", "X-Frame-Options", "X-Content-Type-Options"]) {
    if (!securityHeaders.includes(header)) throw new Error(`Pages security headers are missing ${header}`);
  }
}

function checkMigrations() {
  const directory = join(root, "worker", "status-api", "migrations");
  const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
  if (!migrations.length) throw new Error("no D1 migrations found");
  const identifiers = migrations.map((file) => file.match(/^(\d+)_/)?.[1]).filter(Boolean);
  if (identifiers.length !== migrations.length || new Set(identifiers).size !== identifiers.length) throw new Error("migration files must have unique numeric prefixes");
  const forbidden = /\b(DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE|ALTER\s+TABLE[\s\S]{0,100}\bDROP\b)\b/i;
  for (const migration of migrations) {
    const sql = readFileSync(join(directory, migration), "utf8");
    if (forbidden.test(stripSqlComments(sql))) throw new Error(`${migration} contains a destructive statement; D1 rollback is not automatic`);
  }
  try {
    const sql = migrations.map((migration) => readFileSync(join(directory, migration), "utf8")).join("\n");
    execFileSync("sqlite3", [":memory:"], { input: sql, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    if (error?.code === "ENOENT") return { warnings: ["sqlite3 is unavailable; SQL syntax check skipped"] };
    throw new Error("D1 migration SQL did not execute in SQLite");
  }
}

function checkStatusApi() {
  const source = text("status-api/server.mjs");
  const unit = text("status-api/developer-control-center-status.service");
  const controlUnit = text("status-api/developer-control-center-control.service");
  for (const marker of ["/healthz", "/api/status", "X-Status-API-Token".toLowerCase()]) {
    if (!source.toLowerCase().includes(marker.toLowerCase())) throw new Error(`status-api is missing ${marker}`);
  }
  if (!unit.includes("EnvironmentFile=/etc/developer-control-center/status-api.env")) throw new Error("systemd unit does not use the protected environment file");
  if (!unit.includes("Restart=on-failure")) throw new Error("systemd restart policy is missing");
  if (!unit.includes("DynamicUser=yes") || !unit.includes("ProtectSystem=strict") || !unit.includes("CapabilityBoundingSet=")) {
    throw new Error("systemd sandboxing is incomplete");
  }
  if (!controlUnit.includes("NoNewPrivileges=true") || !controlUnit.includes("ProtectSystem=strict") || !controlUnit.includes("CapabilityBoundingSet=")) throw new Error("control agent systemd hardening is incomplete");
  if (!source.includes("matchesServiceToken") || !source.includes("isAllowedServiceUrl")) throw new Error("status-api authentication or SSRF guard is missing");
}

function checkSettings(requireCloudflare) {
  const settings = readSettings({ requireCloudflare });
  const result = validateSettings(settings, { requireCloudflare });
  if (result.errors.length) throw new Error(result.errors.join("; "));
  return { warnings: result.warnings };
}

function checkTrackedSecrets() {
  let files = [];
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
  } catch {
    return { warnings: ["Git tracked-file scan was skipped"] };
  }
  const secrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCESS_API_TOKEN", "STATUS_SERVICE_TOKEN", "STATUS_SERVICE_TOKEN_PREVIOUS", "OLD_STATUS_SERVICE_TOKEN", "NEW_STATUS_SERVICE_TOKEN", "STATUS_API_TOKEN", "TELEGRAM_BOT_TOKEN", "CF_ACCESS_CLIENT_SECRET"]
    .map((name) => [name, process.env[name]?.trim()])
    .filter(([, value]) => value && value.length >= 12);
  for (const file of files) {
    let content;
    try { content = readFileSync(join(root, file), "utf8"); } catch { continue; }
    for (const [name, value] of secrets) {
      if (content.includes(value)) throw new Error(`${name} value is present in tracked file ${file}`);
    }
  }
}

function checkWranglerDryRun() {
  runWrangler(["deploy", "--dry-run", "--config", "worker/status-api/wrangler.deploy.example.jsonc"]);
}

function readable(path) {
  try { readFileSync(join(root, path)); return true; } catch { return false; }
}

function text(path) {
  return readFileSync(join(root, path), "utf8");
}

function stripSqlComments(sql) {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function isPrivateIpv4(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [first, second] = parts.map(Number);
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}
