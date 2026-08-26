-- Конвенції (07-schema §1): id TEXT PRIMARY KEY (ulid), час — ISO-8601 UTC у
-- TEXT, гроші — INTEGER у мінімальних одиницях + currency TEXT, JSON — TEXT
-- (json_valid перевіряє код). Без FOREIGN KEY: цілісність веде код ядра, а
-- значення-переліки (status, kind) валідуються на межі запису, не CHECK-ами —
-- розширення переліку в SQLite інакше вимагало б перебудови таблиці.

CREATE TABLE facts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL, -- profile·habit·contact·place·vehicle·setting·inferred
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source     TEXT NOT NULL, -- owner·inferred
  confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, key)
);

CREATE TABLE sessions (
  thread_id      TEXT PRIMARY KEY,
  sdk_session_id TEXT,
  started_at     TEXT,
  last_at        TEXT,
  tainted        INTEGER NOT NULL DEFAULT 0,
  summary_md     TEXT,
  turn_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memory_chunks (
  id        TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  at        TEXT NOT NULL,
  text      TEXT NOT NULL,
  vector_id TEXT
);
CREATE INDEX idx_memory_chunks_thread_at ON memory_chunks (thread_id, at);

-- Канонічний журнал за 07 §1. Wrangler веде власну d1_migrations; цю таблицю
-- заповнює код, коли /status звітує про стан схеми.
CREATE TABLE migrations_meta (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
