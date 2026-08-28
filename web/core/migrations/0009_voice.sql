-- Голос (етап 2 PR-4, ADR-040): стан між повідомленням із кнопками v: і тапом.
-- callback_data ≤ 64 байт не вміщає ні транскрипт («Я почув» ✅/✏️), ні
-- file_id Telegram (~80+ символів, «Розпізнати» для довгого голосового) -
-- «усе інше - у D1» (07 §9). Аудіо НЕ зберігається (ADR-010): лише транскрипт
-- або посилання-file_id, обидва живуть ≤ 5 хв (транскрипт - команда, а не
-- пропозиція: підтверджений через півгодини «стоп» обірвав би чужий прогін).

CREATE TABLE voice_pending (
  id         TEXT PRIMARY KEY,          -- короткий id для v:<id>:<choice>
  kind       TEXT NOT NULL,             -- transcript·file
  text       TEXT,                      -- kind=transcript: розпізнаний текст
  file_id    TEXT,                      -- kind=file: чекає «Розпізнати»
  duration_s INTEGER NOT NULL DEFAULT 0,
  chat_id    TEXT,
  thread_id  TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT                       -- тап у роботі; NULL = вільний (CAS)
);
CREATE INDEX idx_voice_pending_created ON voice_pending (created_at);
