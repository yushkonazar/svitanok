-- release-phase: expand
-- Preserve explicit timing language from the owner's plan. These fields are
-- constraints for the deterministic scheduler, not generated schedule output.

ALTER TABLE plan_items ADD COLUMN hard_end TEXT;
ALTER TABLE plan_items ADD COLUMN not_before TEXT;
