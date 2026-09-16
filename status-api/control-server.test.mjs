import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("control agent restricts services, redacts logs, and requires exact restart confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dcc-control-"));
  const docker = join(directory, "docker");
  writeFileSync(docker, "#!/usr/bin/env bash\nif [[ \"$1\" == logs ]]; then echo 'password=secret-value ready'; exit 0; fi\nif [[ \"$1\" == restart ]]; then echo \"$4\"; exit 0; fi\nexit 2\n", { mode: 0o755 });
  const port = 21000 + Math.floor(Math.random() * 1000);
  const token = "control-token-0123456789abcdef0123456789";
  const child = spawn(process.execPath, [join(import.meta.dirname, "control-server.mjs")], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CONTROL_API_PORT: String(port), VPS_CONTROL_TOKEN: token, VPS_CONTROL_ACTIONS_JSON: JSON.stringify([{ name: "Safe App", container: "safe-app", canRestart: true, canReadLogs: true }]) }, stdio: "ignore" });
  try {
    await waitForHealth(port);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/control`);
    assert.equal(unauthorized.status, 401);
    const logs = await call(port, token, { action: "logs", name: "Safe App" });
    assert.equal(logs.status, 200);
    assert.match((await logs.json()).logs, /password=\[redacted\]/);
    const rejected = await call(port, token, { action: "restart", name: "Safe App", confirmation: "wrong" });
    assert.equal(rejected.status, 422);
    const unknown = await call(port, token, { action: "restart", name: "Freqtrade", confirmation: "Freqtrade" });
    assert.equal(unknown.status, 422);
  } finally {
    child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
});

function call(port, token, body) {
  return fetch(`http://127.0.0.1:${port}/api/control`, { method: "POST", headers: { "Content-Type": "application/json", "X-Control-Token": token }, body: JSON.stringify(body) });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/healthz`); if (response.ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("control server did not start");
}
