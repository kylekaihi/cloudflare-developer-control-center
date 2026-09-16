CREATE TABLE IF NOT EXISTS service_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at INTEGER NOT NULL,
  host TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'down')),
  latency_ms INTEGER,
  version TEXT
);

CREATE INDEX IF NOT EXISTS idx_service_samples_identity_time
  ON service_samples (host, name, captured_at DESC);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  host TEXT,
  service_name TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  dedupe_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_log_time ON event_log (occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_dedupe ON event_log (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0
);
