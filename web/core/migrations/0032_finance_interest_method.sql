-- release-phase: expand
-- Existing bank schedules retain their explicit principal confirmation.
ALTER TABLE finance_payments ADD COLUMN interest_method TEXT CHECK(interest_method IN ('annuity','declining','flat'));
