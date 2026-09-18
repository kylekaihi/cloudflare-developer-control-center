import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "./[[path]].js";

test("proxies an Access-authenticated same-origin request through the service binding", async () => {
  const response = await onRequest({
    request: new Request("https://dashboard.example.com/dashboard/api/metrics?range=24h", {
      headers: { "Cf-Access-Jwt-Assertion": "signed-access-token" },
    }),
    params: { path: ["metrics"] },
    env: {
      STATUS_WORKER: {
        async fetch(request) {
          assert.equal(request.url, "https://developer-control-center-status.internal/api/metrics?range=24h");
          assert.equal(request.headers.get("Cf-Access-Jwt-Assertion"), "signed-access-token");
          return Response.json({ range: "24h", data: [] }, { headers: { "X-Request-ID": "test-request" } });
        },
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Request-ID"), "test-request");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.match(response.headers.get("Server-Timing"), /^pages;dur=/);
  assert.equal((await response.json()).range, "24h");
});

test("rejects resources outside the read-only allowlist", async () => {
  const response = await onRequest({
    request: new Request("https://dashboard.example.com/dashboard/api/admin"),
    params: { path: ["admin"] },
    env: {},
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("proxies service detail queries through the additive allowlist", async () => {
  const response = await onRequest({
    request: new Request("https://dashboard.example.com/dashboard/api/services?host=100.96.0.12&name=Bot&range=7d"),
    params: { path: ["services"] },
    env: { STATUS_WORKER: { fetch: async (request) => Response.json({ upstream: request.url }) } },
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).upstream, /\/api\/services\?/);
});

test("proxies only explicit control methods and preserves the Access assertion", async () => {
  const response = await onRequest({
    request: new Request("https://dashboard.example.com/dashboard/api/controls", { method: "POST", headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": "access-jwt" }, body: JSON.stringify({ action: "logs" }) }),
    params: { path: ["controls"] },
    env: { STATUS_WORKER: { fetch: async (request) => { assert.equal(request.method, "POST"); assert.equal(request.headers.get("Cf-Access-Jwt-Assertion"), "access-jwt"); return Response.json({ ok: true }); } } },
  });
  assert.equal(response.status, 200);
});

test("preserves CSV response metadata", async () => {
  const response = await onRequest({
    request: new Request("https://dashboard.example.com/dashboard/api/events?format=csv"),
    params: { path: ["events"] },
    env: { STATUS_WORKER: { fetch: async () => new Response('"type"\n', { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="events.csv"' } }) } },
  });
  assert.match(response.headers.get("Content-Type"), /text\/csv/);
  assert.match(response.headers.get("Content-Disposition"), /events\.csv/);
});

test("proxies maintenance window reads and writes", async () => {
  const methods = [];
  const response = await onRequest({
    request: new Request("https://dashboard.example.com/dashboard/api/maintenance", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": "access-jwt", "Content-Type": "application/json" }, body: JSON.stringify({ reason: "Deploying" }) }),
    params: { path: ["maintenance"] },
    env: { STATUS_WORKER: { fetch: async (request) => { methods.push(request.method); return Response.json({ ok: true }); } } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(methods, ["POST"]);
});
