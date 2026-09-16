import { execFileSync, spawnSync } from "node:child_process";
import http from "node:http";
import { matchesServiceToken, normalizeRequestId } from "./security.mjs";

const port = Number(process.env.CONTROL_API_PORT || 18788);
const bindHost = process.env.CONTROL_BIND_HOST || "127.0.0.1";
const token = process.env.VPS_CONTROL_TOKEN || "";
const actions = normalizeActions(readJson(process.env.VPS_CONTROL_ACTIONS_JSON, []));

const handler = async (request, response) => {
  const requestId = normalizeRequestId(request.headers["x-request-id"]);
  const startedAt = Date.now();
  try {
    if (request.method === "GET" && request.url === "/healthz") return send(response, 200, { ok: true }, requestId);
    if (!matchesServiceToken(request.headers["x-control-token"], token)) return send(response, 401, { error: "Unauthorized" }, requestId);
    if (request.method === "GET" && request.url === "/api/control") return send(response, 200, { services: actions.map(({ name, canRestart, canReadLogs }) => ({ name, canRestart, canReadLogs })) }, requestId);
    if (request.method !== "POST" || request.url !== "/api/control") return send(response, 404, { error: "Not found" }, requestId);
    const body = await readBody(request);
    const configured = actions.find((item) => item.name === body?.name);
    if (!configured || !["logs", "restart"].includes(body?.action)) return send(response, 422, { error: "Action is not allowed" }, requestId);
    if (body.action === "logs" && configured.canReadLogs) {
      const lines = Math.max(10, Math.min(Number(body.lines) || 100, 300));
      const result = spawnSync("docker", ["logs", "--tail", String(lines), "--timestamps", configured.container], { encoding: "utf8", timeout: 5_000, maxBuffer: 512 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      if (result.error || result.status !== 0) throw result.error || Object.assign(new Error("docker logs failed"), { code: `DOCKER_${result.status}` });
      const output = `${result.stdout || ""}${result.stderr || ""}`;
      return send(response, 200, { ok: true, action: "logs", name: configured.name, logs: redact(output).slice(-256 * 1024) }, requestId);
    }
    if (body.action === "restart" && configured.canRestart && body.confirmation === configured.name) {
      execFileSync("docker", ["restart", "--time", "10", configured.container], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      return send(response, 200, { ok: true, action: "restart", name: configured.name }, requestId);
    }
    return send(response, 422, { error: "Confirmation does not match or action is disabled" }, requestId);
  } catch (error) {
    log("error", "control_action_failed", { requestId, errorCode: error?.code || "UNEXPECTED_ERROR" });
    return send(response, 500, { error: "Control action failed" }, requestId);
  } finally {
    log("info", "control_request", { requestId, method: request.method, path: request.url, status: response.statusCode, durationMs: Date.now() - startedAt });
  }
};

for (const host of new Set(["127.0.0.1", bindHost])) {
  http.createServer(handler).listen(port, host, () => log("info", "control_service_started", { host, port, configuredServices: actions.length }));
}

function normalizeActions(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item.name === "string" && /^[A-Za-z0-9._ -]{1,80}$/.test(item.name) && typeof item.container === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item.container)).map((item) => ({ name: item.name, container: item.container, canRestart: item.canRestart === true, canReadLogs: item.canReadLogs !== false }));
}

async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 16_384) throw Object.assign(new Error("Too large"), { code: "PAYLOAD_TOO_LARGE" }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

function redact(value) {
  return String(value || "").replace(/(token|secret|password|authorization)([=:]\s*)[^\s,;]+/gi, "$1$2[redacted]");
}

function readJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function send(response, status, body, requestId) { response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "X-Request-ID": requestId }); response.end(JSON.stringify(body)); }
function log(level, event, fields) { (level === "error" ? console.error : console.log)(JSON.stringify({ timestamp: new Date().toISOString(), level, event, service: "vps-control", ...fields })); }
