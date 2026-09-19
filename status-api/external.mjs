import { connect as connectTls } from "node:tls";

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CHECKS = 32;
const MAX_URL_LENGTH = 2_048;
const MAX_NAME_LENGTH = 128;
const DAY_MS = 86_400_000;

export function readExternalChecks(value) {
  let parsed;
  try { parsed = value ? JSON.parse(value) : []; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    try { return normalizeExternalCheck(item); } catch { return null; }
  }).filter(Boolean).slice(0, MAX_CHECKS);
}

export function normalizeExternalCheck(input) {
  const id = String(input?.id || "").trim();
  const name = String(input?.name || id).trim();
  const url = String(input?.url || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error("Invalid external check id");
  if (!name || name.length > MAX_NAME_LENGTH || /[\r\n]/.test(name)) throw new Error("Invalid external check name");
  if (!isAllowedExternalUrl(url)) throw new Error("External check URL must be a public HTTP or HTTPS URL");
  const expectedStatus = boundedInteger(input?.expectedStatus, 200, 100, 599);
  const timeoutMs = boundedInteger(input?.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 10_000);
  const tlsWarningDays = boundedInteger(input?.tlsWarningDays, 30, 1, 365);
  const tlsCriticalDays = Math.min(boundedInteger(input?.tlsCriticalDays, 7, 0, 365), tlsWarningDays);
  return { id, name, url, expectedStatus, timeoutMs, tlsWarningDays, tlsCriticalDays };
}

export function isAllowedExternalUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { return false; }
  if (!/[.]$/.test(url.hostname) && !url.hostname.includes(".")) return false;
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.hash) return false;
  if (url.port && !["80", "443"].includes(url.port)) return false;
  const hostname = url.hostname.toLowerCase().replace(/[.]$/, "");
  if (["localhost", "localhost.localdomain", "metadata.google.internal"].includes(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) return false;
  if (isIpv4(hostname)) return isPublicIpv4(hostname);
  if (hostname.includes(":")) return !/^[:f][ce]/i.test(hostname) && hostname !== "::1";
  return url.toString().length <= MAX_URL_LENGTH;
}

export async function probeExternalCheck(check, { fetchImpl = globalThis.fetch, tlsProbe = readTlsCertificate, now = Date.now() } = {}) {
  const result = {
    id: check.id,
    name: check.name,
    url: check.url,
    status: "down",
    httpStatus: null,
    latencyMs: null,
    error: null,
    tls: null,
    alerts: [],
  };
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(check.url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "*/*", "User-Agent": "Developer-Control-Center-Monitor/1" },
      signal: AbortSignal.timeout(check.timeoutMs),
    });
    result.httpStatus = response.status;
    result.status = response.status === check.expectedStatus ? "up" : "down";
    if (result.status === "down") result.alerts.push({ code: "external_down", severity: "critical", message: `Expected HTTP ${check.expectedStatus}, received ${response.status}` });
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 256) : "External check failed";
    result.alerts.push({ code: "external_down", severity: "critical", message: result.error });
  }
  result.latencyMs = Math.max(0, Date.now() - startedAt);

  if (check.url.startsWith("https:")) {
    try {
      result.tls = await tlsProbe(check.url, { now, timeoutMs: check.timeoutMs });
      if (!result.tls || !Number.isFinite(result.tls.daysRemaining)) throw new Error("Certificate expiry is unavailable");
      if (result.tls.daysRemaining < 0) {
        result.status = "down";
        result.alerts.push({ code: "tls_expired", severity: "critical", message: `TLS certificate expired ${Math.abs(result.tls.daysRemaining)} days ago` });
      } else if (result.tls.daysRemaining <= check.tlsCriticalDays) {
        result.alerts.push({ code: "tls_expiring", severity: "critical", message: `TLS certificate expires in ${result.tls.daysRemaining} days` });
      } else if (result.tls.daysRemaining <= check.tlsWarningDays) {
        result.alerts.push({ code: "tls_expiring", severity: "warning", message: `TLS certificate expires in ${result.tls.daysRemaining} days` });
      }
    } catch (error) {
      result.status = "down";
      result.alerts.push({ code: "tls_check_failed", severity: "critical", message: error instanceof Error ? error.message.slice(0, 256) : "TLS check failed" });
    }
  }
  return result;
}

export function summarizeCertificate(certificate, now = Date.now()) {
  const expiresAtMs = Date.parse(String(certificate?.valid_to || ""));
  if (!Number.isFinite(expiresAtMs)) return { expiresAt: null, daysRemaining: null };
  return { expiresAt: new Date(expiresAtMs).toISOString(), daysRemaining: Math.floor((expiresAtMs - now) / DAY_MS) };
}

function readTlsCertificate(rawUrl, { now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(rawUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    let socket;
    try {
      socket = connectTls({
        host: url.hostname,
        port: Number(url.port || 443),
        servername: url.hostname,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      });
      socket.once("secureConnect", () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        finish(resolve, summarizeCertificate(certificate, now));
      });
      socket.once("timeout", () => { socket.destroy(); finish(reject, new Error("TLS check timed out")); });
      socket.once("error", (error) => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function isIpv4(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function isPublicIpv4(value) {
  const [first, second] = value.split(".").map(Number);
  if (value.split(".").some((part) => Number(part) > 255)) return false;
  return first !== 0 && first !== 10 && first !== 127 && !(first === 100 && second >= 64 && second <= 127) && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && second === 168);
}
