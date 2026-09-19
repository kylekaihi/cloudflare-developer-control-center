import { execFileSync } from "node:child_process";
import http from "node:http";
import { isAllowedServiceUrl, matchesServiceToken, normalizeRequestId } from "./security.mjs";
import { collectNodeInfo, collectSystemMetrics } from "./system-info.mjs";
import { collectAlerts, readAlertRules } from "./alerts.mjs";
import { dockerDiscoveryArgs, mergeServices } from "./discovery.mjs";
import { probeExternalCheck, readExternalChecks } from "./external.mjs";

const port = Number(process.env.STATUS_API_PORT || 8787);
const serviceToken = process.env.STATUS_SERVICE_TOKEN || "";
const previousServiceToken = process.env.STATUS_SERVICE_TOKEN_PREVIOUS || "";
const services = readJson(process.env.STATUS_SERVICES_JSON, []);
const pnlSummary = readJson(process.env.STATUS_PNL_SUMMARY_JSON, null);
const dockerDiscoveryEnabled = process.env.STATUS_ENABLE_DOCKER_DISCOVERY === "true";
const dockerDiscoveryMode = process.env.STATUS_DOCKER_DISCOVERY_MODE === "all" ? "all" : "running";
const serviceDiscoveryMode = process.env.STATUS_SERVICE_DISCOVERY_MODE === "replace" ? "replace" : "merge";
const alertRules = readAlertRules(process.env.STATUS_ALERT_RULES_JSON);
const externalChecks = readExternalChecks(process.env.STATUS_EXTERNAL_CHECKS_JSON);
const history = [];
const maxHistory = 60;

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now();
  const requestId = normalizeRequestId(request.headers["x-request-id"]);
  const pathname = new URL(request.url || "/", "http://status-api.internal").pathname;
  try {
    if (request.method === "GET" && pathname === "/healthz") {
      return sendJson(response, 200, { ok: true, service: "status-api" }, requestId);
    }

    if (request.method !== "GET" || pathname !== "/api/status") {
      return sendJson(response, 404, { error: "Not found" }, requestId);
    }

    if (!matchesServiceToken(request.headers["x-status-api-token"], serviceToken, previousServiceToken)) {
      return sendJson(response, 401, { error: "Unauthorized" }, requestId);
    }

    const system = collectSystemMetrics();
    const [configuredServices, checkedExternal] = await Promise.all([
      Promise.all(services.map(checkService)),
      Promise.all(externalChecks.map((check) => probeExternalCheck(check))),
    ]);
    const dockerServices = dockerDiscoveryEnabled ? collectDockerServices() : [];
    const monitoredServices = mergeServices(configuredServices, dockerServices, dockerDiscoveryEnabled ? serviceDiscoveryMode : "merge");
    const generatedAt = new Date().toISOString();
    recordHistory(generatedAt, system);
    return sendJson(response, 200, {
      generatedAt,
      version: process.env.STATUS_GIT_COMMIT || "unknown",
      system,
      node: collectNodeInfo(),
      history: history.slice(-maxHistory),
      services: monitoredServices,
      externalChecks: checkedExternal,
      pnlSummary,
      deployment: {
        version: process.env.STATUS_RELEASE || process.env.STATUS_GIT_COMMIT || "unknown",
        gitCommit: process.env.STATUS_GIT_COMMIT || "unknown",
        deployedAt: process.env.STATUS_DEPLOYED_AT || null,
        release: process.env.STATUS_RELEASE || null,
      },
      alerts: collectAlerts(system, monitoredServices, alertRules),
      docker: dockerServices,
    }, requestId);
  } catch (error) {
    logEvent("error", "http_request_failed", { requestId, method: request.method, path: pathname, errorCode: errorCode(error) });
    if (!response.headersSent) sendJson(response, 500, { error: "Internal error" }, requestId);
  } finally {
    logEvent(response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info", "http_request", {
      requestId,
      method: request.method,
      path: pathname,
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  logEvent("info", "service_started", { port, configuredServices: services.length, externalChecks: externalChecks.length, dockerDiscoveryEnabled, dockerDiscoveryMode, serviceDiscoveryMode });
});

async function checkService(service) {
  const name = String(service?.name || "Unnamed service");
  const url = String(service?.url || "");
  const startedAt = Date.now();

  if (!url) {
    return { name, status: "down", version: "unknown", error: "Missing URL" };
  }
  if (!isAllowedServiceUrl(url)) {
    return { name, status: "down", version: "unknown", error: "Service URL must target a private HTTP endpoint" };
  }

  try {
    const result = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    const body = await readJsonResponse(result);
    return {
      name,
      status: result.ok ? "up" : "down",
      source: "health-check",
      version: stringOr(body?.version, service.version || "unknown"),
      uptimeSeconds: numberOrNull(body?.uptimeSeconds),
      lastHeartbeat: stringOr(body?.lastHeartbeat, null),
      pnlSummary: body?.pnlSummary || null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name,
      status: "down",
      source: "health-check",
      version: service.version || "unknown",
      error: error instanceof Error ? error.message : "Health check failed",
      latencyMs: Date.now() - startedAt,
    };
  }
}

function collectDockerServices() {
  try {
    const output = execFileSync(
      "docker",
      dockerDiscoveryArgs(dockerDiscoveryMode),
      { encoding: "utf8", timeout: 2_500 },
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, state, image, detail] = line.split("\t");
        return {
          name: name || "Unnamed container",
          status: state === "running" ? "up" : "down",
          source: "docker",
          version: image || "unknown",
          detail: detail || state || "unknown",
          uptimeSeconds: null,
          lastHeartbeat: null,
        };
      });
  } catch {
    return [];
  }
}

function recordHistory(generatedAt, system) {
  history.push({ generatedAt, ...system });
  if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sendJson(response, status, body, requestId) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Request-ID": requestId,
  });
  response.end(JSON.stringify(body));
}

function logEvent(level, event, fields = {}) {
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  logger(JSON.stringify({ timestamp: new Date().toISOString(), level, event, service: "status-api", ...fields }));
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code.slice(0, 64) : "UNEXPECTED_ERROR";
}
