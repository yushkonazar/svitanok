-- release-phase: expand
-- Owner-confirmed display groups only; original bank records are preserved.
ALTER TABLE finance_settings ADD COLUMN merchant_aliases_json TEXT NOT NULL DEFAULT '{}';
