import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  parseVpsTargets,
  parseVpsServicesByTarget,
  parseWorkerDeploymentVersion,
  root,
  selectProductionPagesDeployment,
  validateSettings,
  validateVpsTargets,
} from "./shared.mjs";
import { createReleaseState, findOutputIdentifier, parseWranglerOutput, writeReleaseState } from "./release-state.mjs";
import { rollbackRelease } from "./rollback-operations.mjs";
import { hasCronSchedule, isAccessProtectedResponse, validateManifest, validateStatusPayload } from "./postdeploy-checks.mjs";

test("deployment settings reject malformed Cloudflare and verification configuration", () => {
  const result = validateSettings({
    accountId: "bad",
    apiToken: "short",
    teamDomain: "example.com",
    allowedEmails: ["bad"],
    dashboardHost: "dashboard.example.com",
    databaseName: "monitoring",
    pagesProjectName: "site",
    statusWorkerUrl: "https://worker.example.com",
    telegramBotToken: "",
    telegramChatId: "",
    statusApiToken: "",
    statusServiceToken: "",
    statusServiceTokenPrevious: "",
    accessClientId: "",
    accessClientSecret: "",
    vpsTargets: [],
  }, { requireCloudflare: true });
  assert.ok(result.errors.some((error) => error.includes("CLOUDFLARE_ACCOUNT_ID")));
  assert.ok(result.errors.some((error) => error.includes("post-deploy verification")));
});

test("configurable VPS targets are parsed and validated", () => {
  const targets = parseVpsTargets(JSON.stringify([
    { name: "a", sshHost: "one.example.com", sshPort: 22, meshHost: "100.96.0.5" },
    { name: "b", sshHost: "two.example.com", sshPort: 21903, meshHost: "100.96.0.1" },
    { name: "c", sshHost: "three.example.com", sshPort: 22, meshHost: "100.96.0.3" },
  ]));
  assert.deepEqual(validateVpsTargets(targets).errors, []);
  assert.equal(targets[1].sshPort, 21903);
  const fourth = parseVpsTargets(JSON.stringify([
    { name: "a", sshHost: "one.example.com", sshPort: 22, meshHost: "100.96.0.5" },
    { name: "b", sshHost: "two.example.com", sshPort: 22, meshHost: "100.96.0.1" },
    { name: "c", sshHost: "three.example.com", sshPort: 22, meshHost: "100.96.0.3" },
    { name: "d", sshHost: "four.example.com", sshPort: 22, meshHost: "100.96.0.7", identityFile: "/tmp/fourth-vps.key" },
  ]));
  assert.deepEqual(validateVpsTargets(fourth).errors, []);
  assert.equal(fourth[3].identityFile, "/tmp/fourth-vps.key");
});

test("per-target VPS service lists are parsed independently", () => {
  const services = parseVpsServicesByTarget(JSON.stringify({
    "ml-vps": [{ name: "n8n", url: "http://127.0.0.1:5678/" }],
    "vps-23": [{ name: "Memos", url: "http://127.0.0.1:5230/" }],
  }));
  assert.equal(services["ml-vps"][0].name, "n8n");
  assert.equal(services["vps-23"][0].name, "Memos");
  assert.throws(() => parseVpsServicesByTarget('{"ml-vps":{}}'), /must be an array/);
});

test("Cloudflare deployment identifiers are extracted from stable and fallback shapes", () => {
  assert.equal(parseWorkerDeploymentVersion([{ versions: [{ version_id: "worker-v1", percentage: 100 }] }]), "worker-v1");
  assert.equal(parseWorkerDeploymentVersion({ versions: [{ version_id: "worker-active", percentage: 100 }] }), "worker-active");
  assert.equal(parseWorkerDeploymentVersion({ deployments: [{ active: true, version_id: "worker-v2" }] }), "worker-v2");
  const pages = selectProductionPagesDeployment([
    { id: "preview", environment: "preview", latest_stage: { status: "success" } },
    { id: "production", environment: "production", latest_stage: { status: "success" }, is_skipped: false },
  ]);
  assert.equal(pages.id, "production");
  const events = parseWranglerOutput('{"type":"wrangler-session"}\n{"type":"deploy","version_id":"new-v1"}\n');
  assert.equal(findOutputIdentifier(events, "deploy", ["version_id"]), "new-v1");
});

test("release state rejects any token or credential field", () => {
  const state = createReleaseState({ dashboardHost: "dashboard.example.com", pagesProjectName: "site", databaseName: "monitoring" });
  state.nested = { statusServiceTokenPrevious: "must-never-be-written" };
  assert.throws(() => writeReleaseState(state, join(tmpdir(), `dcc-unsafe-state-${crypto.randomUUID()}.json`)), /must not contain secret field/);
});

test("rollback restores Pages before Worker and records both actions", async () => {
  const calls = [];
  const state = {
    schemaVersion: 1,
    releaseId: "release-1",
    status: "failed",
    pagesProjectName: "site",
    workerName: "worker",
    previous: { pagesDeploymentId: "pages-old", workerVersionId: "worker-old" },
    changes: { pages: true, worker: true, accessCreated: false },
    rollback: { attempted: false, completed: false, actions: [], errors: [] },
    phases: [],
  };
  const result = await rollbackRelease({ accountId: "account" }, state, {
    cloudflareApi: async (_settings, path, options) => { calls.push(["api", path, options.method]); return {}; },
    runWrangler: (args) => calls.push(["wrangler", ...args]),
    writeState: () => {},
  });
  assert.equal(result.completed, true);
  assert.equal(result.actions.length, 2);
  assert.match(calls[0][1], /pages-old\/rollback$/);
  assert.deepEqual(calls[1].slice(0, 3), ["wrangler", "rollback", "worker-old"]);
});

test("rollback reports an incomplete initial release when no prior targets exist", async () => {
  const state = {
    schemaVersion: 1,
    releaseId: "initial-release",
    status: "failed",
    pagesProjectName: "site",
    workerName: "worker",
    previous: { pagesDeploymentId: null, workerVersionId: null },
    changes: { pages: true, worker: true, vps: false, accessCreated: false },
    rollback: { attempted: false, completed: false, actions: [], errors: [] },
    phases: [],
  };
  const result = await rollbackRelease({ accountId: "account" }, state, { writeState: () => {} });
  assert.equal(result.completed, false);
  assert.equal(result.actions.filter((action) => action.status === "unavailable").length, 2);
  assert.equal(result.errors.length, 2);
});

test("post-deploy payload checks enforce Access, Mesh health, and PWA identity", () => {
  assert.equal(isAccessProtectedResponse(302, "https://team.cloudflareaccess.com/cdn-cgi/access/login"), true);
  assert.equal(isAccessProtectedResponse(200, ""), false);
  assert.equal(hasCronSchedule({ schedules: [{ cron: "*/5 * * * *" }] }, "*/5 * * * *"), true);
  assert.deepEqual(validateStatusPayload({
    generatedAt: new Date().toISOString(),
    hosts: [
      { host: "100.96.0.5", reachable: true },
      { host: "100.96.0.1", reachable: true },
      { host: "100.96.0.3", reachable: true },
    ],
  }, ["100.96.0.5", "100.96.0.1", "100.96.0.3"]), []);
  assert.deepEqual(validateStatusPayload({
    generatedAt: new Date().toISOString(),
    hosts: [
      { host: "100.96.0.5", reachable: true },
      { host: "100.96.0.1", reachable: true },
      { host: "100.96.0.3", reachable: true },
      { host: "100.96.0.7", reachable: true },
    ],
  }, ["100.96.0.5", "100.96.0.1", "100.96.0.3", "100.96.0.7"]), []);
  assert.deepEqual(validateManifest({ id: "/dashboard/", scope: "/dashboard/", icons: [{ purpose: "maskable" }] }), []);
});

test("VPS installer is idempotent and supports upgrade plus rollback", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dcc-vps-test-"));
  try {
    const isolatedRoot = join(temporary, "root");
    const sourceOne = join(temporary, "source-one");
    const sourceTwo = join(temporary, "source-two");
    const bin = join(temporary, "bin");
    mkdirSync(bin, { recursive: true });
    cpSync(join(root, "status-api"), sourceOne, { recursive: true });
    cpSync(sourceOne, sourceTwo, { recursive: true });
    writeFileSync(join(sourceTwo, "server.mjs"), `${readFileSync(join(sourceTwo, "server.mjs"), "utf8")}\n// upgraded release\n`);
    writeFileSync(
      join(sourceTwo, "developer-control-center-status.service"),
      readFileSync(join(sourceTwo, "developer-control-center-status.service"), "utf8")
        .replace("Description=Developer Control Center read-only status API", "Description=Developer Control Center upgraded status API"),
    );
    const environment = join(temporary, "status-api.env");
    const environmentTwo = join(temporary, "status-api-v2.env");
    writeFileSync(environment, "STATUS_API_PORT=18787\nCONTROL_API_PORT=18788\nSTATUS_SERVICE_TOKEN=0123456789abcdef0123456789abcdef\nVPS_CONTROL_TOKEN=abcdef0123456789abcdef0123456789\nSTATUS_SERVICES_JSON=[]\nVPS_CONTROL_ACTIONS_JSON=[]\n", { mode: 0o600 });
    writeFileSync(environmentTwo, "STATUS_API_PORT=18787\nCONTROL_API_PORT=18788\nSTATUS_SERVICE_TOKEN=fedcba9876543210fedcba9876543210\nVPS_CONTROL_TOKEN=abcdef0123456789abcdef0123456789\nSTATUS_SERVICES_JSON=[]\nVPS_CONTROL_ACTIONS_JSON=[]\n", { mode: 0o600 });
    const systemctl = join(bin, "systemctl");
    const curl = join(bin, "curl");
    writeFileSync(systemctl, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(curl, "#!/usr/bin/env bash\nprintf '{\"ok\":true}'\n", { mode: 0o755 });
    const script = join(root, "scripts", "vps-status-api.sh");
    const env = { ...process.env, DCC_ROOT_PREFIX: isolatedRoot, DCC_SYSTEMCTL: systemctl, DCC_CURL: curl };

    runVps(script, ["install", "--source", sourceOne, "--env-source", environment], env);
    const releases = join(isolatedRoot, "opt", "developer-control-center", "releases");
    assert.equal(readdirSync(releases).length, 1);
    const first = readlinkSync(join(isolatedRoot, "opt", "developer-control-center", "status-api"));
    assert.equal(existsSync(join(first, "system-info.mjs")), true);
    assert.equal(existsSync(join(first, "control-server.mjs")), true);

    runVps(script, ["upgrade", "--source", sourceOne, "--env-source", environment], env);
    assert.equal(readdirSync(releases).length, 1);
    assert.equal(basename(readlinkSync(join(isolatedRoot, "opt", "developer-control-center", "status-api"))), basename(first));

    runVps(script, ["upgrade", "--source", sourceTwo, "--env-source", environmentTwo], env);
    assert.equal(readdirSync(releases).length, 2);
    const upgraded = readlinkSync(join(isolatedRoot, "opt", "developer-control-center", "status-api"));
    assert.notEqual(upgraded, first);
    assert.match(readFileSync(join(isolatedRoot, "etc", "developer-control-center", "status-api.env"), "utf8"), /fedcba9876543210/);
    assert.match(readFileSync(join(isolatedRoot, "etc", "systemd", "system", "developer-control-center-status.service"), "utf8"), /upgraded status API/);

    runVps(script, ["rollback"], env);
    assert.equal(basename(readlinkSync(join(isolatedRoot, "opt", "developer-control-center", "status-api"))), basename(first));
    assert.match(readFileSync(join(isolatedRoot, "etc", "developer-control-center", "status-api.env"), "utf8"), /0123456789abcdef/);
    assert.doesNotMatch(readFileSync(join(isolatedRoot, "etc", "systemd", "system", "developer-control-center-status.service"), "utf8"), /upgraded status API/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function runVps(script, args, env) {
  execFileSync("bash", [script, ...args], { env, stdio: "pipe" });
}
