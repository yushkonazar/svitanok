import { expect, it } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { readFinanceWorkspace, executeFinanceCommand } from '../web/core/finance/workspace.mjs';
import { budgetDefinitionAt } from '../web/core/finance/budget-history.mjs';
import { readFinanceAnalytics } from '../web/core/finance/analytics-store.mjs';
import { handleFinance } from '../web/api-finance.mjs';
import { buildInitData } from './helpers/init-data.js';
const now = Date.parse('2026-10-14T15:00:00Z');
function bankTopup(d1: ReturnType<typeof setup>['d1'], id: string, at: string, amount = 40000) {
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
      'Термінал mono',
      'перекази й готівка',
      '[]',
      JSON.stringify({ account: 'one', financeKind: 'unclassified', hold: false }),
    );
}
it('keeps a historical cash topup covered by a later balance assertion without debiting or undo-crediting current cash', async () => {
  const { env, d1 } = setup();
  await executeFinanceCommand(
    env,
    {
      id: 'balance-anchor',
      version: 0,
      type: 'account-balance',
      payload: { accountId: 'cash', balanceMinor: 100000 },
    },
    now - 86400000,
  );
  bankTopup(d1, 'old-bank-credit', '2026-10-12T10:00:00Z');
  await executeFinanceCommand(
    env,
    {
      id: 'old-bank-link',
      version: 1,
      type: 'bank-transfer',
      payload: { transactionId: 'old-bank-credit', accountId: 'cash' },
    },
    now,
  );
  let f = await readFinanceWorkspace(env, now);
  expect(f.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(100000);
  expect(f.transactions.find((t) => t.id === 'bank-transfer:old-bank-link')).toMatchObject({
    at: '2026-10-12T10:00:00Z',
    balanceCoveredBy: 'balance:balance-anchor',
    amountMinor: -40000,
  });
  await executeFinanceCommand(
    env,
    {
      id: 'old-bank-undo',
      version: 2,
      type: 'bank-transfer-undo',
      payload: { transactionId: 'old-bank-credit' },
    },
    now,
  );
  f = await readFinanceWorkspace(env, now);
  expect(f.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(100000);
});
it('repairs only the legacy historical cash leg and preserves a new topup and all bank facts', async () => {
  const { env, d1 } = setup();
  await executeFinanceCommand(
    env,
    {
      id: 'cash-balance-anchor',
      version: 0,
      type: 'account-balance',
      payload: { accountId: 'cash', balanceMinor: 100000 },
    },
    now - 86400000,
  );
  bankTopup(d1, 'legacy-bank', '2026-10-12T10:00:00Z');
  await executeFinanceCommand(
    env,
    {
      id: 'legacy-bank-link',
      version: 1,
      type: 'bank-transfer',
      payload: { transactionId: 'legacy-bank', accountId: 'cash' },
    },
    now,
  );
  d1.db
    .prepare(
      "UPDATE transactions SET raw_json=json_remove(raw_json,'$.financeBalanceCoveredBy') WHERE id=?",
    )
    .run('bank-transfer:legacy-bank-link');
  bankTopup(d1, 'current-bank', '2026-10-14T10:00:00Z', 10000);
  await executeFinanceCommand(
    env,
    {
      id: 'current-bank-link',
      version: 2,
      type: 'bank-transfer',
      payload: { transactionId: 'current-bank', accountId: 'cash' },
    },
    now,
  );
  const beforeBank = d1.db.prepare('SELECT * FROM transactions WHERE id=?').get('legacy-bank');
  expect(
    (await readFinanceWorkspace(env, now)).accounts.find((a) => a.id === 'cash')!.balanceMinor,
  ).toBe(50000);
  const repair = {
    id: 'legacy-cash-repair',
    version: 3,
    type: 'bank-transfer-history-reconcile',
    payload: { transactionIds: ['bank-transfer:legacy-bank-link'] },
  };
  await executeFinanceCommand(env, repair, now + 1000);
  await executeFinanceCommand(env, repair, now + 2000);
  const f = await readFinanceWorkspace(env, now);
  expect(f.version).toBe(4);
  expect(f.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(90000);
  expect(
    f.transactions.find((t) => t.id === 'bank-transfer:current-bank-link')!.balanceCoveredBy,
  ).toBeNull();
  expect(d1.db.prepare('SELECT * FROM transactions WHERE id=?').get('legacy-bank')).toEqual(
    beforeBank,
  );
  expect(f.transactions.find((t) => t.id === 'bank-transfer:legacy-bank-link')!.at).toBe(
    '2026-10-12T10:00:00Z',
  );
});
it('refuses a historical repair when the owner has since asserted a new balance', async () => {
  const { env, d1 } = setup();
  bankTopup(d1, 'older-bank', '2026-10-12T10:00:00Z');
  await executeFinanceCommand(
    env,
    {
      id: 'older-bank-link',
      version: 0,
      type: 'bank-transfer',
      payload: { transactionId: 'older-bank', accountId: 'cash' },
    },
    now,
  );
  await executeFinanceCommand(
    env,
    {
      id: 'new-cash-balance',
      version: 1,
      type: 'account-balance',
      payload: { accountId: 'cash', balanceMinor: 100000 },
    },
    now + 1000,
  );
  await expect(
    executeFinanceCommand(
      env,
      {
        id: 'unsafe-cash-repair',
        version: 2,
        type: 'bank-transfer-history-reconcile',
        payload: { transactionIds: ['bank-transfer:older-bank-link'] },
      },
      now + 2000,
    ),
  ).rejects.toThrow(/Новіша звірка/);
  expect(
    (await readFinanceWorkspace(env, now + 2000)).accounts.find((a) => a.id === 'cash')!
      .balanceMinor,
  ).toBe(100000);
});
it('unlinks a reused manual cash leg without crediting that pre-existing amount again', async () => {
  const { env, d1 } = setup();
  await executeFinanceCommand(
    env,
    {
      id: 'cash-initial',
      version: 0,
      type: 'account-balance',
      payload: { accountId: 'cash', balanceMinor: 100000 },
    },
    now - 86400000,
  );
  const add = d1.db.prepare(
    'INSERT INTO transactions(id,at,amount,currency,amount_uah,description,category,flags_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',
  );
  add.run(
    'manual-leg',
    '2026-10-14T09:00:00Z',
    -40000,
    'UAH',
    -40000,
    'Внесено готівку',
    'перекази й готівка',
    '[]',
    JSON.stringify({ financeKind: 'transfer', financeAccount: 'cash' }),
  );
  add.run(
    'bank-credit',
    '2026-10-14T10:00:00Z',
    40000,
    'UAH',
    40000,
    'Термінал mono',
    'перекази й готівка',
    '[]',
    JSON.stringify({ financeKind: 'unclassified', account: 'one' }),
  );
  await executeFinanceCommand(
    env,
    {
      id: 'reuse-cash-leg',
      version: 1,
      type: 'bank-transfer',
      payload: {
        transactionId: 'bank-credit',
        accountId: 'cash',
        manualTransactionId: 'manual-leg',
      },
    },
    now,
  );
  await executeFinanceCommand(
    env,
    {
      id: 'undo-reused-leg',
      version: 2,
      type: 'bank-transfer-undo',
      payload: { transactionId: 'bank-credit' },
    },
    now,
  );
  const f = await readFinanceWorkspace(env, now);
  expect(f.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(60000);
  expect(f.transactions).toHaveLength(3);
  expect(f.transactions.find((t) => t.id === 'manual-leg')!.reference).toBeNull();
  expect(f.transactions.find((t) => t.id === 'bank-credit')!.reference).toBeNull();
});
it('orders multiple budget edits and removal at the same timestamp without losing a version', async () => {
  const { env } = setup(),
    payload = {
      category: 'Ліміт',
      categories: ['продукти'],
      purpose: 'expense',
      period: 'day',
      limitMinor: 10000,
    };
  await executeFinanceCommand(
    env,
    { id: 'same-time-budget', version: 0, type: 'budget', payload },
    now,
  );
  await executeFinanceCommand(
    env,
    {
      id: 'same-time-update',
      version: 1,
      type: 'budget',
      payload: { ...payload, budgetId: 'same-time-budget', limitMinor: 20000 },
    },
    now,
  );
  let f = await readFinanceWorkspace(env, now);
  expect(f.budgetVersions).toHaveLength(2);
  expect(budgetDefinitionAt(f, 'same-time-budget', '2026-10-14')!.limitMinor).toBe(20000);
  await executeFinanceCommand(
    env,
    {
      id: 'same-time-remove',
      version: 2,
      type: 'budget-remove',
      payload: { budgetId: 'same-time-budget' },
    },
    now,
  );
  f = await readFinanceWorkspace(env, now);
  expect(f.budgetVersions).toHaveLength(3);
  expect(budgetDefinitionAt(f, 'same-time-budget', '2026-10-14')).toBeNull();
});
function setup() {
  const d1 = d1FromSqlite(
    [
      '0001_base.sql',
      '0005_finance.sql',
      '0028_mini_app_finance.sql',
      '0029_finance_credit_limits.sql',
      '0030_finance_card_installment.sql',
      '0031_finance_installment_overpayment.sql',
      '0032_finance_interest_method.sql',
      '0033_finance_history_and_links.sql',
      '0035_finance_budget_planning.sql',
    ],
    { atomicBatch: true },
  );
  return { d1, env: workerEnv({ DB: d1.stub }) };
}
it('authorizes and caches forecast snapshots without changing the ledger or financial version', async () => {
  const { d1 } = setup(),
    env = workerEnv({
      DB: d1.stub,
      TELEGRAM_BOT_TOKEN: 'test-only-token',
      TELEGRAM_OWNER_USER_ID: '123',
    });
  const before = await readFinanceWorkspace(env);
  const headers = { 'X-Telegram-Init-Data': await buildInitData(123, 'test-only-token') };
  const url = 'https://example.test/api/finance?view=forecast&days=7';
  expect((await handleFinance(new Request(url), env)).status).toBe(401);
  for (let i = 0; i < 2; i++) {
    const response = await handleFinance(new Request(url, { headers }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(((await response.json()) as { daily: unknown[] }).daily).toHaveLength(7);
  }
  expect(d1.db.prepare('SELECT COUNT(*) AS n FROM finance_forecast_runs').get()!.n).toBe(1);
  const after = await readFinanceWorkspace(env);
  expect(after.version).toBe(before.version);
  expect(after.transactions).toEqual(before.transactions);
  expect(after.accounts).toEqual(before.accounts);
  expect(
    (await handleFinance(new Request(url.replace('days=7', 'days=999'), { headers }), env)).status,
  ).toBe(400);
});
it('persists display preferences without changing any balance and rejects conflicting edits atomically', async () => {
  const { env } = setup();
  const before = await readFinanceWorkspace(env, now);
  const command = {
    id: 'display-preferences',
    version: 0,
    type: 'display-settings',
    payload: {
      expenseThresholds: [10000, 30000, 90000, 200000],
      currencyCycle: true,
      animations: false,
      savingWeekday: 2,
    },
  };
  await executeFinanceCommand(env, command, now);
  await executeFinanceCommand(env, command, now);
  const after = await readFinanceWorkspace(env, now);
  expect(after.version).toBe(1);
  expect(after.display.expenseThresholds).toHaveLength(4);
  expect(after.display.animations).toBe(false);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.transactions).toEqual(before.transactions);
  await expect(
    executeFinanceCommand(
      env,
      { ...command, id: 'conflicting-display', payload: { expenseThresholds: [5000] } },
      now,
    ),
  ).rejects.toThrow(/змінилися/);
  expect((await readFinanceWorkspace(env, now)).display.expenseThresholds).toHaveLength(4);
});
it('links a terminal credit and undoes it exactly once without creating external income', async () => {
  const { env, d1 } = setup();
  await executeFinanceCommand(
    env,
    {
      id: 'seed-cash-balance',
      version: 0,
      type: 'account-balance',
      payload: { accountId: 'cash', balanceMinor: 100000 },
    },
    now - 86400000,
  );
  d1.db
    .prepare(
      'INSERT INTO transactions(id,at,amount,currency,amount_uah,description,category,flags_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'terminal-credit',
      '2026-10-14T10:00:00Z',
      40000,
      'UAH',
      40000,
      'Термінал mono',
      'перекази й готівка',
      '[]',
      JSON.stringify({ account: 'one', financeKind: 'unclassified', hold: false }),
    );
  const link = {
    id: 'terminal-link',
    version: 1,
    type: 'bank-transfer',
    payload: { transactionId: 'terminal-credit', accountId: 'cash' },
  };
  await executeFinanceCommand(env, link, now);
  await executeFinanceCommand(env, link, now);
  let f = await readFinanceWorkspace(env, now);
  expect(f.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(60000);
  expect(f.transactions.find((t) => t.id === 'terminal-credit')).toMatchObject({
    kind: 'transfer',
    reference: link.id,
  });
  const undo = {
    id: 'terminal-link-undo',
    version: 2,
    type: 'bank-transfer-undo',
    payload: { transactionId: 'terminal-credit' },
  };
  await executeFinanceCommand(env, undo, now);
  await executeFinanceCommand(env, undo, now);
  f = await readFinanceWorkspace(env, now);
  expect(f.version).toBe(3);
  expect(f.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(100000);
  expect(f.transactions.find((t) => t.id === 'terminal-credit')).toMatchObject({
    kind: 'unclassified',
    reference: null,
  });
  expect(f.transactions.filter((t) => t.kind === 'income')).toHaveLength(0);
  const report = await readFinanceAnalytics(
    env,
    new URLSearchParams({ from: '2026-10-13', to: '2026-10-14' }),
    now,
  );
  expect(report.summary.expenseMinor).toBe(0);
});
it('keeps dated budget definitions, unknown old limits and removed versions instead of rewriting the past', async () => {
  const { env } = setup();
  const payload = {
    category: 'Їжа',
    categories: ['продукти'],
    purpose: 'expense',
    period: 'day',
    limitMinor: 35000,
    forecastEnabled: true,
  };
  await executeFinanceCommand(
    env,
    { id: 'food-budget', version: 0, type: 'budget', payload },
    Date.parse('2026-10-10T10:00:00Z'),
  );
  await executeFinanceCommand(
    env,
    {
      id: 'food-budget-update',
      version: 1,
      type: 'budget',
      payload: { ...payload, budgetId: 'food-budget', limitMinor: 40000 },
    },
    now,
  );
  const f = await readFinanceWorkspace(env, now);
  expect(budgetDefinitionAt(f, 'food-budget', '2026-10-09')).toBeNull();
  expect(budgetDefinitionAt(f, 'food-budget', '2026-10-10')!.limitMinor).toBe(35000);
  expect(budgetDefinitionAt(f, 'food-budget', '2026-10-14')!.limitMinor).toBe(40000);
  const analytics = await readFinanceAnalytics(
    env,
    new URLSearchParams({ from: '2026-10-09', to: '2026-10-14' }),
    now,
  );
  expect(analytics.budgetAnalysis[0]!.historyKnown).toBe(false);
  expect(analytics.budgetAnalysis[0]!.points.map((p) => p.planMinor)).toEqual([
    null,
    35000,
    35000,
    35000,
    35000,
    40000,
  ]);
  await executeFinanceCommand(
    env,
    {
      id: 'food-budget-remove',
      version: 2,
      type: 'budget-remove',
      payload: { budgetId: 'food-budget' },
    },
    now + 86400000,
  );
  expect(
    budgetDefinitionAt(
      await readFinanceWorkspace(env, now + 86400000),
      'food-budget',
      '2026-10-15',
    ),
  ).toBeNull();
});
it('emits one completion event after confirmed repayment and acknowledges it without another financial transaction', async () => {
  const { env } = setup();
  await executeFinanceCommand(
    env,
    {
      id: 'final-debt',
      version: 0,
      type: 'payment',
      payload: {
        name: 'Розстрочка',
        kind: 'card-installment',
        totalMinor: 5000,
        remainingMinor: 5000,
        overpaymentTotalMinor: 1000,
        overpaymentRemainingMinor: 1000,
        termMonths: 1,
        installmentsLeft: 1,
        amountMinor: 6000,
        nextDate: '2026-10-14',
        anchorDay: 14,
        recurrence: 'month',
        category: 'розстрочка',
      },
    },
    now,
  );
  const paid = {
    id: 'final-debt-paid',
    version: 1,
    type: 'payment-paid',
    payload: {
      paymentId: 'final-debt',
      accountId: 'cash',
      amountMinor: 6000,
      principalMinor: 5000,
    },
  };
  await executeFinanceCommand(env, paid, now);
  await executeFinanceCommand(env, paid, now);
  const f = await readFinanceWorkspace(env, now);
  expect(f.payments[0]!.status).toBe('done');
  expect(f.events).toHaveLength(1);
  expect(f.events[0]!.data).toMatchObject({
    paidMinor: 6000,
    debtBeforeMinor: 6000,
    debtReducedMinor: 6000,
    monthlyReliefMinor: 6000,
  });
  await executeFinanceCommand(
    env,
    {
      id: 'seen-completion',
      version: 2,
      type: 'event-seen',
      payload: { eventId: f.events[0]!.id },
    },
    now,
  );
  const seen = await readFinanceWorkspace(env, now);
  expect(seen.events[0]!.seenAt).not.toBeNull();
  expect(seen.transactions).toEqual(f.transactions);
  expect(seen.accounts).toEqual(f.accounts);
});
it('starts an edited savings plan at the edit time and preserves that time for a name-only edit', async () => {
  const { env } = setup();
  const payload = {
    name: 'Подорож',
    targetMinor: 2200000,
    planAmountMinor: 350000,
    planPeriod: 'week',
  };
  await executeFinanceCommand(
    env,
    { id: 'travel-goal', version: 0, type: 'goal', payload },
    now - 86400000,
  );
  await executeFinanceCommand(
    env,
    {
      id: 'goal-name-edit',
      version: 1,
      type: 'goal',
      payload: { ...payload, goalId: 'travel-goal', name: 'Інша назва' },
    },
    now,
  );
  expect((await readFinanceWorkspace(env, now)).goals[0]!.planStartedAt).toBe(
    new Date(now - 86400000).toISOString(),
  );
  await executeFinanceCommand(
    env,
    {
      id: 'goal-pace-edit',
      version: 2,
      type: 'goal',
      payload: { ...payload, goalId: 'travel-goal', planAmountMinor: 400000 },
    },
    now,
  );
  expect((await readFinanceWorkspace(env, now)).goals[0]!.planStartedAt).toBe(
    new Date(now).toISOString(),
  );
});
