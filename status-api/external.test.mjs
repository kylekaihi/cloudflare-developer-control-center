import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedExternalUrl,
  normalizeExternalCheck,
  probeExternalCheck,
  readExternalChecks,
  summarizeCertificate,
} from "./external.mjs";

test("accepts bounded public external checks and rejects internal targets", () => {
  const checks = readExternalChecks(JSON.stringify([
    { id: "public-api", name: "Public API", url: "https://example.com/health", expectedStatus: 204, timeoutMs: 5000, tlsWarningDays: 30, tlsCriticalDays: 7 },
    { id: "private", name: "Private", url: "http://127.0.0.1:8080/health" },
  ]));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].expectedStatus, 204);
  assert.equal(checks[0].timeoutMs, 5000);
  assert.equal(isAllowedExternalUrl("https://example.com"), true);
  assert.equal(isAllowedExternalUrl("https://user:pass@example.com"), false);
  assert.equal(isAllowedExternalUrl("http://192.168.1.5"), false);
});

test("reports HTTP status and latency failures", async () => {
  const check = normalizeExternalCheck({ id: "status", name: "Status page", url: "http://example.com/status", expectedStatus: 200 });
  const result = await probeExternalCheck(check, {
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
    now: 1_000,
  });
  assert.equal(result.status, "down");
  assert.equal(result.httpStatus, 503);
  assert.equal(result.alerts[0].code, "external_down");
  assert.match(result.alerts[0].message, /503/);
});

test("reports HTTPS certificate expiry thresholds separately from HTTP health", async () => {
  const now = Date.parse("2026-09-19T00:00:00.000Z");
  const check = normalizeExternalCheck({ id: "tls", name: "TLS site", url: "https://example.com", tlsWarningDays: 30, tlsCriticalDays: 7 });
  const result = await probeExternalCheck(check, {
    fetchImpl: async () => new Response("ok", { status: 200 }),
    tlsProbe: async () => ({ expiresAt: new Date(now + 5 * 86_400_000).toISOString(), daysRemaining: 5 }),
    now,
  });
  assert.equal(result.status, "up");
  assert.equal(result.tls.daysRemaining, 5);
  assert.equal(result.alerts[0].code, "tls_expiring");
  assert.equal(result.alerts[0].severity, "critical");
});

test("converts certificate validity into bounded days remaining", () => {
  const now = Date.parse("2026-09-19T00:00:00.000Z");
  const result = summarizeCertificate({ valid_to: "Sep 29 00:00:00 2026 GMT" }, now);
  assert.equal(result.daysRemaining, 10);
  assert.equal(result.expiresAt, "2026-09-29T00:00:00.000Z");
  assert.deepEqual(summarizeCertificate({}, now), { expiresAt: null, daysRemaining: null });
});
