import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { readWeeklyFinance } from '../web/core/brain/weekly-finance.mjs';
import { runFinanceQuery } from '../web/core/tools/finance.mjs';
import { summarize } from '../web/core/finance/query.mjs';
import { readFinanceWorkspace } from '../web/core/finance/workspace.mjs';
import { financeReviewContext } from '../web/core/finance/review.mjs';
import { writeMonoAccounts } from '../web/core/finance/store.mjs';
import { buildWeeklyDigest } from '../web/core/tools/weekly.mjs';

const NOW = Date.parse('2026-10-18T06:00:00.000Z');
const migrations = readdirSync(join(__dirname, '..', 'web/core/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
function setup() {
  const d1 = d1FromSqlite(migrations),
    env = workerEnv({ DB: d1.stub });
  function add(
    id: string,
    amount: number,
    options: {
      at?: string;
      category?: string;
      description?: string;
      raw?: Record<string, unknown>;
      flags?: string[];
      kind?: string;
      uah?: number | null;
    } = {},
  ) {
    d1.db
      .prepare(
        'INSERT INTO transactions(id,at,amount,currency,amount_uah,category,description,raw_json,flags_json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        options.at ?? '2026-10-13T10:00:00.000Z',
        amount,
        'UAH',
        options.uah === undefined ? amount : options.uah,
        options.category ?? 'продукти',
        options.description ?? 'Покупка',
        JSON.stringify({ financeKind: options.kind ?? 'expense', ...options.raw }),
        JSON.stringify(options.flags ?? []),
      );
  }
  add('oldest', -1, { at: '2026-08-01T09:00:00.000Z' });
  function payment(id: string, kind = 'installment', name = 'Договір') {
    d1.db
      .prepare(
        "INSERT INTO finance_payments(id,name,kind,amount_minor,remaining_minor,installments_left,next_date,anchor_day,recurrence,category,created_at) VALUES(?,?,?,10000,8500,1,'2026-10-20',20,'once','освіта',?)",
      )
      .run(id, name, kind, new Date(NOW).toISOString());
  }
  return { d1, env, add, payment };
}

// Amounts and merchant descriptions are synthetic public fixtures.
describe('weekly finance evidence', () => {
  it('returns all categories and exact four-period change contributions, including baseline-only categories', async () => {
    const s = setup();
    for (let i = 0; i < 16; i++) {
      s.add(`current-${i}`, -(101 + i), { category: `категорія ${i}` });
      s.add(`base-${i}`, -(51 + i), { category: `категорія ${i}`, at: '2026-10-06T10:00:00Z' });
    }
    s.add('other', -123, { category: 'інше' });
    s.add('base-only', -333, { category: 'давня', at: '2026-09-29T10:00:00Z' });
    const before = s.d1.db.prepare('SELECT * FROM transactions ORDER BY id').all();
    const f = await readWeeklyFinance(s.env, NOW),
      b = f.categoryBreakdown;
    expect(f.categories).toHaveLength(18);
    expect(f.categories.find((c) => c.category === 'давня')).toMatchObject({
      amountMinor: 0,
      averageMinor: 83.25,
    });
    expect(
      b.top.reduce((sum, c) => sum + c.amountMinor, 0) +
        b.rest.amountMinor +
        b.otherCategory.amountMinor,
    ).toBe(f.summary.expenseMinor);
    expect(b.top.reduce((sum, c) => sum + c.count, 0) + b.rest.count + b.otherCategory.count).toBe(
      f.summary.count,
    );
    expect(b.expenseMinor).toBe(f.summary.expenseMinor);
    expect(b.changeFourPeriodMinor).toBe(
      (f.summary.expenseMinor - f.comparison.averageExpenseMinor!) * 4,
    );
    const tool = (
      await runFinanceQuery(s.env, { view: 'analytics', period: '2026-10-12..2026-10-18' }, NOW)
    ).result;
    if (!('categories' in tool) || !tool.categories || !tool.summary)
      throw new Error('Expected finance analytics');
    expect(tool.categories).toHaveLength(17);
    expect(tool.categories.reduce((sum, c) => sum + c.amountMinor, 0)).toBe(
      tool.summary.expenseMinor,
    );
    const legacy = summarize(
      Array.from({ length: 16 }, (_, i) => ({
        id: String(i),
        amount: -1,
        currency: 'UAH',
        amount_uah: -1,
        merchant: `m${i}`,
        category: `c${i}`,
        at: '',
        flags: [],
        mcc: 5411,
        note: null,
      })),
    );
    expect(legacy.by_category).toHaveLength(16);
    expect(legacy.by_category.reduce((sum, c) => sum + c.total, 0)).toBe(legacy.total_uah);
    expect(s.d1.db.prepare('SELECT * FROM transactions ORDER BY id').all()).toEqual(before);
  });

  it('reports counts and amounts of unclassified inflows/outflows for current and baseline periods', async () => {
    const s = setup();
    s.add('expense', -100);
    s.add('unknown-out', -700, { kind: 'unclassified' });
    s.add('unknown-in', 900, { kind: 'unclassified' });
    s.add('unknown-fx', -300, { kind: 'unclassified', uah: null });
    s.add('baseline-unknown', -501, { kind: 'unclassified', at: '2026-10-06T10:00:00Z' });
    const f = await readWeeklyFinance(s.env, NOW);
    expect(f.summary.expenseMinor).toBe(100);
    expect(f.categoryBreakdown.unclassifiedOutsideExpenses).toEqual({
      count: 3,
      outflowMinor: 700,
      inflowMinor: 900,
      unknownCurrencyCount: 1,
    });
    expect(f.comparison.weeks[0]?.quality).toMatchObject({
      unclassifiedCount: 1,
      unclassifiedOutflowMinor: 501,
    });
    expect(f.comparison.averageExpenseMinor).toBeNull();
    expect(
      f.categories.every((c) => c.averageMinor === null && c.changeFourPeriodMinor === null),
    ).toBe(true);
  });

  it('keeps an unlinked repayment in the baseline and only excludes a proven principal component', async () => {
    const s = setup();
    s.payment('debt');
    s.add('repayment', -10000, {
      raw: { financeReference: 'debt', financePrincipalMinor: 8500, financeOverpaymentMinor: 1500 },
    });
    s.add('purchase', -200000, { flags: ['over_threshold'] });
    s.add('unlinked-repayment', -2800400, {
      category: 'покупка частинами',
      description: 'Повне погашення навчальної програми',
      at: '2026-10-06T15:00:00.000Z',
    });
    const f = await readWeeklyFinance(s.env, NOW);
    expect(f.summary.expenseMinor).toBe(210000);
    expect(f.review?.repayment).toMatchObject({
      principalMinor: 8500,
      interestAndFeesMinor: 1500,
      withoutPrincipalMinor: 201500,
      exclusionCount: 1,
    });
    expect(f.review?.repayment.exclusions[0]).toMatchObject({
      reason: 'linked-debt-principal',
      originalPurchaseAccounting: 'not-established',
    });
    expect(f.comparison.weeks[0]?.repayment).toMatchObject({
      principalMinor: 0,
      unverifiedCount: 1,
      withoutPrincipalMinor: 2800400,
    });
    expect(f.comparison.weeks[0]?.repayment?.unverified[0]).toMatchObject({
      excludedMinor: 0,
      reason: 'repayment-text-without-linked-contract',
    });
    expect(f.comparison.excludingDebtPrincipal).toMatchObject({
      currentMinor: 201500,
      averageMinor: 700100,
    });
    expect(f.comparison.averageExpenseMinor).toBe(700100);
    expect(f.review?.unusual.operations).toHaveLength(1);
  });

  it('does not exclude a guessed split, changed bank amount or subscription payment as debt', async () => {
    const s = setup();
    s.payment('debt');
    s.payment('sub', 'subscription');
    s.add('missing-split', -10000, { raw: { financeReference: 'debt' } });
    s.add('changed', -12000, {
      raw: {
        financeReference: 'debt',
        financePrincipalMinor: 8500,
        financeOverpaymentMinor: 1500,
        financeBankAmountChanged: true,
      },
    });
    s.add('subscription', -10000, {
      raw: { financeReference: 'sub', financePrincipalMinor: 10000, financeOverpaymentMinor: 0 },
      flags: ['subscription'],
    });
    const f = await readWeeklyFinance(s.env, NOW);
    expect(f.review?.repayment).toMatchObject({
      principalMinor: 0,
      withoutPrincipalMinor: 32000,
      unverifiedCount: 2,
    });
    expect(f.review?.subscriptions).toMatchObject({ expenseMinor: 10000, count: 1 });
  });

  it('reconciles synthetic pending holds, owner confirmations and unclassified missing authorizations', async () => {
    const s = setup();
    for (const [i, amount] of [12345, 23456, 3456].entries())
      s.add(`hold-${i}`, -amount, {
        raw: {
          account: 'card',
          hold: true,
          ...(i < 2
            ? { bankCheckedAt: '2026-10-17T12:00:00.000Z', bankCheckSource: 'statement' }
            : {}),
        },
      });
    s.add('posted', -1000);
    s.add('owner-confirmed', -2000, {
      raw: { hold: true, account: 'card', financeBankVerifiedByOwner: true },
    });
    s.add('missing', -3000, {
      raw: { hold: true, account: 'card', bankMissingFromStatement: true },
    });
    const f = await readWeeklyFinance(s.env, NOW);
    expect(f.review?.outflows).toEqual({
      expenseMinor: 42257,
      count: 5,
      confirmedExpenseMinor: 3000,
      confirmedExpenseCount: 2,
      pendingExpenseMinor: 39257,
      pendingExpenseCount: 3,
      ownerConfirmedCount: 1,
      pendingIncludedInTotal: true,
    });
    expect(f.review?.pending.count).toBe(4);
    expect(f.review?.pending.operations.find((t) => t.id === 'hold-2')?.checkedAt).toBeNull();
    expect(f.quality.unclassifiedOutflowMinor).toBe(3000);
    expect(f.review?.pending.operations.find((t) => t.id === 'missing')?.kind).toBe('unclassified');
  });

  it('gives dated own funds without credit, reserves without double counting, due payments and currencies', async () => {
    const s = setup();
    await writeMonoAccounts(
      s.env,
      [
        {
          id: 'card',
          currency: 'UAH',
          maskedPan: null,
          balanceMinor: 150000,
          creditLimitMinor: 100000,
          asOf: '2026-10-17T20:30:00.000Z',
        },
      ],
      NOW,
    );
    const state = await readFinanceWorkspace(s.env, NOW, undefined, { omitTransactions: true });
    state.goalMoves = [
      {
        id: 'reserve',
        goalId: 'g',
        accountId: 'mono:card',
        amountMinor: 10000,
        movementKind: 'reserve',
        transactionId: null,
        at: new Date(NOW).toISOString(),
      },
      {
        id: 'external',
        goalId: 'g',
        accountId: 'mono:card',
        amountMinor: 90000,
        movementKind: 'external',
        transactionId: 'external',
        at: new Date(NOW).toISOString(),
      },
    ];
    state.reserveMinor = 5000;
    state.payments = [
      {
        id: 'sub',
        name: 'Музика',
        kind: 'subscription',
        amountMinor: 12000,
        nextDate: '2026-10-20',
        status: 'active',
        recurrence: 'month',
        remainingMinor: null,
      },
      {
        id: 'late',
        name: 'Борг',
        kind: 'bill',
        amountMinor: 500,
        nextDate: '2026-10-17',
        status: 'active',
        recurrence: 'once',
        remainingMinor: null,
      },
      {
        id: 'done',
        name: 'Сплачено',
        kind: 'bill',
        amountMinor: 100,
        nextDate: '2026-10-19',
        status: 'done',
        recurrence: 'once',
        remainingMinor: null,
      },
      {
        id: 'future',
        name: 'Пізніше',
        kind: 'bill',
        amountMinor: 100,
        nextDate: '2026-10-25',
        status: 'active',
        recurrence: 'once',
        remainingMinor: null,
      },
    ] as typeof state.payments;
    state.detectedSubscriptions = [
      {
        id: 'detected',
        merchant: 'Музика',
        currency: 'USD',
        amountMinor: 299,
        nextAt: '2026-10-20T10:00:00Z',
      },
    ];
    const before = JSON.stringify(state);
    const c = financeReviewContext(state, NOW, { completedAt: '2026-10-17T20:40:00.000Z' });
    expect(c.balances).toMatchObject({ ownedMinor: 50000, complete: true });
    expect(c.reserves).toMatchObject({
      goalsMinor: 10000,
      fleetMinor: 5000,
      alreadyPartOfOwnedFunds: true,
      availableAfterReservesMinor: 35000,
    });
    expect(c.upcoming).toMatchObject({ count: 1, knownTotalMinor: 12000, to: '2026-10-24' });
    expect(c.overdue.count).toBe(1);
    expect(c.detectedSubscriptions).toMatchObject({
      combinedWithPayments: false,
      items: [{ currency: 'USD', amountMinor: 299, possiblePaymentIds: ['sub'] }],
    });
    expect(c.bankFreshness).toMatchObject({
      lastCompletedStatementRefreshAt: '2026-10-17T20:40:00.000Z',
      statementAgeHours: 9,
    });
    expect(JSON.stringify(state)).toBe(before);
    Object.assign(state.accounts[0]!, { balanceMinor: null });
    const unknown = financeReviewContext(state, NOW);
    expect(unknown.balances.ownedMinor).toBeNull();
    expect(unknown.reserves.availableAfterReservesMinor).toBeNull();
  });

  it('marks bounded evidence lists as truncated while retaining full amounts and counts', async () => {
    const s = setup();
    for (let i = 0; i < 45; i++)
      s.add(`held-${i}`, -(100 + i), {
        raw: { hold: true, account: 'card' },
        flags: ['duplicate'],
      });
    const f = await readWeeklyFinance(s.env, NOW);
    expect(f.review?.pending).toMatchObject({ count: 45, truncated: true, expenseMinor: 5490 });
    expect(f.review?.pending.operations).toHaveLength(40);
    expect(f.review?.unusual).toMatchObject({ count: 45, truncated: true });
    expect(f.summary.expenseMinor).toBe(5490);
    const before = JSON.stringify(f);
    const packed = buildWeeklyDigest({ agg: {}, finance: f, todayKey: '2026-10-18', cap: 15000 });
    const data = JSON.parse(packed.text);
    expect(data.finance.summary.expenseMinor).toBe(5490);
    expect(data.finance.categories).toEqual(f.categories);
    expect(data.dropped).toContain('finance.evidence');
    expect(data.finance.review.pending).toMatchObject({ count: 45, truncated: true });
    expect(JSON.stringify(f)).toBe(before);
  });

  it('distinguishes a successful statement refresh from a failed job or balance-only update', async () => {
    const s = setup();
    const state = await readFinanceWorkspace(s.env, NOW, undefined, { omitTransactions: true });
    state.bankSync = {
      phase: 'error',
      active: false,
      completedAt: new Date(NOW).toISOString(),
      total: 3,
    };
    expect(
      financeReviewContext(state, NOW).bankFreshness.lastCompletedStatementRefreshAt,
    ).toBeNull();
    state.bankSync = {
      phase: 'done',
      balancesOnly: true,
      total: 1,
      completedAt: new Date(NOW).toISOString(),
    };
    expect(
      financeReviewContext(state, NOW).bankFreshness.lastCompletedStatementRefreshAt,
    ).toBeNull();
    state.bankSync = {
      phase: 'done',
      balancesOnly: false,
      total: 2,
      statementAccounts: ['card'],
      completedAt: new Date(NOW).toISOString(),
    };
    expect(financeReviewContext(state, NOW).bankFreshness).toMatchObject({
      lastCompletedStatementRefreshAt: new Date(NOW).toISOString(),
      lastStatementScope: { source: 'manual-refresh', accountIds: ['card'] },
    });
  });
});
