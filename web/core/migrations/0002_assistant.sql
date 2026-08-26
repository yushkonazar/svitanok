-- Нагадування, пропозиції (T1/T2), ланцюги, вихідна черга Telegram.

CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,
  due_at        TEXT NOT NULL,
  text          TEXT NOT NULL,
  chain_id      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending·sent·snoozed·done·cancelled
  snooze_count  INTEGER NOT NULL DEFAULT 0,
  source_msg_id TEXT
);
CREATE INDEX idx_reminders_status_due ON reminders (status, due_at);

CREATE TABLE proposals (
  id           TEXT PRIMARY KEY,
  level        TEXT NOT NULL, -- T1·T2
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  thread_id    TEXT,
  msg_id       INTEGER,
  word         TEXT, -- лише T2
  expires_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open', -- open·approved·rejected·expired
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);
CREATE INDEX idx_proposals_status_expires ON proposals (status, expires_at);

CREATE TABLE chains (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL, -- table·trip·price·idea·inbox-export
  workflow_id TEXT,
  state_json  TEXT,
  status      TEXT NOT NULL, -- running·waiting·done·failed·cancelled
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_chains_status ON chains (status);

CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  thread_id    TEXT,
  kind         TEXT NOT NULL, -- send·edit·document·contact·venue
  payload_json TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      TEXT,
  status       TEXT NOT NULL
);
CREATE INDEX idx_outbox_status_next ON outbox (status, next_at);
