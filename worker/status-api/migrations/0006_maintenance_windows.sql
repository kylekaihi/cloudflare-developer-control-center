CREATE TABLE IF NOT EXISTS maintenance_windows (
  id TEXT PRIMARY KEY,
  host TEXT,
  service_name TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_time
  ON maintenance_windows (starts_at, ends_at);
