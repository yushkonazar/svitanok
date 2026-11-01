import { expect, it } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { executeFinanceCommand, readFinanceWorkspace } from '../web/core/finance/workspace.mjs';
import {
  readAnalyticsOperations,
  readFinanceAnalytics,
} from '../web/core/finance/analytics-store.mjs';
import { writeMonoAccounts } from '../web/core/finance/store.mjs';

const NOW = Date.parse('2026-11-01T14:00:00Z');
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0005_finance.sql',
    '0028_mini_app_finance.sql',
    '0029_finance_credit_limits.sql',
    '0030_finance_card_installment.sql',
    '0031_finance_installment_overpayment.sql',
    '0032_finance_interest_method.sql',
    '0033_finance_history_and_links.sql',
    '0035_finance_budget_planning.sql',
    '0041_finance_merchant_aliases.sql',
    '0047_finance_analytics_renewal.sql',
  ]);
  const env = workerEnv({ DB: d1.stub });
  let sequence = 0;
  const command = async (type: string, payload: Record<string, unknown>, at = NOW) => {
    const f = await readFinanceWorkspace(env, at);
    return executeFinanceCommand(
      env,
      { id: `audit-followup-${++sequence}`, version: f.version, type, payload },
      at,
    );
  };
  const add = (
    id: string,
    at: string,
    category: string,
    amount: number,
    raw: Record<string, unknown>,
  ) =>
    d1.db
      .prepare(
        'INSERT INTO transactions(id,at,amount,currency,amount_uah,description,category,flags_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        at,
        amount,
        'UAH',
        amount,
        'Synthetic market',
        category,
        '[]',
        JSON.stringify({ financeKind: 'expense', ...raw }),
      );
  return { d1, env, command, add };
}

it('uses the same partial-day cutoff for previous-period bars and their operations', async () => {
  const { env, add } = setup();
  add('before-cutoff', '2026-10-25T12:00:00Z', 'продукти', -2000, { financeAccount: 'cash' });
  add('after-cutoff', '2026-10-25T18:00:00Z', 'продукти', -9000, { financeAccount: 'cash' });
  const params = new URLSearchParams({ from: '2026-10-26', to: '2026-11-01', account: 'cash' });
  const analytics = await readFinanceAnalytics(env, params, NOW);
  params.set('series', 'previous');
  const operations = await readAnalyticsOperations(env, params, NOW);
  expect(operations.items.map((t) => t.id)).toEqual(['before-cutoff']);
  expect(-operations.items.reduce((n, t) => n + (t.amountUah ?? 0), 0)).toBe(
    analytics.summary.previousExpenseMinor,
  );
});

it('keeps the manual reconciliation timestamp separate from the ledger boundary and still accepts past facts', async () => {
  const { env, command } = setup();
  const before = await readFinanceWorkspace(env, NOW);
  const cash = before.accounts.find((a) => a.id === 'cash')!;
  await command('account-balance', { accountId: 'cash', balanceMinor: 50000 });
  const reconciled = await readFinanceWorkspace(env, NOW);
  expect(reconciled.accounts.find((a) => a.id === 'cash')).toMatchObject({
    asOf: cash.asOf,
    balanceConfirmedAt: new Date(NOW).toISOString(),
    lastMovementAt: new Date(NOW).toISOString(),
    balanceMinor: 50000,
  });
  await command('transaction', {
    kind: 'expense',
    accountId: 'cash',
    amountMinor: 1000,
    category: 'продукти',
    description: 'Synthetic past expense',
    at: '2026-10-31T12:00:00Z',
  });
  const after = await readFinanceWorkspace(env, NOW);
  expect(after.accounts.find((a) => a.id === 'cash')?.asOf).toBe(cash.asOf);
  expect(after.transactions.some((t) => t.at === '2026-10-31T12:00:00.000Z')).toBe(true);
});

it('validates a manual credit limit in its account currency without creating an income', async () => {
  const { env, command } = setup();
  await writeMonoAccounts(
    env,
    [
      {
        id: 'usd',
        currency: 'USD',
        maskedPan: null,
        balanceMinor: 10000,
        creditLimitMinor: 0,
        asOf: new Date(NOW).toISOString(),
      },
    ],
    NOW,
  );
  await expect(
    command('credit-limit', { accountId: 'mono:usd', creditLimitMinor: 20000, currency: 'UAH' }),
  ).rejects.toThrow('Валюта ліміту');
  await command('credit-limit', {
    accountId: 'mono:usd',
    creditLimitMinor: 20000,
    currency: 'USD',
  });
  const f = await readFinanceWorkspace(env, NOW);
  expect(f.accounts.find((a) => a.id === 'mono:usd')).toMatchObject({
    currency: 'USD',
    creditLimitMinor: 20000,
    balanceMinor: -10000,
  });
  expect(f.transactions.filter((t) => t.kind === 'income')).toHaveLength(0);
});

it('uses historical budget membership and identical account/status filters in totals and drill-down', async () => {
  const { env, command, add } = setup();
  await command(
    'budget',
    {
      category: 'Synthetic budget',
      categories: ['продукти'],
      purpose: 'expense',
      period: 'month',
      limitMinor: 100000,
    },
    Date.parse('2026-10-01T10:00:00Z'),
  );
  const first = await readFinanceWorkspace(env, NOW);
  const budget = first.budgets.find((b) => b.category === 'Synthetic budget')!;
  await command(
    'budget',
    {
      budgetId: budget.id,
      category: budget.category,
      categories: ['авто'],
      purpose: 'expense',
      period: 'month',
      limitMinor: 100000,
    },
    Date.parse('2026-10-09T10:00:00Z'),
  );
  add('old-member', '2026-10-06T10:00:00Z', 'продукти', -10000, { financeAccount: 'cash' });
  add('new-member', '2026-10-10T10:00:00Z', 'авто', -20000, { financeAccount: 'cash' });
  add('wrong-account', '2026-10-06T10:00:00Z', 'продукти', -99000, { account: 'card' });
  add('removed-member', '2026-10-10T10:00:00Z', 'продукти', -40000, { financeAccount: 'cash' });
  add('pending', '2026-10-10T11:00:00Z', 'авто', -30000, { financeAccount: 'cash', hold: true });
  const params = new URLSearchParams({
    from: '2026-10-05',
    to: '2026-10-14',
    account: 'cash',
    source: 'manual',
    status: 'confirmed',
  });
  const total = await readFinanceAnalytics(env, params, NOW);
  params.set('budgetId', budget.id);
  const operations = await readAnalyticsOperations(env, params, NOW);
  expect(operations.items.map((t) => t.id).sort()).toEqual(['new-member', 'old-member']);
  expect(-operations.items.reduce((n, t) => n + (t.amountUah ?? 0), 0)).toBe(
    total.budgetAnalysis.find((b) => b.id === budget.id)?.totalMinor,
  );
  expect(total.budgetAnalysis.find((b) => b.id === budget.id)?.totalMinor).toBe(30000);
  params.set('from', '2026-10-10');
  params.set('to', '2026-10-10');
  expect((await readAnalyticsOperations(env, params, NOW)).items.map((t) => t.id)).toEqual([
    'new-member',
  ]);
});
