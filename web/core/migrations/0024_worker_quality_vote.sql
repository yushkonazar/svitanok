-- release-phase: expand
-- A saved worker result can have only one explicit owner rating. A partial
-- index makes competing positive/negative taps atomic and idempotent.
CREATE UNIQUE INDEX idx_worker_quality_vote_once
  ON worker_card_actions (report_id)
  WHERE action_key IN ('quality:good', 'quality:bad');
