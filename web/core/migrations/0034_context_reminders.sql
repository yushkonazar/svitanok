-- release-phase: expand
-- Event reminders never invent a clock deadline. D1 owns contexts and receipts.
CREATE TABLE work_contexts (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL, thread_id TEXT NOT NULL, work_date TEXT NOT NULL,
  opened_at TEXT NOT NULL, activated_at TEXT, started_at TEXT, finished_at TEXT,
  confirmation_at TEXT
);
CREATE INDEX idx_work_context_target ON work_contexts(chat_id, thread_id, opened_at);
CREATE TABLE context_reminders (
  id TEXT PRIMARY KEY, context_id TEXT NOT NULL, text TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','awaiting_scope','notified','deferred','done','cancelled')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  delivery_id TEXT, edit_until TEXT
);
CREATE INDEX idx_context_reminders_context ON context_reminders(context_id, status);
CREATE INDEX idx_context_reminders_delivery ON context_reminders(delivery_id);
CREATE TABLE context_deliveries (
  id TEXT PRIMARY KEY, context_id TEXT NOT NULL, snapshot_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_context_deliveries_context ON context_deliveries(context_id);
