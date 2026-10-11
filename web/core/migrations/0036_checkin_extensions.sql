-- release-phase: expand
-- Additive, owner-only deadline metadata. No answers, no global schedule changes.
CREATE TABLE checkin_extensions (
  date_key TEXT NOT NULL,
  slot TEXT NOT NULL CHECK(slot IN ('morning','afternoon','evening')),
  schedule_key TEXT NOT NULL,
  base_end TEXT NOT NULL,
  end_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(date_key, slot)
);
