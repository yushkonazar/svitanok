-- release-phase: expand
-- Metadata and reproducible history only. Existing money and bank records stay intact.
ALTER TABLE finance_settings ADD COLUMN display_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE finance_taxi_entries ADD COLUMN day_complete INTEGER NOT NULL DEFAULT 1;
ALTER TABLE finance_goals ADD COLUMN plan_started_at TEXT;
-- Future plan edits start a new contribution history instead of restating older plans.
UPDATE finance_goals SET plan_started_at = COALESCE(
  (SELECT MIN(at) FROM finance_goal_moves WHERE goal_id = finance_goals.id), created_at
) WHERE plan_amount_minor IS NOT NULL;
CREATE TABLE finance_budget_versions (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0,
  UNIQUE(budget_id, valid_from, sequence)
);
CREATE INDEX finance_budget_history ON finance_budget_versions(budget_id, valid_from);
-- The current definition is known from migration time, never invented in the past.
INSERT INTO finance_budget_versions(id,budget_id,valid_from,definition_json)
SELECT 'initial:' || id,id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  json_object('id',id,'category',category,'categories',json(CASE WHEN json_valid(categories_json) THEN categories_json ELSE '[]' END),
  'purpose',purpose,'period',period,'limitMinor',limit_minor,'shareBps',share_bps,
  'incomeBaseMinor',income_base_minor,'parentId',parent_id,'goalId',goal_id)
FROM finance_budgets;
CREATE TABLE finance_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  seen_at TEXT
);
CREATE INDEX finance_events_recent ON finance_events(at);
CREATE TABLE finance_forecast_runs (
  id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  source_key TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  result_json TEXT NOT NULL
);
CREATE INDEX finance_forecast_history ON finance_forecast_runs(as_of);
