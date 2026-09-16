import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedServiceUrl, matchesServiceToken, normalizeRequestId } from "./security.mjs";

const current = "0123456789abcdef0123456789abcdef";
const previous = "fedcba9876543210fedcba9876543210";

test("service token comparison accepts current and staged previous tokens", () => {
  assert.equal(matchesServiceToken(current, current, previous), true);
  assert.equal(matchesServiceToken(previous, current, previous), true);
  assert.equal(matchesServiceToken("wrong", current, previous), false);
  assert.equal(matchesServiceToken("short", "short"), false);
});

test("service probes are constrained to private HTTP targets", () => {
  for (const url of [
    "http://127.0.0.1:8000/health",
    "http://10.0.0.2/health",
    "http://172.20.0.2/health",
    "http://192.168.1.2/health",
    "http://100.96.0.5/health",
    "http://trading-bot:8000/health",
    "http://[::1]:8000/health",
  ]) assert.equal(isAllowedServiceUrl(url), true, url);

  for (const url of [
    "https://127.0.0.1/health",
    "http://169.254.169.254/latest/meta-data",
    "http://8.8.8.8/",
    "http://example.com/",
    "file:///etc/passwd",
    "not-a-url",
  ]) assert.equal(isAllowedServiceUrl(url), false, url);
});

test("request IDs are bounded and sanitized", () => {
  assert.equal(normalizeRequestId("ray-123:edge"), "ray-123:edge");
  assert.match(normalizeRequestId("invalid request id with spaces"), /^[0-9a-f-]{36}$/);
});
