-- release-phase: expand
-- Flexible actions (for example, meals during a work shift) can have their
-- own calendar block without splitting or excluding the enclosing block.
ALTER TABLE plan_items ADD COLUMN overlap_with_item_id TEXT;
ALTER TABLE plan_items ADD COLUMN not_after TEXT;
ALTER TABLE plan_items ADD COLUMN floating INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_items ADD COLUMN optional INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_items ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_items ADD COLUMN role TEXT;
ALTER TABLE plan_items ADD COLUMN actual_started_at TEXT;
