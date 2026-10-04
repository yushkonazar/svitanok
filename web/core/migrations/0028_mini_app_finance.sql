-- release-phase: expand
-- Existing Monobank transactions remain the authoritative bank ledger.
CREATE TABLE finance_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cash','bank','mono')),
  currency TEXT NOT NULL DEFAULT 'UAH',
  opening_minor INTEGER NOT NULL DEFAULT 0,
  opening_at TEXT NOT NULL,
  mono_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE finance_settings (
  id TEXT PRIMARY KEY CHECK(id = 'owner'),
  version INTEGER NOT NULL DEFAULT 0,
  income_period TEXT NOT NULL DEFAULT 'week' CHECK(income_period IN ('week','month')),
  taxi_visible INTEGER NOT NULL DEFAULT 1,
  payment_reminders INTEGER NOT NULL DEFAULT 1,
  checkin_reminders INTEGER NOT NULL DEFAULT 1,
  categories_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE finance_taxi_policies (
  id TEXT PRIMARY KEY,
  effective_at TEXT NOT NULL UNIQUE,
  fare_bps INTEGER NOT NULL CHECK(fare_bps BETWEEN 0 AND 10000),
  commission_bps INTEGER NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),
  fuel_bps INTEGER NOT NULL CHECK(fuel_bps BETWEEN 0 AND 10000),
  threshold_minor INTEGER CHECK(threshold_minor >= 0),
  bonus_fare_bps INTEGER NOT NULL CHECK(bonus_fare_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL
);
CREATE TABLE finance_taxi_entries (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  policy_id TEXT NOT NULL REFERENCES finance_taxi_policies(id),
  net_cash_minor INTEGER NOT NULL DEFAULT 0 CHECK(net_cash_minor >= 0),
  commission_minor INTEGER NOT NULL DEFAULT 0 CHECK(commission_minor >= 0),
  commission_reported INTEGER NOT NULL DEFAULT 1,
  cash_reported INTEGER NOT NULL DEFAULT 1,
  fuel_minor INTEGER NOT NULL DEFAULT 0 CHECK(fuel_minor >= 0),
  tips_minor INTEGER NOT NULL DEFAULT 0 CHECK(tips_minor >= 0),
  direct_minor INTEGER NOT NULL DEFAULT 0 CHECK(direct_minor >= 0),
  received_cash_minor INTEGER NOT NULL DEFAULT 0 CHECK(received_cash_minor >= 0),
  paid_work_minor INTEGER NOT NULL DEFAULT 0 CHECK(paid_work_minor >= 0),
  account_id TEXT REFERENCES finance_accounts(id),
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX finance_taxi_at ON finance_taxi_entries(at);
CREATE TABLE finance_goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_minor INTEGER NOT NULL CHECK(target_minor > 0),
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','done')),
  created_at TEXT NOT NULL
);
CREATE TABLE finance_goal_moves (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES finance_goals(id),
  account_id TEXT NOT NULL REFERENCES finance_accounts(id),
  amount_minor INTEGER NOT NULL,
  at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX finance_goal_moves_goal ON finance_goal_moves(goal_id);
CREATE TABLE finance_budgets (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  categories_json TEXT NOT NULL DEFAULT '[]',
  purpose TEXT NOT NULL DEFAULT 'expense' CHECK(purpose IN ('expense','saving')),
  period TEXT NOT NULL CHECK(period IN ('day','week','month')),
  limit_minor INTEGER CHECK(limit_minor >= 0),
  share_bps INTEGER CHECK(share_bps BETWEEN 0 AND 10000),
  income_base_minor INTEGER CHECK(income_base_minor >= 0),
  created_at TEXT NOT NULL,
  CHECK((limit_minor IS NOT NULL) != (share_bps IS NOT NULL)),
  UNIQUE(category, period)
);
CREATE TABLE finance_payments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('subscription','loan','installment','bill')),
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
CREATE TABLE finance_commands (
  id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE finance_notices (
  id TEXT PRIMARY KEY,
  claim TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE finance_taxi_settlements (
  id TEXT PRIMARY KEY,
  week_key TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES finance_accounts(id),
  at TEXT NOT NULL,
  bank_tx_id TEXT UNIQUE
);
INSERT INTO finance_settings(id, updated_at) VALUES('owner', datetime('now'));
INSERT INTO finance_accounts(id, name, kind, opening_at, created_at)
VALUES('cash', 'Готівка', 'cash', '1970-01-01T00:00:00.000Z', datetime('now'));
INSERT INTO finance_taxi_policies(id, effective_at, fare_bps, commission_bps, fuel_bps, threshold_minor, bonus_fare_bps, created_at)
VALUES('initial', '1970-01-01T00:00:00.000Z', 5000, 5000, 5000, 2700000, 5500, datetime('now'));
