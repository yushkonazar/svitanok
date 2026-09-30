-- release-phase: expand
-- Preserve an explicit owner sequence across drafts and replans.
ALTER TABLE plan_items ADD COLUMN after_item_id TEXT;
