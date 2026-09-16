-- Keep both the host-specific history queries and the global time-window
-- summaries indexable.  The existing composite indexes start with host/name,
-- so timestamp-only queries otherwise scan the full history.
CREATE INDEX IF NOT EXISTS idx_metric_samples_time
  ON metric_samples (captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_samples_time
  ON service_samples (captured_at DESC);
