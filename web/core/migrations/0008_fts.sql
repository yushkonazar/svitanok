-- release-phase: expand
-- FTS5 (проба пройдена на віддаленій D1 26.08.2026: unicode-токенізатор
-- знаходить українські слова). Таблиці standalone, а не content=: синхронізацію
-- веде код разом із записом у базову таблицю (етапи 3+), і повторна індексація
-- при розбіжності — просто DELETE + INSERT. Колонка id UNINDEXED — місток до
-- TEXT-ключів базових таблиць: rowid FTS із ними не звʼязаний.

CREATE VIRTUAL TABLE ideas_fts USING fts5(id UNINDEXED, title, body_md);

CREATE VIRTUAL TABLE inbox_fts USING fts5(id UNINDEXED, text);

CREATE VIRTUAL TABLE records_fts USING fts5(id UNINDEXED, data_text);
