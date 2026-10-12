-- release-phase: expand
-- One owner workspace, shared by Mini App and assistant. No view/GPS tracking.
CREATE TABLE IF NOT EXISTS leisure_items (
  id TEXT PRIMARY KEY, venue_id TEXT, category TEXT NOT NULL,
  start_date TEXT, end_date TEXT, data_json TEXT NOT NULL, checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leisure_items_dates ON leisure_items(start_date, end_date);
CREATE INDEX IF NOT EXISTS leisure_items_venue ON leisure_items(venue_id);
CREATE TABLE IF NOT EXISTS leisure_editions (
  week TEXT PRIMARY KEY, data_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leisure_records (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, item_id TEXT, venue_id TEXT,
  at TEXT, data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL, sync_claim_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS leisure_records_kind ON leisure_records(kind, at);
CREATE INDEX IF NOT EXISTS leisure_records_item ON leisure_records(item_id, kind);
CREATE TABLE IF NOT EXISTS leisure_commands (
  id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL
);
