-- release-phase: expand
-- Claim a result-card action before asynchronous callback work starts. A second
-- Telegram delivery or rapid double tap must not launch the same action twice.
CREATE TABLE worker_card_actions (
  report_id  TEXT NOT NULL,
  action_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (report_id, action_key)
);
