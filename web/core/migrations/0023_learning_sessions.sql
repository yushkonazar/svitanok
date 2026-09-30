-- release-phase: expand
-- A tutor question belongs to one thread and survives /new and process restarts.
-- Ratings are the owner's difficulty assessment, not a correctness verdict.
CREATE TABLE learning_sessions (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  topic         TEXT NOT NULL,
  question_text TEXT NOT NULL,
  answer_text   TEXT,
  review_text   TEXT,
  status        TEXT NOT NULL,
  rating        TEXT,
  due_at        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_learning_sessions_thread_status ON learning_sessions (thread_id, chat_id, status, updated_at);
