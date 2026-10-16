-- release-phase: expand
-- Existing day_plans/plan_items never become XP commitments.
CREATE TABLE IF NOT EXISTS motivation_account (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
);
CREATE TABLE IF NOT EXISTS motivation_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  date TEXT,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
);
CREATE INDEX IF NOT EXISTS motivation_records_kind_date ON motivation_records(kind,date);
CREATE TABLE IF NOT EXISTS motivation_commands (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS motivation_ledger (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  delta INTEGER NOT NULL,
  experience_delta INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
);
CREATE INDEX IF NOT EXISTS motivation_ledger_at ON motivation_ledger(at,id);
-- This guard intentionally fails a transaction on stale account revisions.
CREATE TABLE IF NOT EXISTS motivation_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
