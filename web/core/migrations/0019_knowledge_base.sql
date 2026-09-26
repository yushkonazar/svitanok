-- release-phase: expand
-- Narrow personal knowledge base. Documents are explicitly allowlisted one by
-- one; D1 is the source of truth and any future vector index is rebuildable.
-- No Drive-wide discovery or implicit ingestion is introduced by this schema.

CREATE TABLE knowledge_documents (
  id             TEXT PRIMARY KEY,
  source_type    TEXT NOT NULL, -- drive·upload
  source_ref     TEXT NOT NULL, -- Drive file id or immutable upload id
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL, -- cv·job_preparation·learning
  access_scope   TEXT NOT NULL, -- owner
  status         TEXT NOT NULL, -- active·revoked·deleted
  created_at     TEXT NOT NULL,
  revoked_at     TEXT
);
CREATE UNIQUE INDEX idx_knowledge_documents_source ON knowledge_documents(source_type, source_ref);
CREATE INDEX idx_knowledge_documents_status ON knowledge_documents(status, kind);

CREATE TABLE knowledge_document_versions (
  id             TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL,
  source_version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status         TEXT NOT NULL, -- pending·ready·failed·revoked
  extracted_at   TEXT NOT NULL,
  error          TEXT
);
CREATE UNIQUE INDEX idx_knowledge_versions_source ON knowledge_document_versions(document_id, source_version);
CREATE INDEX idx_knowledge_versions_document ON knowledge_document_versions(document_id, status);

CREATE TABLE knowledge_chunks (
  id                  TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL,
  ordinal             INTEGER NOT NULL,
  section             TEXT,
  page                INTEGER,
  text                TEXT NOT NULL,
  vector_id           TEXT,
  projection_status   TEXT NOT NULL DEFAULT 'pending', -- pending·ready·failed·retired
  created_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_knowledge_chunks_ordinal ON knowledge_chunks(document_version_id, ordinal);
CREATE INDEX idx_knowledge_chunks_version ON knowledge_chunks(document_version_id, projection_status);
