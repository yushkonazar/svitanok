-- release-phase: expand
-- Planning metadata only; existing accounts, transactions and balances are untouched.
ALTER TABLE finance_budgets ADD COLUMN parent_id TEXT;
ALTER TABLE finance_budgets ADD COLUMN goal_id TEXT;
ALTER TABLE finance_budgets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE finance_budgets ADD COLUMN forecast_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE finance_budgets ADD COLUMN template_role TEXT;
ALTER TABLE finance_settings ADD COLUMN forecast_json TEXT NOT NULL DEFAULT '{"incomes":[]}';
CREATE INDEX finance_budget_parent ON finance_budgets(parent_id);
UPDATE finance_budgets SET forecast_enabled = 1
WHERE category IN ('Основні витрати','Бажання','Заощадження')
OR NOT EXISTS (SELECT 1 FROM finance_budgets WHERE category IN ('Основні витрати','Бажання','Заощадження'));
UPDATE finance_budgets SET template_role = CASE category WHEN 'Основні витрати' THEN 'needs' WHEN 'Бажання' THEN 'wants' WHEN 'Заощадження' THEN 'saving' END WHERE period = 'month';
