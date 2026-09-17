-- Rebuildable D1 → Vectorize projection for memory. D1 keeps every staging
-- state; Vectorize is never the source of truth. A failed upsert therefore
-- leaves a repairable pending/failed version while the last ready version
-- remains searchable.

ALTER TABLE memory_chunks ADD COLUMN projection_version TEXT NOT NULL DEFAULT 'legacy-v0';
ALTER TABLE memory_chunks ADD COLUMN projection_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE memory_chunks ADD COLUMN indexed_at TEXT;

CREATE INDEX idx_memory_chunks_projection ON memory_chunks(projection_status, thread_id);

CREATE TABLE memory_projection_versions (
  thread_id      TEXT NOT NULL,
  version        TEXT NOT NULL,
  status         TEXT NOT NULL, -- pending·indexed·ready·failed·retired
  chunk_count    INTEGER NOT NULL,
  embedding_model TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  indexed_at     TEXT,
  ready_at       TEXT,
  error          TEXT,
  PRIMARY KEY (thread_id, version)
);
CREATE INDEX idx_memory_projection_versions_status
  ON memory_projection_versions(status, created_at);

-- The previous writer had one current generation per thread. Preserve it as
-- ready during rollout; explicit rebuild/reconciliation can re-index it later.
INSERT INTO memory_projection_versions (
  thread_id, version, status, chunk_count, embedding_model, created_at, indexed_at, ready_at
)
SELECT thread_id, 'legacy-v0', 'ready', COUNT(*), '@cf/baai/bge-m3', MIN(at), MAX(at), MAX(at)
FROM memory_chunks
GROUP BY thread_id;
