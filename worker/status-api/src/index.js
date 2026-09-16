import { hasValidAccessIdentity, readAccessIdentity } from "./access-auth.js";
import { deliverPendingNotifications } from "./notifications.js";
import {
  persistSnapshot,
  pruneOldData,
  readAvailabilitySummary,
  readEvents,
  readIncidents,
  readMetricHistory,
  readServiceHistory,
  savePushSubscription,
  deletePushSubscription,
  reconcileIncidents,
  beginControlAudit,
  completeControlAudit,
  readControlAudit,
} from "./persistence.js";

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RETRIES = 1;

export default {
  async fetch(request, env, ctx) {
    return handleInstrumentedRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCollection(event, env).catch((error) => {
      logEvent("error", "scheduled_collection_failed", {
        requestId: `cron-${event.scheduledTime || "unknown"}`,
        errorCode: readErrorCode(error),
      });
      throw error;
    }));
  },
};

async function handleInstrumentedRequest(request, env, ctx) {
  const startedAt = Date.now();
  const requestId = normalizeRequestId(request.headers.get("CF-Ray") || request.headers.get("X-Request-ID"));
  const pathname = normalizePath(new URL(request.url).pathname);
  try {
    const response = await handleRequest(request, env, requestId);
    const durationMs = Date.now() - startedAt;
    const headers = new Headers(response.headers);
    headers.set("X-Request-ID", requestId);
    headers.set("Server-Timing", `worker;dur=${durationMs}`);
    ctx.waitUntil(Promise.resolve().then(() => logEvent(
      response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
      "http_request",
      { requestId, method: request.method, path: pathname, status: response.status, durationMs },
    )));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logEvent("error", "http_request_failed", {
      requestId,
      method: request.method,
      path: pathname,
      durationMs,
      errorCode: readErrorCode(error),
    });
    return jsonResponse({ error: "Internal error", requestId }, 500, {
      "Cache-Control": "no-store",
      "Server-Timing": `worker;dur=${durationMs}`,
      "X-Request-ID": requestId,
    });
  }
}

async function handleRequest(request, env, requestId) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);
    if (pathname === "/healthz" && request.method === "GET") {
      return jsonResponse({ ok: true, service: "developer-control-center-status" }, 200, {
        ...headers,
        "X-Request-ID": requestId,
      });
    }

    const readRoutes = new Set(["/api/status", "/api/metrics", "/api/incidents", "/api/services", "/api/events", "/api/push", "/api/controls"]);
    const pushWrite = pathname === "/api/push" && ["POST", "DELETE"].includes(request.method);
    const controlWrite = pathname === "/api/controls" && request.method === "POST";
    if (!(request.method === "GET" && readRoutes.has(pathname)) && !pushWrite && !controlWrite) {
      return jsonResponse({ error: "Not found", requestId }, 404, headers);
    }

    if (!(await isAuthorized(request, env))) {
      return jsonResponse({ error: "Unauthorized", requestId }, 401, {
        ...headers,
        "WWW-Authenticate": "Bearer",
      });
    }

    if (!env.DB) {
      return jsonResponse({ error: "Monitoring database is not configured", requestId }, 503, headers);
    }

    if (pathname === "/api/controls") {
      const identity = await readAccessIdentity(request, env);
      if (!identity) return jsonResponse({ error: "Cloudflare Access identity required", requestId }, 403, headers);
      const catalog = readControlCatalog(env);
      if (request.method === "GET") {
        const audit = await readControlAudit(env.DB, url.searchParams.get("limit") || 50);
        return jsonResponse({ services: catalog, audit, requestId }, 200, headers);
      }
      const contentLength = Number(request.headers.get("Content-Length") || 0);
      if (contentLength > 16_384) return jsonResponse({ error: "Payload too large", requestId }, 413, headers);
      const body = await request.json().catch(() => null);
      const actionRequestId = normalizeActionRequestId(body?.requestId);
      const action = body?.action;
      const host = String(body?.host || "");
      const name = String(body?.name || "");
      const configured = catalog.find((item) => item.host === host && item.name === name);
      const permitted = configured && ((action === "logs" && configured.canReadLogs) || (action === "restart" && configured.canRestart));
      if (!actionRequestId || !permitted || (action === "restart" && body?.confirmation !== name)) return jsonResponse({ error: "Invalid or disallowed control action", requestId }, 422, headers);
      const startedAt = Date.now();
      const inserted = await beginControlAudit(env.DB, { requestId: actionRequestId, createdAt: startedAt, actor: identity.email || identity.subject || "access-user", host, name, action });
      if (!inserted) return jsonResponse({ error: "Duplicate action request", requestId }, 409, headers);
      try {
        const upstream = await env.MESH.fetch(`http://${host}:18788/api/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Control-Token": env.VPS_CONTROL_TOKEN || "", "X-Request-ID": actionRequestId },
          body: JSON.stringify({ action, name, confirmation: body?.confirmation, lines: body?.lines }),
          signal: AbortSignal.timeout(action === "restart" ? 35_000 : 8_000),
        });
        const result = await upstream.json().catch(() => ({}));
        await completeControlAudit(env.DB, actionRequestId, { status: upstream.ok ? "succeeded" : "failed", resultCode: upstream.ok ? "OK" : `HTTP_${upstream.status}`, durationMs: Date.now() - startedAt });
        return jsonResponse(upstream.ok ? { ...result, auditRequestId: actionRequestId, requestId } : { error: result.error || "Control action failed", auditRequestId: actionRequestId, requestId }, upstream.ok ? 200 : 502, headers);
      } catch (error) {
        await completeControlAudit(env.DB, actionRequestId, { status: "failed", resultCode: readErrorCode(error), durationMs: Date.now() - startedAt });
        return jsonResponse({ error: "Control service unavailable", auditRequestId: actionRequestId, requestId }, 503, headers);
      }
    }

    if (pathname === "/api/push") {
      if (request.method === "GET") return jsonResponse({ enabled: Boolean(env.VAPID_PUBLIC_KEY), publicKey: env.VAPID_PUBLIC_KEY || null, requestId }, 200, headers);
      const contentLength = Number(request.headers.get("Content-Length") || 0);
      if (contentLength > 16_384) return jsonResponse({ error: "Payload too large", requestId }, 413, headers);
      const body = await request.json().catch(() => null);
      if (request.method === "POST") {
        await savePushSubscription(env.DB, body?.subscription);
        return jsonResponse({ ok: true, requestId }, 201, headers);
      }
      await deletePushSubscription(env.DB, body?.endpoint);
      return jsonResponse({ ok: true, requestId }, 200, headers);
    }

    if (pathname === "/api/metrics") {
      const result = await readMetricHistory(env.DB, url.searchParams.get("range") || "1h", url.searchParams.get("host") || null);
      if (url.searchParams.get("format") === "csv") return csvResponse("metrics.csv", ["generatedAt", "cpuPercent", "memoryPercent", "diskPercent", "reachablePercent"], result.data, headers);
      return jsonResponse({ ...result, generatedAt: new Date().toISOString(), requestId }, 200, headers);
    }

    if (pathname === "/api/incidents") {
      const data = await readIncidents(env.DB, {
        status: url.searchParams.get("status") || "open",
        limit: url.searchParams.get("limit") || 100,
      });
      return jsonResponse({ data, generatedAt: new Date().toISOString(), requestId }, 200, headers);
    }

    if (pathname === "/api/events") {
      const data = await readEvents(env.DB, { limit: url.searchParams.get("limit") || 100, host: url.searchParams.get("host") || null, type: url.searchParams.get("type") || null, since: url.searchParams.get("since") || null });
      if (url.searchParams.get("format") === "csv") return csvResponse("events.csv", ["occurredAt", "type", "severity", "host", "serviceName", "title", "detail", "actor", "status"], data, headers);
      return jsonResponse({ data, generatedAt: new Date().toISOString(), requestId }, 200, headers);
    }

    if (pathname === "/api/services") {
      const host = url.searchParams.get("host");
      const name = url.searchParams.get("name");
      const range = url.searchParams.get("range") || "7d";
      const result = host && name
        ? await readServiceHistory(env.DB, { host, name, range })
        : await readAvailabilitySummary(env.DB, range);
      return jsonResponse({ ...result, generatedAt: new Date().toISOString(), requestId }, 200, headers);
    }

    if (readHosts(env).length === 0) {
      return jsonResponse({ error: "Status service is not configured", requestId }, 503, headers);
    }

    const upstreamStartedAt = Date.now();
    const snapshot = await collectSnapshot(env, requestId);
    if (snapshot.availableHosts === 0) {
      logEvent("error", "status_upstream_error", { requestId, hosts: snapshot.hosts.map((node) => node.host) });
      return jsonResponse({ error: "Status service unavailable", requestId }, 503, headers);
    }
    const [history, activeIncidents] = await Promise.all([
      readMetricHistory(env.DB, "1h"),
      readIncidents(env.DB, { status: "open", limit: 100 }),
    ]);
    const body = {
      ...snapshot.body,
      history: history.data,
      alerts: activeIncidents.map(incidentToAlert),
      incidents: activeIncidents,
      requestId,
      fetchedInMs: Date.now() - upstreamStartedAt,
    };

    return jsonResponse(body, 200, {
      ...headers,
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
    });
}

async function runScheduledCollection(event, env) {
  if (!env.DB) throw new Error("Monitoring database is not configured");
  const requestId = `cron-${event.scheduledTime || Date.now()}`;
  const snapshot = await collectSnapshot(env, requestId);
  const now = event.scheduledTime || Date.now();
  await persistSnapshot(env.DB, snapshot, now);
  const conditions = deriveAlertConditions(snapshot.hosts);
  const transitions = await reconcileIncidents(env.DB, conditions, {
    now,
    confirmMs: readConfirmMs(env),
    notificationsEnabled: Boolean((env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) || (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)),
  });
  const notifications = await deliverPendingNotifications(env);
  if (new Date(now).getUTCMinutes() === 0) await pruneOldData(env.DB, now);
  logEvent("info", "scheduled_collection", {
    requestId,
    hosts: snapshot.hosts.length,
    reachableHosts: snapshot.availableHosts,
    failedHosts: snapshot.hosts.filter((node) => !node.reachable).map((node) => node.host),
    conditions: conditions.length,
    transitions: transitions.notifications.length,
    notificationsDelivered: notifications.delivered,
  });
}

async function collectSnapshot(env, requestId) {
  const hosts = readHosts(env);
  const port = String(env.STATUS_SERVICE_PORT || "8787").trim();
  if (hosts.length === 0) throw new Error("Status service is not configured");
  const results = await Promise.all(hosts.map((host) => fetchStatus(env, host, port, requestId)));
  const normalizedHosts = results.map((result) => ({
    host: result.host,
    reachable: Boolean(result.payload),
    status: result.payload ? normalizeStatus(result.payload) : null,
    error: result.error || null,
  }));
  const body = aggregateStatus(normalizedHosts);
  return {
    ...body,
    hosts: normalizedHosts,
    availableHosts: results.filter((result) => result.payload).length,
    body: { ...body, hosts: normalizedHosts },
  };
}

function deriveAlertConditions(hosts) {
  const conditions = [];
  for (const node of hosts) {
    if (!node.reachable) {
      conditions.push({
        alertKey: `${node.host}|host_unreachable`,
        host: node.host,
        code: "host_unreachable",
        severity: "critical",
        message: "VPS node is unreachable",
      });
      continue;
    }
    for (const alert of node.status?.alerts || []) {
      const identity = alert.code === "service_down" ? alert.message : "";
      conditions.push({
        alertKey: `${node.host}|${alert.code}|${identity}`.slice(0, 768),
        host: node.host,
        code: alert.code,
        severity: alert.severity,
        message: alert.message,
      });
    }
  }
  return conditions;
}

function incidentToAlert(incident) {
  return {
    host: incident.host,
    code: incident.code,
    severity: incident.severity,
    message: incident.message,
    createdAt: incident.openedAt,
    status: incident.status,
  };
}

function readConfirmMs(env) {
  const minutes = Number(env.ALERT_CONFIRM_MINUTES || 3);
  return Math.max(1, Math.min(Number.isFinite(minutes) ? minutes : 3, 60)) * 60 * 1_000;
}

function normalizePath(pathname) {
  return pathname.startsWith("/dashboard/api/") ? pathname.slice("/dashboard".length) : pathname;
}

function normalizeStatus(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const services = Array.isArray(source.services)
    ? source.services.map((service) => ({
        name: stringOr(service?.name, "Unnamed service"),
        status: service?.status === "up" ? "up" : "down",
        version: stringOr(service?.version, "unknown"),
        source: stringOr(service?.source, "status-api"),
        detail: stringOrNull(service?.detail),
        error: stringOrNull(service?.error),
        latencyMs: numberOrNull(service?.latencyMs),
        uptimeSeconds: numberOrNull(service?.uptimeSeconds),
        lastHeartbeat: stringOrNull(service?.lastHeartbeat),
        pnlSummary: plainObject(service?.pnlSummary),
      }))
    : [];

  return {
    generatedAt: stringOrNull(source.generatedAt),
    version: stringOr(source.version, "unknown"),
    system: {
      cpuPercent: numberOrNull(source.system?.cpuPercent),
      memoryPercent: numberOrNull(source.system?.memoryPercent),
      diskPercent: numberOrNull(source.system?.diskPercent),
      uptimeSeconds: numberOrNull(source.system?.uptimeSeconds),
      loadAverages: Array.isArray(source.system?.loadAverages) ? source.system.loadAverages.slice(0, 3).map(numberOrNull) : [],
      memoryBytes: {
        total: numberOrNull(source.system?.memoryBytes?.total),
        used: numberOrNull(source.system?.memoryBytes?.used),
        free: numberOrNull(source.system?.memoryBytes?.free),
      },
    },
    node: normalizeNodeInfo(source.node),
    services,
    history: Array.isArray(source.history)
      ? source.history.slice(-60).map((point) => ({
          generatedAt: stringOrNull(point?.generatedAt),
          cpuPercent: numberOrNull(point?.cpuPercent),
          memoryPercent: numberOrNull(point?.memoryPercent),
          diskPercent: numberOrNull(point?.diskPercent),
        }))
      : [],
    pnlSummary: plainObject(source.pnlSummary),
    deployment: plainObject(source.deployment),
    alerts: Array.isArray(source.alerts) ? source.alerts.map(normalizeAlert).filter(Boolean) : [],
    docker: Array.isArray(source.docker) ? source.docker.map(normalizeService).filter(Boolean) : [],
  };
}

function normalizeNodeInfo(node) {
  const source = node && typeof node === "object" ? node : {};
  return {
    hostname: stringOr(source.hostname, "unknown"),
    platform: stringOr(source.platform, "unknown"),
    kernelRelease: stringOr(source.kernelRelease, "unknown"),
    architecture: stringOr(source.architecture, "unknown"),
    distribution: stringOr(source.distribution, "unknown"),
    cpu: {
      model: stringOr(source.cpu?.model, "unknown"),
      logicalCores: numberOrNull(source.cpu?.logicalCores),
    },
    storage: Array.isArray(source.storage) ? source.storage.slice(0, 16).map((item) => ({
      filesystem: stringOr(item?.filesystem, "unknown"), mount: stringOr(item?.mount, "unknown"),
      totalBytes: numberOrNull(item?.totalBytes), usedBytes: numberOrNull(item?.usedBytes),
      availableBytes: numberOrNull(item?.availableBytes), usedPercent: numberOrNull(item?.usedPercent),
    })) : [],
    network: Array.isArray(source.network) ? source.network.slice(0, 32).map((item) => ({
      name: stringOr(item?.name, "unknown"), address: stringOr(item?.address, "unknown"),
      family: stringOr(item?.family, "unknown"), cidr: stringOrNull(item?.cidr),
    })) : [],
  };
}

function normalizeService(service) {
  if (!service || typeof service !== "object") return null;
  return {
    name: stringOr(service.name, "Unnamed service"),
    status: service.status === "up" ? "up" : "down",
    version: stringOr(service.version, "unknown"),
    source: stringOr(service.source, "status-api"),
    detail: stringOrNull(service.detail),
    error: stringOrNull(service.error),
    uptimeSeconds: numberOrNull(service.uptimeSeconds),
    lastHeartbeat: stringOrNull(service.lastHeartbeat),
    pnlSummary: plainObject(service.pnlSummary),
  };
}

function normalizeAlert(alert) {
  if (!alert || typeof alert !== "object") return null;
  return {
    severity: alert.severity === "critical" ? "critical" : "warning",
    code: stringOr(alert.code, "alert"),
    message: stringOr(alert.message, "Alert"),
    createdAt: stringOrNull(alert.createdAt),
  };
}

async function fetchStatus(env, host, port, requestId) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await env.MESH.fetch(`http://${host}:${port}/api/status`, {
        headers: {
          Accept: "application/json",
          "X-Request-ID": requestId,
          "X-Status-API-Token": env.STATUS_SERVICE_TOKEN || "",
        },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (response.ok) {
        return { host, payload: await response.json() };
      }
      lastError = `HTTP ${response.status}`;
      if (response.status < 500 || attempt === MAX_RETRIES) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { host, payload: null, error: lastError || "Unavailable" };
}

function readHosts(env) {
  const configured = String(env.STATUS_SERVICE_HOSTS || "").trim();
  if (configured) {
    try {
      const hosts = JSON.parse(configured);
      if (Array.isArray(hosts)) return hosts.filter((host) => typeof host === "string" && host && !host.startsWith("REPLACE_WITH_"));
    } catch {
      return [];
    }
  }
  const fallback = String(env.STATUS_SERVICE_HOST || "").trim();
  return fallback && !fallback.startsWith("REPLACE_WITH_") ? [fallback] : [];
}

function readControlCatalog(env) {
  try {
    const catalog = JSON.parse(String(env.VPS_CONTROL_CATALOG || "[]"));
    return Array.isArray(catalog) ? catalog.filter((item) => typeof item?.host === "string" && typeof item?.name === "string").map((item) => ({ host: item.host, name: item.name, canRestart: item.canRestart === true, canReadLogs: item.canReadLogs === true })) : [];
  } catch { return []; }
}

function normalizeActionRequestId(value) {
  const candidate = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(candidate) ? candidate : null;
}

function csvResponse(filename, fields, rows, headers = {}) {
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = `${fields.map(escape).join(",")}\n${rows.map((row) => fields.map((field) => escape(row[field])).join(",")).join("\n")}\n`;
  return new Response(csv, { status: 200, headers: { ...headers, "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${filename}"`, "Content-Type": "text/csv; charset=utf-8" } });
}

function aggregateStatus(hosts) {
  const online = hosts.filter((host) => host.status);
  const systems = online.map((host) => host.status.system).filter(Boolean);
  const average = (key) => {
    const values = systems.map((system) => system[key]).filter((value) => typeof value === "number");
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return {
    generatedAt: new Date().toISOString(),
    version: online.map((host) => host.status.version).filter(Boolean).join(", ") || "unknown",
    system: {
      cpuPercent: average("cpuPercent"),
      memoryPercent: average("memoryPercent"),
      diskPercent: average("diskPercent"),
      uptimeSeconds: null,
    },
    services: online.flatMap((host) => host.status.services.map((service) => ({
      ...service,
      host: host.host,
    }))),
    docker: online.flatMap((host) => host.status.docker.map((service) => ({
      ...service,
      host: host.host,
    }))),
    alerts: online.flatMap((host) => host.status.alerts.map((alert) => ({
      ...alert,
      host: host.host,
    }))),
    pnlSummary: online.map((host) => host.status.pnlSummary).find(Boolean) || null,
    deployments: online.map((host) => ({
      host: host.host,
      ...(host.status.deployment || { version: host.status.version }),
    })),
  };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.length <= 256 ? value : fallback;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function isAuthorized(request, env) {
  if (await hasValidAccessIdentity(request, env)) return true;
  return hasValidToken(request, env.STATUS_API_TOKEN);
}

async function hasValidToken(request, expectedToken) {
  const header = request.headers.get("Authorization") || "";
  const actualToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expectedToken || !actualToken) return false;

  const encoder = new TextEncoder();
  const actual = encoder.encode(actualToken);
  const expected = encoder.encode(expectedToken);
  if (actual.length !== expected.length) return false;

  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(actual, expected);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

function corsHeaders(origin, env) {
  const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins.includes("*") ? "*" : "";

  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Referrer-Policy": "no-referrer",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function normalizeRequestId(value) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID();
}

function logEvent(level, event, fields = {}) {
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  logger(JSON.stringify({ timestamp: new Date().toISOString(), level, event, service: "status-worker", ...fields }));
}

function readErrorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code.slice(0, 64) : "UNEXPECTED_ERROR";
}
