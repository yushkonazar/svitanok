-- release-phase: expand
-- Preserve every historical report. NULL status identifies legacy records,
-- whose content is checked by readers rather than silently declared ready.
ALTER TABLE reports ADD COLUMN status TEXT CHECK (status IN ('ready', 'partial', 'failed'));
ALTER TABLE reports ADD COLUMN run_id TEXT;
ALTER TABLE reports ADD COLUMN as_of TEXT;
ALTER TABLE reports ADD COLUMN quality_json TEXT;
ALTER TABLE runs ADD COLUMN weekly_context_json TEXT;
CREATE INDEX idx_reports_weekly_quality ON reports(kind, status, created_at);
