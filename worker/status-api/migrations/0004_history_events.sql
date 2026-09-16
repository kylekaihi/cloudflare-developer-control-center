CREATE TABLE IF NOT EXISTS deployment_state (
  host TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  deployed_at TEXT,
  observed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metric_samples_host_time ON metric_samples (host, captured_at DESC);
