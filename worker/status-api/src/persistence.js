import { maintenanceWindowToApi } from "./maintenance.js";

const RANGE_CONFIG = {
  "1h": { durationMs: 60 * 60 * 1_000, bucketMs: 60 * 1_000 },
  "24h": { durationMs: 24 * 60 * 60 * 1_000, bucketMs: 5 * 60 * 1_000 },
  "7d": { durationMs: 7 * 24 * 60 * 60 * 1_000, bucketMs: 60 * 60 * 1_000 },
  "30d": { durationMs: 30 * 24 * 60 * 60 * 1_000, bucketMs: 6 * 60 * 60 * 1_000 },
  "since": { durationMs: 90 * 24 * 60 * 60 * 1_000, bucketMs: 12 * 60 * 60 * 1_000 },
};

export async function persistSnapshot(db, snapshot, capturedAt = Date.now()) {
  const statements = [];
  for (const node of snapshot.hosts) {
    const system = node.status?.system || {};
    const deployment = node.status?.deployment || {};
    const deploymentVersion = String(deployment.version || deployment.gitCommit || "unknown");
    if (deploymentVersion !== "unknown") {
      const previous = await db.prepare("SELECT version FROM deployment_state WHERE host = ?").bind(node.host).first();
      if (previous?.version && previous.version !== deploymentVersion) {
        statements.push(db.prepare(
          `INSERT OR IGNORE INTO event_log (occurred_at, type, severity, host, title, detail, dedupe_key)
           VALUES (?, 'deployment_changed', 'info', ?, ?, ?, ?)`,
        ).bind(capturedAt, node.host, `Deployment changed to ${deploymentVersion}`, `Previous version: ${previous.version}`, `${node.host}|deployment|${deploymentVersion}`));
      }
      statements.push(db.prepare(
        `INSERT INTO deployment_state (host, version, deployed_at, observed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET version = excluded.version, deployed_at = excluded.deployed_at, observed_at = excluded.observed_at`,
      ).bind(node.host, deploymentVersion, deployment.deployedAt || null, capturedAt));
    }
    statements.push(db.prepare(
      `INSERT INTO metric_samples
        (captured_at, host, reachable, cpu_percent, memory_percent, disk_percent, uptime_seconds, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      capturedAt,
      node.host,
      node.reachable ? 1 : 0,
      system.cpuPercent ?? null,
      system.memoryPercent ?? null,
      system.diskPercent ?? null,
      system.uptimeSeconds ?? null,
      node.status?.version || null,
    ));

    for (const service of node.status?.services || []) {
      statements.push(db.prepare(
        `INSERT INTO service_samples (captured_at, host, name, status, latency_ms, version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(capturedAt, node.host, service.name, service.status, service.latencyMs ?? null, service.version || null));
      statements.push(db.prepare(
        `INSERT INTO service_state
          (host, name, status, source, version, detail, last_heartbeat, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host, name) DO UPDATE SET
          status = excluded.status,
          source = excluded.source,
          version = excluded.version,
          detail = excluded.detail,
          last_heartbeat = excluded.last_heartbeat,
          observed_at = excluded.observed_at`,
      ).bind(
        node.host,
        service.name,
        service.status,
        service.source || null,
        service.version || null,
        service.detail || null,
        service.lastHeartbeat || null,
        capturedAt,
      ));
    }
  }
  if (statements.length) await db.batch(statements);
}

export async function readMetricHistory(db, range = "1h", host = null, now = Date.now()) {
  const selectedRange = RANGE_CONFIG[range] ? range : "1h";
  const config = RANGE_CONFIG[selectedRange];
  const start = now - config.durationMs;
  const hostFilter = host ? "AND host = ?" : "";
  const statement = db.prepare(
    `SELECT
       CAST(captured_at / ? AS INTEGER) * ? AS captured_at,
       AVG(cpu_percent) AS cpu_percent,
       AVG(memory_percent) AS memory_percent,
       AVG(disk_percent) AS disk_percent,
       SUM(CASE WHEN reachable = 1 THEN 1 ELSE 0 END) AS reachable_samples,
       COUNT(*) AS sample_count
     FROM metric_samples
     WHERE captured_at >= ? ${hostFilter}
     GROUP BY CAST(captured_at / ? AS INTEGER)
     ORDER BY captured_at ASC`,
  );
  const bindings = host
    ? [config.bucketMs, config.bucketMs, start, host, config.bucketMs]
    : [config.bucketMs, config.bucketMs, start, config.bucketMs];
  const result = await statement.bind(...bindings).all();
  return {
    range: selectedRange,
    host,
    data: (result.results || []).map((row) => ({
      generatedAt: new Date(Number(row.captured_at)).toISOString(),
      cpuPercent: numberOrNull(row.cpu_percent),
      memoryPercent: numberOrNull(row.memory_percent),
      diskPercent: numberOrNull(row.disk_percent),
      reachablePercent: row.sample_count ? Math.round((Number(row.reachable_samples) / Number(row.sample_count)) * 1_000) / 10 : null,
    })),
  };
}

export async function readIncidents(db, { status = "open", limit = 100 } = {}) {
  const normalizedStatus = ["pending", "open", "resolved", "all"].includes(status) ? status : "open";
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  const filter = normalizedStatus === "all" ? "" : "WHERE status = ?";
  const statement = db.prepare(
    `SELECT alert_key, host, code, severity, message, status, consecutive_count,
      first_seen_at, last_seen_at, opened_at, resolved_at
     FROM incidents ${filter}
     ORDER BY COALESCE(opened_at, first_seen_at) DESC
     LIMIT ?`,
  );
  const result = normalizedStatus === "all"
    ? await statement.bind(normalizedLimit).all()
    : await statement.bind(normalizedStatus, normalizedLimit).all();
  return (result.results || []).map(mapIncident);
}

export async function readMaintenanceWindows(db, { activeAt = null, limit = 100 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  const filter = activeAt == null ? "" : "WHERE starts_at <= ? AND ends_at > ?";
  const statement = db.prepare(
    `SELECT id, host, service_name, starts_at, ends_at, reason, actor, created_at
     FROM maintenance_windows ${filter}
     ORDER BY starts_at ASC LIMIT ?`,
  );
  const result = activeAt == null
    ? await statement.bind(normalizedLimit).all()
    : await statement.bind(activeAt, activeAt, normalizedLimit).all();
  return (result.results || []).map(maintenanceWindowToApi);
}

export async function createMaintenanceWindow(db, entry) {
  await db.prepare(
    `INSERT INTO maintenance_windows
      (id, host, service_name, starts_at, ends_at, reason, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(entry.id, entry.host, entry.serviceName, entry.startsAt, entry.endsAt, entry.reason, entry.actor, entry.createdAt).run();
  return entry;
}

export async function deleteMaintenanceWindow(db, id) {
  const result = await db.prepare("DELETE FROM maintenance_windows WHERE id = ?").bind(id).run();
  return Number(result.meta?.changes || 0) === 1;
}

export async function reconcileIncidents(db, conditions, options = {}) {
  const now = options.now ?? Date.now();
  const confirmMs = options.confirmMs ?? 3 * 60 * 1_000;
  const notificationsEnabled = Boolean(options.notificationsEnabled);
  const existingResult = await db.prepare(
    "SELECT * FROM incidents WHERE status IN ('pending', 'open')",
  ).all();
  const existing = (existingResult.results || []).map(mapIncidentRow);
  const transitions = planIncidentTransitions(existing, conditions, now, confirmMs, options.isSuppressed);
  const statements = transitions.upserts.map((incident) => db.prepare(
    `INSERT INTO incidents
      (alert_key, host, code, severity, message, status, consecutive_count,
       first_seen_at, last_seen_at, opened_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(alert_key) DO UPDATE SET
       host = excluded.host,
       code = excluded.code,
       severity = excluded.severity,
       message = excluded.message,
       status = excluded.status,
       consecutive_count = excluded.consecutive_count,
       first_seen_at = excluded.first_seen_at,
       last_seen_at = excluded.last_seen_at,
       opened_at = excluded.opened_at,
       resolved_at = excluded.resolved_at`,
  ).bind(
    incident.alertKey,
    incident.host,
    incident.code,
    incident.severity,
    incident.message,
    incident.status,
    incident.consecutiveCount,
    incident.firstSeenAt,
    incident.lastSeenAt,
    incident.openedAt,
    incident.resolvedAt,
  ));

  if (notificationsEnabled) {
    for (const transition of transitions.notifications) {
      statements.push(db.prepare(
        `INSERT INTO notification_outbox
          (alert_key, event_type, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(transition.incident.alertKey, transition.type, JSON.stringify(transition.incident), now));
    }
  }
  for (const transition of transitions.notifications) {
    const incident = transition.incident;
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO event_log
        (occurred_at, type, severity, host, service_name, title, detail, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      transition.type === "opened" ? incident.openedAt : incident.resolvedAt,
      transition.type === "opened" ? "incident_opened" : "incident_resolved",
      transition.type === "opened" ? incident.severity : "info",
      incident.host,
      incident.code === "service_down" ? serviceNameFromMessage(incident.message) : null,
      transition.type === "opened" ? incident.message : `Recovered: ${incident.message}`,
      incident.code,
      `${incident.alertKey}|${transition.type}|${transition.type === "opened" ? incident.openedAt : incident.resolvedAt}`,
    ));
  }
  if (statements.length) await db.batch(statements);
  return transitions;
}

export function planIncidentTransitions(existing, conditions, now, confirmMs, isSuppressed = () => false) {
  const currentByKey = new Map(conditions.map((condition) => [condition.alertKey, condition]));
  const existingByKey = new Map(existing.map((incident) => [incident.alertKey, incident]));
  const upserts = [];
  const notifications = [];

  for (const condition of conditions) {
    if (isSuppressed(condition)) continue;
    const previous = existingByKey.get(condition.alertKey);
    const incident = previous
      ? { ...previous, ...condition, lastSeenAt: now, consecutiveCount: previous.consecutiveCount + 1, resolvedAt: null }
      : { ...condition, status: "pending", consecutiveCount: 1, firstSeenAt: now, lastSeenAt: now, openedAt: null, resolvedAt: null };

    if (incident.status !== "open" && now - incident.firstSeenAt >= confirmMs) {
      incident.status = "open";
      incident.openedAt = now;
      notifications.push({ type: "opened", incident: { ...incident } });
    }
    upserts.push(incident);
  }

  for (const previous of existing) {
    if (currentByKey.has(previous.alertKey)) continue;
    const resolved = { ...previous, status: "resolved", lastSeenAt: now, resolvedAt: now };
    upserts.push(resolved);
    if (previous.status === "open") notifications.push({ type: "resolved", incident: { ...resolved } });
  }

  return { upserts, notifications };
}

export async function readPendingNotifications(db, limit = 20) {
  const result = await db.prepare(
    `SELECT id, alert_key, event_type, payload, attempts
     FROM notification_outbox
     WHERE delivered_at IS NULL AND attempts < 5
     ORDER BY created_at ASC
     LIMIT ?`,
  ).bind(Math.max(1, Math.min(limit, 50))).all();
  return result.results || [];
}

export async function markNotification(db, id, { delivered, error = null, now = Date.now() }) {
  await db.prepare(
    `UPDATE notification_outbox
     SET delivered_at = ?, attempts = attempts + 1, last_error = ?
     WHERE id = ?`,
  ).bind(delivered ? now : null, error ? String(error).slice(0, 500) : null, id).run();
}

export async function pruneOldData(db, now = Date.now()) {
  const metricCutoff = now - 90 * 24 * 60 * 60 * 1_000;
  const incidentCutoff = now - 180 * 24 * 60 * 60 * 1_000;
  await db.batch([
    db.prepare("DELETE FROM metric_samples WHERE captured_at < ?").bind(metricCutoff),
    db.prepare("DELETE FROM service_samples WHERE captured_at < ?").bind(metricCutoff),
    db.prepare("DELETE FROM event_log WHERE occurred_at < ?").bind(incidentCutoff),
    db.prepare("DELETE FROM notification_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?").bind(incidentCutoff),
    db.prepare("DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < ?").bind(incidentCutoff),
  ]);
}

export async function readServiceHistory(db, { host, name, range = "24h" } = {}, now = Date.now()) {
  const selectedRange = RANGE_CONFIG[range] ? range : "24h";
  const config = RANGE_CONFIG[selectedRange];
  const start = now - config.durationMs;
  const result = await db.prepare(
    `SELECT CAST(captured_at / ? AS INTEGER) * ? AS captured_at,
      AVG(CASE WHEN status = 'up' THEN 100.0 ELSE 0.0 END) AS availability_percent,
      AVG(latency_ms) AS latency_ms, COUNT(*) AS sample_count
     FROM service_samples
     WHERE captured_at >= ? AND host = ? AND name = ?
     GROUP BY CAST(captured_at / ? AS INTEGER)
     ORDER BY captured_at ASC`,
  ).bind(config.bucketMs, config.bucketMs, start, host, name, config.bucketMs).all();
  const summary = await db.prepare(
    `SELECT AVG(CASE WHEN status = 'up' THEN 100.0 ELSE 0.0 END) AS availability_percent,
      AVG(latency_ms) AS latency_ms, COUNT(*) AS sample_count,
      MIN(captured_at) AS first_observed_at, MAX(captured_at) AS last_observed_at
     FROM service_samples WHERE captured_at >= ? AND host = ? AND name = ?`,
  ).bind(start, host, name).first();
  return {
    host, name, range: selectedRange,
    availabilityPercent: numberOrNull(summary?.availability_percent),
    averageLatencyMs: numberOrNull(summary?.latency_ms),
    sampleCount: Number(summary?.sample_count || 0),
    firstObservedAt: toIso(summary?.first_observed_at),
    lastObservedAt: toIso(summary?.last_observed_at),
    coverageSeconds: coverageSeconds(summary?.first_observed_at, summary?.last_observed_at),
    requestedWindowSeconds: Math.round(config.durationMs / 1_000),
    data: (result.results || []).map((row) => ({
      generatedAt: toIso(row.captured_at),
      availabilityPercent: numberOrNull(row.availability_percent),
      latencyMs: numberOrNull(row.latency_ms),
      sampleCount: Number(row.sample_count || 0),
    })),
  };
}

export async function readAvailabilitySummary(db, range = "7d", now = Date.now()) {
  const selectedRange = RANGE_CONFIG[range] ? range : "7d";
  const start = now - RANGE_CONFIG[selectedRange].durationMs;
  const activeCutoff = now - 5 * 60 * 1_000;
  const result = await db.prepare(
    `SELECT host, name,
      AVG(CASE WHEN status = 'up' THEN 100.0 ELSE 0.0 END) AS availability_percent,
      AVG(latency_ms) AS latency_ms, COUNT(*) AS sample_count,
      MIN(captured_at) AS first_observed_at, MAX(captured_at) AS last_observed_at
     FROM service_samples WHERE captured_at >= ?
     GROUP BY host, name
     HAVING MAX(captured_at) >= ?
     ORDER BY availability_percent ASC, name ASC`,
  ).bind(start, activeCutoff).all();
  return { range: selectedRange, requestedWindowSeconds: Math.round(RANGE_CONFIG[selectedRange].durationMs / 1_000), data: (result.results || []).map((row) => ({
    host: row.host, name: row.name,
    availabilityPercent: numberOrNull(row.availability_percent),
    averageLatencyMs: numberOrNull(row.latency_ms),
    sampleCount: Number(row.sample_count || 0),
    firstObservedAt: toIso(row.first_observed_at),
    lastObservedAt: toIso(row.last_observed_at),
    coverageSeconds: coverageSeconds(row.first_observed_at, row.last_observed_at),
  })) };
}

export async function readEvents(db, { limit = 100, host = null, type = null, since = null } = {}) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  const allowedTypes = new Set(["incident_opened", "incident_resolved", "deployment_changed", "control_logs", "control_restart"]);
  const normalizedType = allowedTypes.has(type) ? type : null;
  const normalizedSince = Number.isFinite(Number(since)) ? Number(since) : 0;
  const result = await db.prepare(
    `SELECT id, occurred_at, type, severity, host, service_name, title, detail, actor, status FROM (
       SELECT CAST(id AS TEXT) AS id, occurred_at, type, severity, host, service_name, title, detail, NULL AS actor, NULL AS status FROM event_log
       UNION ALL
       SELECT request_id AS id, created_at AS occurred_at, 'control_' || action AS type,
         CASE WHEN status = 'failed' THEN 'warning' ELSE 'info' END AS severity,
         host, service_name, action || ': ' || service_name AS title, result_code AS detail, actor, status
       FROM control_audit
     ) WHERE occurred_at >= ? AND (? IS NULL OR host = ?) AND (? IS NULL OR type = ?)
     ORDER BY occurred_at DESC LIMIT ?`,
  ).bind(normalizedSince, host, host, normalizedType, normalizedType, normalizedLimit).all();
  return (result.results || []).map((row) => ({
    id: String(row.id), occurredAt: toIso(row.occurred_at), type: row.type,
    severity: row.severity, host: row.host, serviceName: row.service_name,
    title: row.title, detail: row.detail, actor: row.actor || null, status: row.status || null,
  }));
}

export async function savePushSubscription(db, subscription, now = Date.now()) {
  const endpoint = String(subscription?.endpoint || "");
  const p256dh = String(subscription?.keys?.p256dh || "");
  const auth = String(subscription?.keys?.auth || "");
  if (!endpoint.startsWith("https://") || !p256dh || !auth) throw new Error("Invalid push subscription");
  const endpointHash = await sha256(endpoint);
  await db.prepare(
    `INSERT INTO push_subscriptions (endpoint_hash, endpoint, p256dh, auth, created_at, last_seen_at, failure_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(endpoint_hash) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
       auth = excluded.auth, last_seen_at = excluded.last_seen_at, failure_count = 0`,
  ).bind(endpointHash, endpoint, p256dh, auth, now, now).run();
  return endpointHash;
}

export async function deletePushSubscription(db, endpoint) {
  await db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ?").bind(await sha256(String(endpoint || ""))).run();
}

export async function readPushSubscriptions(db, limit = 100) {
  const result = await db.prepare(
    "SELECT endpoint_hash, endpoint, p256dh, auth, failure_count FROM push_subscriptions ORDER BY last_seen_at DESC LIMIT ?",
  ).bind(Math.max(1, Math.min(Number(limit) || 100, 500))).all();
  return result.results || [];
}

export async function recordPushFailure(db, endpointHash, { remove = false } = {}) {
  if (remove) await db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ?").bind(endpointHash).run();
  else await db.prepare("UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE endpoint_hash = ?").bind(endpointHash).run();
}

export async function beginControlAudit(db, entry) {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO control_audit (request_id, created_at, actor, host, service_name, action, status)
     VALUES (?, ?, ?, ?, ?, ?, 'started')`,
  ).bind(entry.requestId, entry.createdAt, entry.actor, entry.host, entry.name, entry.action).run();
  return Number(result.meta?.changes || 0) === 1;
}

export async function completeControlAudit(db, requestId, { status, resultCode, durationMs, completedAt = Date.now() }) {
  await db.prepare(
    "UPDATE control_audit SET completed_at = ?, status = ?, result_code = ?, duration_ms = ? WHERE request_id = ?",
  ).bind(completedAt, status, String(resultCode || "").slice(0, 64), durationMs, requestId).run();
}

export async function readControlAudit(db, limit = 50) {
  const result = await db.prepare(
    "SELECT request_id, created_at, completed_at, actor, host, service_name, action, status, result_code, duration_ms FROM control_audit ORDER BY created_at DESC LIMIT ?",
  ).bind(Math.max(1, Math.min(Number(limit) || 50, 100))).all();
  return (result.results || []).map((row) => ({
    requestId: row.request_id, createdAt: toIso(row.created_at), completedAt: toIso(row.completed_at), actor: row.actor,
    host: row.host, name: row.service_name, action: row.action, status: row.status,
    resultCode: row.result_code, durationMs: numberOrNull(row.duration_ms),
  }));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serviceNameFromMessage(message) {
  return String(message || "").replace(/\s+is unavailable$/i, "") || null;
}

function mapIncident(row) {
  return {
    alertKey: row.alert_key,
    host: row.host,
    code: row.code,
    severity: row.severity,
    message: row.message,
    status: row.status,
    consecutiveCount: Number(row.consecutive_count),
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    openedAt: toIso(row.opened_at),
    resolvedAt: toIso(row.resolved_at),
  };
}

function mapIncidentRow(row) {
  return {
    alertKey: row.alert_key,
    host: row.host,
    code: row.code,
    severity: row.severity,
    message: row.message,
    status: row.status,
    consecutiveCount: Number(row.consecutive_count),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    openedAt: row.opened_at == null ? null : Number(row.opened_at),
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
  };
}

function toIso(value) {
  return value == null ? null : new Date(Number(value)).toISOString();
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function coverageSeconds(first, last) {
  if (first == null || last == null) return 0;
  return Math.max(0, Math.round((Number(last) - Number(first)) / 1_000));
}
