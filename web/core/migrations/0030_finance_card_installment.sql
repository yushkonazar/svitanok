-- release-phase: expand
-- Extend the kind constraint, retaining every existing payment and its history.
CREATE TABLE finance_payments_v30 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('subscription','loan','installment','card-installment','bill')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  remaining_minor INTEGER CHECK(remaining_minor >= 0),
  installments_left INTEGER CHECK(installments_left >= 0),
  next_date TEXT NOT NULL,
  anchor_day INTEGER NOT NULL CHECK(anchor_day BETWEEN 1 AND 31),
  recurrence TEXT NOT NULL DEFAULT 'month' CHECK(recurrence IN ('month','year','once')),
  category TEXT NOT NULL,
  remind_days INTEGER NOT NULL DEFAULT 3 CHECK(remind_days BETWEEN 0 AND 30),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','done')),
  total_minor INTEGER CHECK(total_minor >= 0),
  rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(rate_bps BETWEEN 0 AND 30000),
  fee_minor INTEGER NOT NULL DEFAULT 0 CHECK(fee_minor >= 0),
  lender TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO finance_payments_v30 SELECT * FROM finance_payments;
DROP TABLE finance_payments;
ALTER TABLE finance_payments_v30 RENAME TO finance_payments;
