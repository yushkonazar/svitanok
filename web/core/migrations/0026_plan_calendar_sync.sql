-- release-phase: expand
-- A paired plan/Google Calendar edit can outlive one Worker invocation.
-- The scheduler retries rows left pending by a terminated invocation.
ALTER TABLE plan_items ADD COLUMN calendar_sync_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_items ADD COLUMN calendar_sync_pending_at TEXT;
ALTER TABLE plan_items ADD COLUMN calendar_sync_alerted_at TEXT;
CREATE INDEX idx_plan_items_calendar_sync_pending
  ON plan_items (calendar_sync_pending, date);
