-- release-phase: expand
-- NULL preserves historical rows: a date remains a date; no date remains unknown.
-- Non-expiring is an explicit owner assertion, never inferred from a missing date.
ALTER TABLE credential_metadata ADD COLUMN expiry_kind TEXT
  CHECK(expiry_kind IS NULL OR expiry_kind IN ('unknown','date','non-expiring'));
