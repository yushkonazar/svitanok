-- release-phase: expand
-- Owner-facing fact history. Facts remain the current truth; this append-only
-- ledger explains every create, edit, deletion and restoration without making
-- a stale value active again.

CREATE TABLE fact_ledger (
  id           TEXT PRIMARY KEY,
  fact_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  key          TEXT NOT NULL,
  operation    TEXT NOT NULL, -- created·updated·deleted·restored
  value_json   TEXT,
  source       TEXT,
  confidence   REAL,
  observed_at  TEXT,
  expires_at   TEXT,
  review_at    TEXT,
  supersedes   TEXT,
  actor        TEXT NOT NULL, -- model·owner·trusted_server·undo
  tainted      INTEGER NOT NULL DEFAULT 0,
  why          TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_fact_ledger_fact_at ON fact_ledger(fact_id, created_at);
CREATE INDEX idx_fact_ledger_kind_key_at ON fact_ledger(kind, key, created_at);
