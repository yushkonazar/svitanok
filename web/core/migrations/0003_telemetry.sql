-- release-phase: expand
-- Телеметрія прогонів і лічильники квот.

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  trigger     TEXT NOT NULL, -- chat·quick·callback·voice·scheduler·workflow·actions
  profile     TEXT,
  thread_id   TEXT,
  model       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cache_read  INTEGER,
  steps       INTEGER,
  tools_json  TEXT,
  error       TEXT,
  cost_note   TEXT
);
CREATE INDEX idx_runs_started ON runs (started_at);
CREATE INDEX idx_runs_profile ON runs (profile);

CREATE TABLE run_steps (
  id     TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  n      INTEGER NOT NULL,
  at     TEXT NOT NULL,
  kind   TEXT NOT NULL, -- tool·subagent·reply
  name   TEXT,
  ms     INTEGER,
  ok     INTEGER,
  note   TEXT
);
CREATE INDEX idx_run_steps_run_n ON run_steps (run_id, n);

-- PK (key, period): ретенція «12 міс» з 07 §1 можлива лише з рядком на місяць.
CREATE TABLE quota_counters (
  key         TEXT NOT NULL, -- places_text·places_details·routes·gemini_usd·deepgram_min·actions_min·workflow_steps
  period      TEXT NOT NULL, -- YYYY-MM
  value       REAL NOT NULL DEFAULT 0,
  limit_value REAL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (key, period)
);
