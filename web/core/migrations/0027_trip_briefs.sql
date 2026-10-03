-- release-phase: expand
-- Чернетки поїздок переживають /new, перерви та інші повідомлення.
-- chat/thread scope задає ядро з автентифікованого прогону, не модель.
CREATE TABLE trip_briefs (
  id           TEXT PRIMARY KEY,
  scope_key    TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_trip_briefs_scope_updated ON trip_briefs (scope_key, status, updated_at DESC);
