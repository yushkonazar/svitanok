-- release-phase: expand
-- Separate the agreed surcharge from principal; legacy contracts remain unchanged.
ALTER TABLE finance_payments ADD COLUMN overpayment_total_minor INTEGER CHECK(overpayment_total_minor >= 0);
ALTER TABLE finance_payments ADD COLUMN overpayment_remaining_minor INTEGER CHECK(overpayment_remaining_minor >= 0);
ALTER TABLE finance_payments ADD COLUMN overpayment_paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(overpayment_paid_minor >= 0);
ALTER TABLE finance_payments ADD COLUMN term_months INTEGER CHECK(term_months BETWEEN 1 AND 1200);
