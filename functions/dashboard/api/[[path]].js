const ALLOWED_RESOURCES = new Set(["status", "metrics", "incidents", "services", "events", "push", "controls", "maintenance"]);

export async function onRequest(context) {
  const startedAt = Date.now();
  const requestId = normalizeRequestId(context.request.headers.get("CF-Ray") || context.request.headers.get("X-Request-ID"));
  let response;
  try {
    response = await proxyRequest(context, requestId);
  } catch {
    response = jsonError("UPSTREAM_UNAVAILABLE", "Status service unavailable", 503);
  }
  const durationMs = Date.now() - startedAt;
  const headers = new Headers(response.headers);
  if (!headers.has("X-Request-ID")) headers.set("X-Request-ID", requestId);
  headers.set("Server-Timing", `pages;dur=${durationMs}`);
  const log = () => console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
    event: "pages_api_request",
    service: "dashboard-pages-function",
    requestId,
    method: context.request.method,
    resource: readResource(context.params.path) || "unknown",
    status: response.status,
    durationMs,
  }));
  if (typeof context.waitUntil === "function") context.waitUntil(Promise.resolve().then(log));
  else log();
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function proxyRequest(context, requestId) {
  const resource = readResource(context.params.path);
  if (!ALLOWED_RESOURCES.has(resource)) return jsonError("NOT_FOUND", "Resource not found", 404);
  const allowedMethods = ["push", "maintenance"].includes(resource) ? new Set(["GET", "POST", "DELETE"]) : resource === "controls" ? new Set(["GET", "POST"]) : new Set(["GET"]);
  if (!allowedMethods.has(context.request.method)) return jsonError("METHOD_NOT_ALLOWED", "Method not supported", 405, { Allow: [...allowedMethods].join(", ") });
  if (!context.env.STATUS_WORKER?.fetch) return jsonError("UPSTREAM_NOT_CONFIGURED", "Status service binding is not configured", 503);

  const incomingUrl = new URL(context.request.url);
  const upstreamUrl = new URL(`https://developer-control-center-status.internal/api/${resource}`);
  upstreamUrl.search = incomingUrl.search;
  const headers = new Headers({ Accept: "application/json" });
  if (context.request.headers.get("Content-Type")) headers.set("Content-Type", context.request.headers.get("Content-Type"));
  copyHeader(context.request.headers, headers, "Cf-Access-Jwt-Assertion");
  copyHeader(context.request.headers, headers, "Authorization");
  copyHeader(context.request.headers, headers, "CF-Ray");
  headers.set("X-Request-ID", requestId);
  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(context.request.method)
    ? await context.request.arrayBuffer()
    : undefined;

  try {
    const response = await context.env.STATUS_WORKER.fetch(new Request(upstreamUrl, {
      method: context.request.method,
      headers,
      body,
    }));
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders(response.headers),
    });
  } catch { return jsonError("UPSTREAM_UNAVAILABLE", "Status service unavailable", 503); }
}

function readResource(path) {
  if (Array.isArray(path)) return path[0] || "";
  return String(path || "").split("/")[0];
}

function copyHeader(source, target, name) {
  const value = source.get(name);
  if (value) target.set(name, value);
}

function responseHeaders(upstreamHeaders) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": upstreamHeaders.get("Content-Type") || "application/json; charset=utf-8",
    ...securityHeaders(),
  });
  const requestId = upstreamHeaders.get("X-Request-ID");
  if (requestId) headers.set("X-Request-ID", requestId);
  const disposition = upstreamHeaders.get("Content-Disposition");
  if (disposition) headers.set("Content-Disposition", disposition);
  return headers;
}

function jsonError(code, message, status, extraHeaders = {}) {
  return Response.json({ error: { code, message } }, {
    status,
    headers: { "Cache-Control": "no-store", ...securityHeaders(), ...extraHeaders },
  });
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function normalizeRequestId(value) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID();
}
