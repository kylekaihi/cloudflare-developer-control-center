const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_WINDOW_MS = 60 * 60 * 1_000;
const MAX_SCOPE_LENGTH = 128;
const MAX_REASON_LENGTH = 256;

export function normalizeMaintenanceWindow(input, { now = Date.now(), actor = "access-user", id = randomId() } = {}) {
  const startsAt = parseTimestamp(input?.startsAt, now);
  const endsAt = parseTimestamp(input?.endsAt, startsAt + DEFAULT_WINDOW_MS);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw new Error("Invalid maintenance window time");
  if (endsAt <= startsAt) throw new Error("Maintenance window must end after it starts");
  if (endsAt - startsAt > MAX_WINDOW_MS) throw new Error("Maintenance window cannot exceed 30 days");

  const reason = normalizeReason(input?.reason);
  return {
    id: normalizeId(id),
    host: normalizeScope(input?.host),
    serviceName: normalizeScope(input?.serviceName),
    startsAt,
    endsAt,
    reason,
    actor: normalizeActor(actor),
    createdAt: now,
  };
}

export function matchesMaintenanceWindow(window, host, serviceName, at = Date.now()) {
  const startsAt = windowTimestamp(window?.startsAt);
  const endsAt = windowTimestamp(window?.endsAt);
  if (!window || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt > at || endsAt <= at) return false;
  if (window.host && window.host !== host) return false;
  if (window.serviceName && window.serviceName !== serviceName) return false;
  return true;
}

export function incidentServiceName(incident) {
  if (incident?.code !== "service_down") return null;
  return String(incident.message || "").replace(/\s+is unavailable$/i, "") || null;
}

export function maintenanceWindowToApi(row) {
  return {
    id: String(row.id),
    host: row.host || null,
    serviceName: row.service_name ?? row.serviceName ?? null,
    startsAt: new Date(Number(row.starts_at ?? row.startsAt)).toISOString(),
    endsAt: new Date(Number(row.ends_at ?? row.endsAt)).toISOString(),
    reason: String(row.reason || ""),
    actor: String(row.actor || "access-user"),
    createdAt: new Date(Number(row.created_at ?? row.createdAt)).toISOString(),
  };
}

function parseTimestamp(value, fallback) {
  if (value == null || value === "") return fallback;
  const numeric = typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : NaN;
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function windowTimestamp(value) {
  if (typeof value === "number") return value;
  return parseTimestamp(value, NaN);
}

function normalizeScope(value) {
  const scope = String(value ?? "").trim();
  if (!scope) return null;
  if (scope.length > MAX_SCOPE_LENGTH || /[\r\n]/.test(scope)) throw new Error("Invalid maintenance scope");
  return scope;
}

function normalizeReason(value) {
  const reason = String(value ?? "").trim();
  if (!reason || reason.length > MAX_REASON_LENGTH || /[\r\n]/.test(reason)) throw new Error("Maintenance reason is required");
  return reason;
}

function normalizeActor(value) {
  const actor = String(value || "access-user").trim();
  return actor.slice(0, MAX_SCOPE_LENGTH) || "access-user";
}

function normalizeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error("Invalid maintenance id");
  return id;
}

function randomId() {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `mw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
