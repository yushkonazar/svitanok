-- release-phase: expand
-- Existing pending audio has no proven first-party origin. Default to false.
ALTER TABLE voice_pending ADD COLUMN owner_composed INTEGER NOT NULL DEFAULT 0 CHECK(owner_composed IN (0, 1));
