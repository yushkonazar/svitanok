-- release-phase: expand
-- Metadata only, never secret values. Each installation has its own dates.
CREATE TABLE credential_metadata (
  id TEXT PRIMARY KEY,
  rotated_at TEXT,
  expires_at TEXT,
  rotate_after_days INTEGER CHECK(rotate_after_days IS NULL OR rotate_after_days BETWEEN 1 AND 3650),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE ops_notices (
  id TEXT PRIMARY KEY,
  claim TEXT NOT NULL,
  at TEXT NOT NULL
);
