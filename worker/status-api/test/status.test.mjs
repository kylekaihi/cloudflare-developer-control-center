import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import worker, { deriveAlertConditions } from "../src/index.js";
import { hasValidAccessIdentity } from "../src/access-auth.js";
import { persistSnapshot, planIncidentTransitions } from "../src/persistence.js";
import { incidentServiceName, matchesMaintenanceWindow, normalizeMaintenanceWindow } from "../src/maintenance.js";
import { formatTelegramMessage } from "../src/notifications.js";

function makeDb() {
  return {
    prepare(sql) {
      return {
        bindings: [],
        bind(...values) { this.bindings = values; return this; },
        async all() {
          if (sql.includes("FROM metric_samples")) {
            return { results: [{ captured_at: 1786536000000, cpu_percent: 12, memory_percent: 41, disk_percent: 35, reachable_samples: 1, sample_count: 1 }] };
          }
          if (sql.includes("FROM incidents")) {
            return { results: [{ alert_key: "100.96.0.12|cpu_high", host: "100.96.0.12", code: "cpu_high", severity: "warning", message: "CPU usage is high", status: "open", consecutive_count: 4, first_seen_at: 1786535820000, last_seen_at: 1786536000000, opened_at: 1786536000000, resolved_at: null }] };
          }
          if (sql.includes("FROM service_samples")) {
            return { results: [{ captured_at: 1786536000000, host: "100.96.0.12", name: "Polymarket Bot", availability_percent: 99.5, latency_ms: 24, sample_count: 20, first_observed_at: 1786534860000, last_observed_at: 1786536000000 }] };
          }
          if (sql.includes("FROM event_log")) {
            return { results: [{ id: 1, occurred_at: 1786536000000, type: "incident_opened", severity: "warning", host: "100.96.0.12", service_name: null, title: "CPU usage is high", detail: "cpu_high" }] };
          }
          return { results: [] };
        },
        async first() { return { availability_percent: 99.5, latency_ms: 24, sample_count: 20, first_observed_at: 1786534860000, last_observed_at: 1786536000000 }; },
      };
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    STATUS_API_TOKEN: "public-token",
    STATUS_SERVICE_TOKEN: "private-token",
    STATUS_SERVICE_HOST: "100.96.0.12",
    STATUS_SERVICE_PORT: "8787",
    ALLOWED_ORIGINS: "https://dashboard.example.com",
    DB: makeDb(),
    MESH: {
      async fetch(url, init) {
        assert.equal(url, "http://100.96.0.12:8787/api/status");
        assert.equal(init.headers["X-Status-API-Token"], "private-token");
        return new Response(JSON.stringify({
          generatedAt: "2026-08-12T12:00:00.000Z",
          version: "abc123",
          system: { cpuPercent: 12.4, memoryPercent: 41, diskPercent: 35, uptimeSeconds: 3600, loadAverages: [0.1, 0.2, 0.3], memoryBytes: { total: 1024, used: 512, free: 512 } },
          node: { hostname: "vps-one", platform: "linux", kernelRelease: "6.8.0", architecture: "x64", distribution: "Ubuntu 24.04", cpu: { model: "Test CPU", logicalCores: 2 }, storage: [{ filesystem: "/dev/vda1", mount: "/", totalBytes: 1000, usedBytes: 500, availableBytes: 500, usedPercent: 50 }], network: [{ name: "CloudflareWARP", address: "100.96.0.12", family: "IPv4", cidr: "100.96.0.12/32" }] },
          history: [{ generatedAt: "2026-08-12T11:59:00.000Z", cpuPercent: 10, memoryPercent: 40, diskPercent: 35 }],
          services: [{ name: "Polymarket Bot", status: "up", version: "v1", source: "docker", detail: "Up 2 hours", uptimeSeconds: 120 }],
          pnlSummary: { pnl: 12.5, positions: 2, exposure: 80, balance: 1000 },
          deployment: { version: "release-1", deployedAt: "2026-08-12T10:00:00.000Z" },
          alerts: [{ severity: "warning", code: "cpu_high", message: "CPU usage is high", createdAt: "2026-08-12T12:00:00.000Z" }],
          docker: [{ name: "Polymarket Bot", status: "up", source: "docker", version: "v1" }],
          externalChecks: [{ id: "public-api", name: "Public API", url: "https://example.com/health", status: "up", httpStatus: 200, latencyMs: 84, tls: { expiresAt: "2026-10-01T00:00:00.000Z", daysRemaining: 12 }, alerts: [{ code: "tls_expiring", severity: "warning", message: "TLS certificate expires in 12 days" }] }],
        }), { headers: { "Content-Type": "application/json" } });
      },
    },
    ...overrides,
  };
}

const ctx = { waitUntil(promise) { return promise; } };

test("requires the read-only public token", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/status"), makeEnv(), ctx);
  assert.equal(response.status, 401);
});

test("reads and filters status through the Mesh binding", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/status", {
    headers: {
      Authorization: "Bearer public-token",
      Origin: "https://dashboard.example.com",
    },
  }), makeEnv(), ctx);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version, "abc123");
  assert.equal(body.services[0].name, "Polymarket Bot");
  assert.equal(body.services[0].status, "up");
  assert.equal(body.services[0].source, "docker");
  assert.equal(body.hosts[0].status.node.hostname, "vps-one");
  assert.equal(body.hosts[0].status.node.network[0].address, "100.96.0.12");
  assert.equal(body.services[0].host, "100.96.0.12");
  assert.equal(body.pnlSummary.pnl, 12.5);
  assert.equal(body.deployments[0].version, "release-1");
  assert.equal(body.alerts[0].host, "100.96.0.12");
  assert.equal(body.docker[0].host, "100.96.0.12");
  assert.equal(body.externalChecks[0].name, "Public API");
  assert.equal(body.externalChecks[0].sourceHost, "100.96.0.12");
  assert.equal(body.hosts[0].status.externalChecks[0].alerts[0].code, "tls_expiring");
  assert.equal(body.history.length, 1);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://dashboard.example.com");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.match(response.headers.get("Server-Timing"), /^worker;dur=/);
});

test("exposes persistent metrics through the additive metrics endpoint", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/metrics?range=24h", {
    headers: { Authorization: "Bearer public-token" },
  }), makeEnv(), ctx);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.range, "24h");
  assert.equal(body.data[0].cpuPercent, 12);
});

test("exports bounded metric history as CSV", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/metrics?range=24h&format=csv", { headers: { Authorization: "Bearer public-token" } }), makeEnv(), ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/csv/);
  assert.match(await response.text(), /generatedAt.*cpuPercent/);
});

test("exposes service availability and event timeline endpoints", async () => {
  const services = await worker.fetch(new Request("https://status.example.com/api/services?range=7d", { headers: { Authorization: "Bearer public-token" } }), makeEnv(), ctx);
  const serviceBody = await services.json();
  assert.equal(services.status, 200);
  assert.equal(serviceBody.data[0].availabilityPercent, 99.5);
  assert.equal(serviceBody.data[0].sampleCount, 20);
  assert.equal(serviceBody.data[0].coverageSeconds, 1140);
  assert.equal(serviceBody.requestedWindowSeconds, 604800);
  const events = await worker.fetch(new Request("https://status.example.com/api/events", { headers: { Authorization: "Bearer public-token" } }), makeEnv(), ctx);
  const eventBody = await events.json();
  assert.equal(events.status, 200);
  assert.equal(eventBody.data[0].type, "incident_opened");
});

test("exposes optional Web Push configuration without disclosing private keys", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/push", { headers: { Authorization: "Bearer public-token" } }), makeEnv({ VAPID_PUBLIC_KEY: "public-vapid", VAPID_PRIVATE_KEY: "private-vapid" }), ctx);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.publicKey, "public-vapid");
  assert.equal(JSON.stringify(body).includes("private-vapid"), false);
});

test("lists active maintenance windows with the read-only token", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/maintenance", { headers: { Authorization: "Bearer public-token" } }), makeEnv(), ctx);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data, []);
});

test("requires a Cloudflare Access identity for maintenance writes", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/maintenance", { method: "POST", headers: { Authorization: "Bearer public-token", "Content-Type": "application/json" }, body: JSON.stringify({ reason: "Deploying" }) }), makeEnv(), ctx);
  assert.equal(response.status, 403);
});

test("never permits VPS controls through the diagnostic bearer token", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/controls", { headers: { Authorization: "Bearer public-token" } }), makeEnv({ VPS_CONTROL_CATALOG: "[]" }), ctx);
  assert.equal(response.status, 403);
});

test("opens once after the confirmation window and resolves once", () => {
  const base = 1_000_000;
  const condition = { alertKey: "host|disk_high", host: "host", code: "disk_high", severity: "warning", message: "Disk high" };
  const pending = [{ ...condition, status: "pending", consecutiveCount: 3, firstSeenAt: base, lastSeenAt: base + 120_000, openedAt: null, resolvedAt: null }];
  const opened = planIncidentTransitions(pending, [condition], base + 180_000, 180_000);
  assert.equal(opened.upserts[0].status, "open");
  assert.equal(opened.notifications[0].type, "opened");
  const resolved = planIncidentTransitions(opened.upserts, [], base + 240_000, 180_000);
  assert.equal(resolved.upserts[0].status, "resolved");
  assert.equal(resolved.notifications[0].type, "resolved");
});

test("normalizes scoped maintenance windows and matches active ranges", () => {
  const base = 1_786_536_000_000;
  const window = normalizeMaintenanceWindow({ host: "100.96.0.12", serviceName: "Polymarket Bot", startsAt: base, endsAt: base + 60_000, reason: "Deploying" }, { now: base, actor: "ops@example.com", id: "mw-test-001" });
  assert.equal(window.host, "100.96.0.12");
  assert.equal(matchesMaintenanceWindow(window, "100.96.0.12", "Polymarket Bot", base + 30_000), true);
  assert.equal(matchesMaintenanceWindow(window, "100.96.0.13", "Polymarket Bot", base + 30_000), false);
  assert.equal(matchesMaintenanceWindow(window, "100.96.0.12", "Polymarket Bot", base + 60_000), false);
  assert.throws(() => normalizeMaintenanceWindow({ startsAt: base, endsAt: base + 31 * 24 * 60 * 60 * 1_000, reason: "Too long" }, { now: base, id: "mw-test-002" }), /30 days/);
});

test("suppresses new and existing incidents during maintenance", () => {
  const base = 1_000_000;
  const condition = { alertKey: "host|service_down|Bot is unavailable", host: "host", code: "service_down", severity: "critical", message: "Bot is unavailable" };
  const window = { host: "host", serviceName: "Bot", startsAt: base, endsAt: base + 600_000 };
  const suppressed = (item) => matchesMaintenanceWindow(window, item.host, incidentServiceName(item), base + 1_000);
  const fresh = planIncidentTransitions([], [condition], base + 1_000, 0, suppressed);
  assert.deepEqual(fresh.upserts, []);
  const existing = { ...condition, status: "open", consecutiveCount: 4, firstSeenAt: base - 10_000, lastSeenAt: base, openedAt: base, resolvedAt: null };
  const retained = planIncidentTransitions([existing], [condition], base + 1_000, 0, suppressed);
  assert.deepEqual(retained.upserts, []);
  assert.deepEqual(retained.notifications, []);
});

test("turns external check alerts into deduplicated incident conditions", () => {
  const conditions = deriveAlertConditions([
    { host: "100.96.0.12", reachable: true, status: { alerts: [], externalChecks: [{ id: "public-api", name: "Public API", alerts: [{ code: "tls_expiring", severity: "warning", message: "TLS expires soon" }] }] } },
    { host: "100.96.0.13", reachable: true, status: { alerts: [], externalChecks: [{ id: "public-api", name: "Public API", alerts: [{ code: "tls_expiring", severity: "warning", message: "TLS expires soon" }] }] } },
  ]);
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].alertKey, "external|public-api|tls_expiring");
  assert.equal(conditions[0].host, "external");
});

test("records a deployment event only when a node version changes", async () => {
  const statements = [];
  const db = {
    prepare(sql) { return { sql, values: [], bind(...values) { this.values = values; return this; }, async first() { return { version: "release-old" }; } }; },
    async batch(items) { statements.push(...items); },
  };
  await persistSnapshot(db, { hosts: [{ host: "100.96.0.12", reachable: true, status: { system: {}, services: [], deployment: { version: "release-new" } } }] }, 1_786_536_000_000);
  const event = statements.find((item) => item.sql.includes("deployment_changed"));
  assert.ok(event);
  assert.equal(event.values.includes("100.96.0.12|deployment|release-new"), true);
});

test("formats Telegram transition notifications", () => {
  const text = formatTelegramMessage("opened", { host: "100.96.0.5", severity: "critical", message: "VPS unavailable", openedAt: 1786536000000 });
  assert.match(text, /Developer Control Center/);
  assert.match(text, /100\.96\.0\.5/);
});

test("verifies a Cloudflare Access RS256 assertion", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://team.cloudflareaccess.com",
    aud: ["dashboard-audience"],
    exp: Math.floor(Date.now() / 1_000) + 300,
  })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  const assertion = `${header}.${payload}.${signature}`;
  const jwk = publicKey.export({ format: "jwk" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
  try {
    const valid = await hasValidAccessIdentity(new Request("https://status.example.com/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": assertion },
    }), { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "dashboard-audience" });
    assert.equal(valid, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns 503 when the VPS address is not configured", async () => {
  const response = await worker.fetch(new Request("https://status.example.com/api/status", {
    headers: { Authorization: "Bearer public-token" },
  }), makeEnv({ STATUS_SERVICE_HOST: "REPLACE_WITH_MESH_OR_PRIVATE_IP" }), ctx);
  assert.equal(response.status, 503);
});
