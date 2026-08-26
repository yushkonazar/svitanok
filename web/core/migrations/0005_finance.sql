-- Гроші: транзакції Mono, підписки, правила мерчантів.

CREATE TABLE transactions (
  id          TEXT PRIMARY KEY, -- id транзакції Mono
  at          TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  amount_uah  INTEGER,
  mcc         INTEGER,
  description TEXT,
  category    TEXT,
  flags_json  TEXT, -- new_merchant·over_threshold·duplicate·foreign·subscription
  balance     INTEGER,
  note        TEXT,
  raw_json    TEXT
);
CREATE INDEX idx_transactions_at ON transactions (at);
CREATE INDEX idx_transactions_category ON transactions (category);

CREATE TABLE subscriptions (
  id         TEXT PRIMARY KEY,
  merchant   TEXT NOT NULL,
  period     TEXT, -- month·year
  amount     INTEGER,
  currency   TEXT,
  next_at    TEXT,
  last_tx_id TEXT,
  status     TEXT NOT NULL DEFAULT 'active', -- active·paused·cancelled
  created_at TEXT NOT NULL
);
CREATE INDEX idx_subscriptions_next ON subscriptions (next_at);

CREATE TABLE merchant_rules (
  id              TEXT PRIMARY KEY,
  pattern         TEXT NOT NULL,
  category        TEXT,
  is_subscription INTEGER,
  note            TEXT
);
