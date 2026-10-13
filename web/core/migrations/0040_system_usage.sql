-- release-phase: expand
-- Operational receipts share the existing 90-day telemetry lifecycle.
-- A model receipt replaces its legacy run_step projection, never adds to it.
CREATE TABLE IF NOT EXISTS usage_receipts (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, run_id TEXT,
  feature TEXT NOT NULL, provider TEXT NOT NULL, sku TEXT NOT NULL,
  basis TEXT NOT NULL, cost_nano_usd INTEGER, quantity REAL, unit TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER,
  api_attempts INTEGER, model_responses INTEGER, duration_ms REAL, ok INTEGER,
  price_version TEXT
);
CREATE INDEX IF NOT EXISTS usage_receipts_at ON usage_receipts(at, feature, provider);
CREATE INDEX IF NOT EXISTS usage_receipts_run ON usage_receipts(run_id);
CREATE INDEX IF NOT EXISTS run_steps_kind_at ON run_steps(kind, at);
CREATE TABLE IF NOT EXISTS system_billing_snapshots (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, snapshot_json TEXT,
  attempted_at TEXT NOT NULL, collected_at TEXT, error_class TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT
);
CREATE TABLE IF NOT EXISTS system_preferences (
  id TEXT PRIMARY KEY, value_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
