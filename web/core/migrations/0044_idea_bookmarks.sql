-- release-phase: expand
-- The Mini App uses the existing ideas registry; formulations are reviewable drafts.
CREATE TABLE idea_bookmark_commands (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE idea_bookmark_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid=1)
);
CREATE TABLE idea_formulations (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  source_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
  context_version TEXT,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  custom_prompt TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idea_formulations_idea ON idea_formulations(idea_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX idea_formulations_active ON idea_formulations(idea_id) WHERE status IN ('queued','running');
