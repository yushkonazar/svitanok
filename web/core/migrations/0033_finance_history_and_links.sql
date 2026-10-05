-- release-phase: expand
-- Additive, compatible with the previous worker; never rewrite existing balances.
ALTER TABLE finance_taxi_settlements ADD COLUMN expected_minor INTEGER;
ALTER TABLE finance_taxi_settlements ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE finance_goals ADD COLUMN plan_amount_minor INTEGER CHECK(plan_amount_minor >= 0);
ALTER TABLE finance_goals ADD COLUMN plan_period TEXT CHECK(plan_period IN ('day','week','month'));
ALTER TABLE finance_goal_moves ADD COLUMN movement_kind TEXT NOT NULL DEFAULT 'reserve' CHECK(movement_kind IN ('reserve','external'));
ALTER TABLE finance_goal_moves ADD COLUMN bank_tx_id TEXT;
CREATE UNIQUE INDEX finance_goal_bank_move ON finance_goal_moves(bank_tx_id) WHERE bank_tx_id IS NOT NULL;
-- Keep the old monthly/yearly constraint intact; extra intervals override it on reads.
ALTER TABLE finance_payments ADD COLUMN interval_period TEXT CHECK(interval_period IN ('day','week'));
