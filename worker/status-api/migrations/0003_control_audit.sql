CREATE TABLE IF NOT EXISTS control_audit (
  request_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  actor TEXT NOT NULL,
  host TEXT NOT NULL,
  service_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('logs', 'restart')),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  result_code TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_control_audit_created_at ON control_audit (created_at DESC);
