-- Expand-only provenance for facts. Existing facts retain their historic
-- source/value; code migrates writers and owner-facing ledger in later slices.
-- Nullable columns keep this deploy compatible with Workers that still write
-- the 0001 shape during the migration rollout.

ALTER TABLE facts ADD COLUMN observed_at TEXT;
ALTER TABLE facts ADD COLUMN expires_at TEXT;
ALTER TABLE facts ADD COLUMN review_at TEXT;
ALTER TABLE facts ADD COLUMN supersedes TEXT;

CREATE INDEX idx_facts_expires_at ON facts(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_facts_review_at ON facts(review_at) WHERE review_at IS NOT NULL;
