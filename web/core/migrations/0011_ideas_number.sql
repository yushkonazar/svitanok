-- release-phase: expand
-- Приймання етапу 3 (05.09.2026), дефект B5: номер ідеї для власника був
-- rowid, а SQLite віддає rowid повторно після видалення останнього рядка -
-- нова ідея ставала «#1» слідом за стертою «#1». Тепер номер - власна
-- колонка з монотонного лічильника: counters('ideas') росте лише вгору.

ALTER TABLE ideas ADD COLUMN number INTEGER;

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Наявні ідеї лишають свої rowid-номери; лічильник стартує з найбільшого.
UPDATE ideas SET number = rowid WHERE number IS NULL;
INSERT INTO counters (name, value) SELECT 'ideas', COALESCE(MAX(rowid), 0) FROM ideas;

CREATE UNIQUE INDEX idx_ideas_number ON ideas (number);
