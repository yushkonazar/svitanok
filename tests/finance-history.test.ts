import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { executeFinanceCommand, readFinanceWorkspace } from '../web/core/finance/workspace.mjs';
import { buildFinanceReport, validateReportRange } from '../web/core/finance/reporting.mjs';
import { nextPaymentDate, calculateTaxiWeek } from '../web/core/finance/planning.mjs';
import { writeMonoAccounts } from '../web/core/finance/store.mjs';
const NOW = Date.parse('2026-10-08T15:00:00Z');
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
  ]);
  const env = workerEnv({ DB: d1.stub });
  let sequence = 0;
  const send = async (type: string, payload: Record<string, unknown>) =>
    executeFinanceCommand(
      env,
      {
        id: `history-command-${++sequence}`,
        version: (await readFinanceWorkspace(env, NOW)).version,
        type,
        payload,
      },
      NOW,
    );
  const bank = async (id: string, amount: number, at = '2026-10-08T12:00:00Z', hold = false) => {
    await writeMonoAccounts(
      env,
      [
        {
          id: 'card',
          currency: 'UAH',
          maskedPan: null,
          balanceMinor: 1000000,
          creditLimitMinor: 0,
          asOf: new Date(NOW).toISOString(),
        },
      ],
      NOW,
    );
    d1.db
      .prepare(
        'INSERT INTO transactions(id,at,amount,currency,amount_uah,category,description,raw_json,flags_json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        at,
        amount,
        'UAH',
        amount,
        'перекази й готівка',
        'Переказ',
        JSON.stringify({ account: 'card', hold }),
        '[]',
      );
  };
  const shift = () =>
    send('taxi-entry', {
      at: '2026-09-30T19:00:00Z',
      accountId: 'cash',
      netCashMinor: 400000,
      commissionMinor: 70000,
      fuelMinor: 100000,
      receivedCashMinor: 260000,
      tipsMinor: 0,
    });
  return { d1, env, send, bank, shift };
}
describe('finance history, actual settlements and linked transfers', () => {
  it('stores actual fleet payment, changes cash once, keeps formula and edits only the difference', async () => {
    const { env, send, shift } = setup();
    await shift();
    const before = await readFinanceWorkspace(env, NOW);
    expect(before.taxiWeeks[0]).toMatchObject({
      netCashMinor: 400000,
      grossMinor: 470000,
      earnedMinor: 150000,
      heldMinor: 260000,
      settlementMinor: -110000,
    });
    await send('taxi-settle', {
      weekKey: '2026-09-28',
      accountId: 'cash',
      amountMinor: -190000,
      note: 'Фактичний розрахунок парку',
    });
    const paid = await readFinanceWorkspace(env, NOW);
    expect(paid.accounts[0]!.balanceMinor).toBe(70000);
    expect(paid.reserveMinor).toBe(0);
    expect(paid.taxiWeeks[0]).toMatchObject({
      actualSettlementMinor: -190000,
      expectedSettlementMinor: -110000,
      settlementDifferenceMinor: -80000,
      settled: true,
    });
    await send('taxi-settlement-edit', {
      weekKey: '2026-09-28',
      amountMinor: -180000,
      note: 'Уточнення',
    });
    const edited = await readFinanceWorkspace(env, NOW);
    expect(edited.accounts[0]!.balanceMinor).toBe(80000);
    expect(edited.settlements[0]).toMatchObject({
      expectedMinor: -110000,
      amountMinor: -180000,
      note: 'Уточнення',
    });
    expect(
      buildFinanceReport(edited, '2026-10-08', '2026-10-08', NOW).settlementDifferenceMinor,
    ).toBe(-70000);
    await expect(
      send('taxi-settle', { weekKey: '2026-09-28', accountId: 'cash', amountMinor: -180000 }),
    ).rejects.toThrow(/розрахований/);
  });
  it('links an actual bank settlement differing from formula without adding a bank or cash posting', async () => {
    const { env, send, shift, bank } = setup();
    await shift();
    await bank('bank-settled', -190000);
    await send('taxi-settle', {
      weekKey: '2026-09-28',
      transactionId: 'bank-settled',
      amountMinor: -190000,
    });
    const f = await readFinanceWorkspace(env, NOW);
    expect(f.transactions).toHaveLength(2);
    expect(f.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(260000);
    expect(f.settlements[0]!.transactionId).toBe('bank-settled');
    await expect(
      send('taxi-settlement-edit', { weekKey: '2026-09-28', amountMinor: -170000 }),
    ).rejects.toThrow(/Банківський/);
  });
  it('links bank deposit to one cash debit, blocks reuse, and idempotent replay cannot duplicate', async () => {
    const { env, send, bank } = setup();
    await send('account-balance', { accountId: 'cash', balanceMinor: 400000 });
    await bank('deposit-on-card', 200000);
    const command = {
      id: 'linked-cash-bank',
      version: (await readFinanceWorkspace(env, NOW)).version,
      type: 'bank-transfer',
      payload: { transactionId: 'deposit-on-card', accountId: 'cash' },
    };
    await executeFinanceCommand(env, command, NOW);
    await executeFinanceCommand(env, command, NOW);
    const f = await readFinanceWorkspace(env, NOW);
    expect(f.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(200000);
    expect(f.transactions.filter((t) => t.kind === 'transfer')).toHaveLength(2);
    expect(f.transactions.filter((t) => t.id === 'deposit-on-card')).toHaveLength(1);
    expect(buildFinanceReport(f, '2026-10-08', '2026-10-08', NOW)).toMatchObject({
      otherIncomeMinor: 0,
      expenseMinor: 0,
    });
    await expect(send('bank-transfer', command.payload)).rejects.toThrow(/непов’язаний/);
  });
  it('rejects bank holds, foreign currencies and dates before manual opening', async () => {
    const { env, d1, send, bank } = setup();
    await bank('pending-card', 200000, undefined, true);
    await expect(
      send('bank-transfer', { transactionId: 'pending-card', accountId: 'cash' }),
    ).rejects.toThrow(/завершений/);
    await bank('future-card', 200000, '2026-10-09T12:00:00Z');
    await expect(
      send('bank-transfer', { transactionId: 'future-card', accountId: 'cash' }),
    ).rejects.toThrow(/переказ/);
    await bank('foreign-card', 200000);
    d1.db.prepare("UPDATE transactions SET currency='USD' WHERE id='foreign-card'").run();
    await expect(
      send('bank-transfer', { transactionId: 'foreign-card', accountId: 'cash' }),
    ).rejects.toThrow(/завершений/);
    await send('account', { name: 'Новий рахунок', kind: 'bank', openingMinor: 0 });
    const f = await readFinanceWorkspace(env, NOW);
    await bank('old-card', 200000, '2026-10-07T12:00:00Z');
    await expect(
      send('bank-transfer', {
        transactionId: 'old-card',
        accountId: f.accounts.find((a) => a.name === 'Новий рахунок')!.id,
      }),
    ).rejects.toThrow(/дату/);
  });
  it('plans weekly goals and keeps virtual reservation separate from actual cash and bank contributions', async () => {
    const { env, send, bank } = setup();
    await send('account-balance', { accountId: 'cash', balanceMinor: 400000 });
    await send('goal', {
      name: 'Банка',
      targetMinor: 1000000,
      planAmountMinor: 50000,
      planPeriod: 'week',
    });
    let f = await readFinanceWorkspace(env, NOW);
    const goalId = f.goals[0]!.id;
    expect(f.goals[0]).toMatchObject({ planAmountMinor: 50000, planPeriod: 'week' });
    await send('goal-move', {
      goalId,
      accountId: 'cash',
      amountMinor: 50000,
      movementKind: 'reserve',
    });
    expect((await readFinanceWorkspace(env, NOW)).accounts[0]!.balanceMinor).toBe(400000);
    await send('goal-move', {
      goalId,
      accountId: 'cash',
      amountMinor: 70000,
      movementKind: 'external',
    });
    expect((await readFinanceWorkspace(env, NOW)).accounts[0]!.balanceMinor).toBe(330000);
    await expect(
      send('goal-move', {
        goalId,
        accountId: 'cash',
        amountMinor: -70001,
        movementKind: 'external',
      }),
    ).rejects.toThrow(/повернути/);
    await bank('jar-funded', -30000);
    await send('goal-move', { goalId, transactionId: 'jar-funded', amountMinor: 30000 });
    f = await readFinanceWorkspace(env, NOW);
    expect(f.goalMoves).toHaveLength(3);
    expect(f.goalMoves.reduce((n, m) => n + m.amountMinor, 0)).toBe(150000);
    expect(f.transactions.filter((t) => t.bank)).toHaveLength(1);
    expect(f.transactions.find((t) => t.id === 'jar-funded')).toMatchObject({
      kind: 'transfer',
      reference: `goal:${goalId}`,
    });
    await expect(
      send('goal-move', { goalId, transactionId: 'jar-funded', amountMinor: 30000 }),
    ).rejects.toThrow(/непов’язану/);
    await expect(
      send('bank-transfer', { transactionId: 'jar-funded', accountId: 'cash' }),
    ).rejects.toThrow(/непов’язаний/);
    await send('goal-move', {
      goalId,
      accountId: 'cash',
      amountMinor: -20000,
      movementKind: 'external',
    });
    expect((await readFinanceWorkspace(env, NOW)).accounts[0]!.balanceMinor).toBe(350000);
  });
  it('advances weekly and daily payments across months and DST without treating them as monthly', async () => {
    const { env, send } = setup();
    await send('payment', {
      name: 'Тижневий платіж',
      kind: 'bill',
      amountMinor: 5000,
      nextDate: '2026-10-08',
      anchorDay: 8,
      recurrence: 'week',
      category: 'дім',
    });
    const p = (await readFinanceWorkspace(env, NOW)).payments[0]!;
    expect(p.recurrence).toBe('week');
    await send('payment-paid', { paymentId: p.id, accountId: 'cash', amountMinor: 5000 });
    expect((await readFinanceWorkspace(env, NOW)).payments[0]!.nextDate).toBe('2026-10-15');
    expect(nextPaymentDate('2026-10-24', 24, 'week')).toBe('2026-10-31');
    expect(nextPaymentDate('2026-01-31', 31, 'day')).toBe('2026-02-01');
  });
  it('loads older retained transactions only for the requested range and excludes transfers', async () => {
    const { env, d1 } = setup();
    d1.db
      .prepare(
        "INSERT INTO transactions(id,at,amount,currency,amount_uah,category,raw_json,flags_json) VALUES('old-expense','2026-05-03T12:00:00Z',-15000,'UAH',-15000,'продукти','{}','[]')",
      )
      .run();
    expect((await readFinanceWorkspace(env, NOW)).transactions).toHaveLength(0);
    const f = await readFinanceWorkspace(env, NOW, { from: '2026-05-01', to: '2026-05-31' });
    const report = buildFinanceReport(f, '2026-05-01', '2026-05-31', NOW);
    expect(report.expenseMinor).toBe(15000);
    expect(report.categories).toEqual([{ category: 'продукти', amountMinor: 15000, count: 1 }]);
    expect(report.daily).toHaveLength(31);
    expect(() => validateReportRange('2026-02-30', '2026-03-03', NOW)).toThrow();
    expect(() => validateReportRange('2026-10-09', '2026-10-09', NOW)).toThrow();
    expect(() => validateReportRange('2026-10-08', '2026-10-01', NOW)).toThrow();
    expect(() => validateReportRange('2024-01-01', '2026-01-01', NOW)).toThrow();
  });
  it('uses whole-week threshold in a partial date report and matches the confirmed 50/55 formulas', () => {
    const policy = {
      id: 'p',
      effectiveAt: '1970-01-01T00:00:00Z',
      fareBps: 5000,
      commissionBps: 5000,
      fuelBps: 5000,
      tipsBps: 5000,
      thresholdMinor: 2700000,
      bonusFareBps: 5500,
    };
    const first = {
      id: 'day1',
      at: '2026-09-29T18:00:00Z',
      policyId: 'p',
      netCashMinor: 400000,
      commissionMinor: 70000,
      fuelMinor: 100000,
      tipsMinor: 0,
      directMinor: 0,
    };
    expect(calculateTaxiWeek([first], [policy], Date.parse(first.at)).earnedMinor).toBe(150000);
    const more = {
      ...first,
      id: 'day2',
      at: '2026-09-30T18:00:00Z',
      netCashMinor: 2300000,
      commissionMinor: 0,
      fuelMinor: 0,
    };
    const report = buildFinanceReport(
      {
        taxiEntries: [first, more],
        policies: [policy],
        transactions: [],
        settlements: [],
        goalMoves: [],
      },
      '2026-09-29',
      '2026-09-29',
      NOW,
    );
    expect(report.taxiEarnedMinor).toBe(173500);
    expect(report.taxiWeeks[0]!.grossMinor).toBe(2770000);
  });
});

it('allocates rounded taxi kopecks consistently between adjacent daily reports', () => {
  const policy = {
    id: 'p',
    effectiveAt: '1970-01-01T00:00:00Z',
    fareBps: 5000,
    commissionBps: 5000,
    fuelBps: 5000,
    tipsBps: 5000,
    thresholdMinor: null,
    bonusFareBps: 5000,
  };
  const entry = {
    id: 'first',
    at: '2026-09-29T18:00:00Z',
    policyId: 'p',
    netCashMinor: 1,
    commissionMinor: 0,
    fuelMinor: 0,
    tipsMinor: 0,
    directMinor: 0,
  };
  const state = {
    taxiEntries: [entry, { ...entry, id: 'second', at: '2026-09-30T18:00:00Z' }],
    policies: [policy],
    transactions: [],
    settlements: [],
    goalMoves: [],
  };
  const first = buildFinanceReport(state, '2026-09-29', '2026-09-29', NOW);
  const second = buildFinanceReport(state, '2026-09-30', '2026-09-30', NOW);
  const full = buildFinanceReport(state, '2026-09-29', '2026-09-30', NOW);
  expect(first.taxiEarnedMinor + second.taxiEarnedMinor).toBe(full.taxiEarnedMinor);
  expect(full.taxiEarnedMinor).toBe(1);
});
