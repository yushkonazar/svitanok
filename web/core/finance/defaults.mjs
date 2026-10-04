// Shared neutral defaults after restoring an older backup or erasing owner data.
// No balances, transactions, goals or other owner-entered data are recreated.
export const FINANCE_DEFAULT_SQL = [
  "INSERT OR IGNORE INTO finance_settings(id, updated_at) VALUES('owner', datetime('now'))",
  "INSERT OR IGNORE INTO finance_accounts(id,name,kind,opening_at,created_at) VALUES('cash','Готівка','cash','1970-01-01T00:00:00.000Z',datetime('now'))",
  "INSERT OR IGNORE INTO finance_taxi_policies(id,effective_at,fare_bps,commission_bps,fuel_bps,threshold_minor,bonus_fare_bps,created_at) VALUES('initial','1970-01-01T00:00:00.000Z',5000,5000,5000,2700000,5500,datetime('now'))",
];
