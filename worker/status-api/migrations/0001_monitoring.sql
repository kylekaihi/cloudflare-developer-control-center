CREATE TABLE IF NOT EXISTS metric_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at INTEGER NOT NULL,
  host TEXT NOT NULL,
  reachable INTEGER NOT NULL,
  cpu_percent REAL,
  memory_percent REAL,
  disk_percent REAL,
  uptime_seconds INTEGER,
  version TEXT
);

CREATE INDEX IF NOT EXISTS idx_metric_samples_host_time
  ON metric_samples (host, captured_at DESC);

CREATE TABLE IF NOT EXISTS service_state (
  host TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT,
  version TEXT,
  detail TEXT,
  last_heartbeat TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (host, name)
);

CREATE TABLE IF NOT EXISTS incidents (
  alert_key TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'open', 'resolved')),
  consecutive_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  opened_at INTEGER,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_incidents_status_seen
  ON incidents (status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'resolved')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  FOREIGN KEY (alert_key) REFERENCES incidents(alert_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON notification_outbox (delivered_at, created_at);
