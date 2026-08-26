-- Business-чати (вхідні) і колекції власника.

CREATE TABLE inbox_messages (
  id         TEXT PRIMARY KEY, -- chat_id:msg_id
  chat_id    TEXT,
  chat_title TEXT,
  from_name  TEXT,
  from_id    TEXT,
  at         TEXT,
  text       TEXT,
  media_kind TEXT,
  reply_to   TEXT,
  tainted    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_inbox_messages_chat_at ON inbox_messages (chat_id, at);

CREATE TABLE inbox_digests (
  id           TEXT PRIMARY KEY,
  chat_ids_json TEXT,
  period_from  TEXT,
  period_to    TEXT,
  text_md      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_inbox_digests_created ON inbox_digests (created_at);

CREATE TABLE collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  fields_json TEXT NOT NULL,
  sort_by     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE records (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  data_json     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_records_collection_created ON records (collection_id, created_at);
