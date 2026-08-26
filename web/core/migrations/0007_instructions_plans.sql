-- Інструкції (синк з репозиторію), звіти, корпус стилю, план дня v2.

CREATE TABLE instructions (
  name         TEXT PRIMARY KEY,
  kind         TEXT,
  version_hash TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  max_chars    INTEGER,
  deployed_at  TEXT
);

CREATE TABLE instruction_history (
  name         TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  deployed_at  TEXT NOT NULL
);
CREATE INDEX idx_instruction_history_name_at ON instruction_history (name, deployed_at);

CREATE TABLE reports (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL, -- weekly·monthly-block
  period_from      TEXT,
  period_to        TEXT,
  text_md          TEXT,
  instruction_hash TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_reports_kind_created ON reports (kind, created_at);

CREATE TABLE style_corpus (
  id       TEXT PRIMARY KEY,
  msg_id   TEXT,
  at       TEXT,
  text     TEXT,
  kind     TEXT, -- post·message·comment
  approved INTEGER
);
CREATE INDEX idx_style_corpus_at ON style_corpus (at);

CREATE TABLE day_plans (
  date        TEXT PRIMARY KEY,
  status      TEXT NOT NULL, -- intent·draft·accepted·reviewed·skipped
  intent_text TEXT,
  fill_ratio  REAL,
  workflow_id TEXT,
  created_at  TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE plan_items (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL,
  title        TEXT NOT NULL,
  kind         TEXT, -- deep·routine·call·errand·move
  est_min      INTEGER,
  hard_at      TEXT,
  deadline     TEXT,
  place        TEXT,
  flexible     INTEGER,
  priority     INTEGER,
  window_start TEXT,
  window_end   TEXT,
  status       TEXT NOT NULL DEFAULT 'planned', -- planned·done·skipped·carried
  done_at      TEXT,
  reminder_id  TEXT,
  event_id     TEXT,
  carried_from TEXT
);
CREATE INDEX idx_plan_items_date ON plan_items (date);
CREATE INDEX idx_plan_items_status ON plan_items (status);
