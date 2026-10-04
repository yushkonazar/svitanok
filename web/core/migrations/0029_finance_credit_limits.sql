-- release-phase: expand
-- Per-account manual overrides; bank metadata remains the automatic source.
ALTER TABLE finance_settings ADD COLUMN credit_limits_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE finance_taxi_policies ADD COLUMN tips_bps INTEGER NOT NULL DEFAULT 5000 CHECK(tips_bps BETWEEN 0 AND 10000);
