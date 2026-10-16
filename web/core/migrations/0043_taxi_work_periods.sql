-- release-phase: expand
-- Historical schedule epochs and explicit attribution for late-entered old-car shifts.
ALTER TABLE finance_taxi_policies ADD COLUMN period_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE finance_taxi_entries ADD COLUMN period_key TEXT;
