import { describe, it, expect } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import {
  readFinanceAnalytics,
  readAnalyticsOperations,
} from '../web/core/finance/analytics-store.mjs';
import {
  analyticsPeriod,
  analyticsSelection,
  buildExpenseAnalytics,
} from '../web/core/finance/analytics.mjs';
import { runFinanceQuery } from '../web/core/tools/finance.mjs';
import { financeTransactionOf, executeFinanceCommand } from '../web/core/finance/workspace.mjs';
import { handleFinance } from '../web/api-finance.mjs';
const NOW = Date.parse('2026-10-14T15:00:00Z');
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
  ]);
  const env = workerEnv({ DB: d1.stub });
  const add = (
    id: string,
    amount: number,
    options: {
      at?: string;
      kind?: string;
      category?: string;
      merchant?: string;
      raw?: Record<string, unknown>;
      uah?: number | null;
    } = {},
  ) => {
    d1.db
      .prepare(
        'INSERT INTO transactions(id,at,amount,currency,amount_uah,description,category,flags_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        options.at ?? '2026-10-06T10:00:00Z',
        amount,
        'UAH',
        options.uah === undefined ? amount : options.uah,
        options.merchant ?? 'OKKO',
        options.category ?? 'авто',
        '[]',
        JSON.stringify({ account: 'one', financeKind: options.kind ?? 'expense', ...options.raw }),
      );
  };
  return { env, d1, add };
}
const params = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ from: '2026-10-05', to: '2026-10-11', ...extra });
describe('private finance analytics', () => {
  it('shares calendar periods and exact filtered totals with the assistant, including DST and deep links', async () => {
    const { env, add } = setup();
    add('cafe', -18700, { category: 'кафе й ресторани', merchant: 'Кафе' });
    add('own', -80000, { kind: 'transfer' });
    const tool = await runFinanceQuery(
      env,
      { view: 'analytics', period: '2026-10-05..2026-10-11', category: 'кафе й ресторани' },
      NOW,
    );
    expect(tool.result).toMatchObject({
      mode: 'analytics',
      summary: { expenseMinor: 18700, count: 1 },
      reportScope: 'all-accounts',
    });
    if (!('link' in tool.result))
      throw new Error('Analytics result must include its Mini App link');
    expect(tool.result.link).toContain('analytics=expenses');
    expect(tool.result.link).toContain('from=2026-10-05');
    expect(analyticsPeriod('7d', Date.parse('2026-03-31T12:00:00Z'))).toMatchObject({
      from: '2026-03-25',
      to: '2026-03-31',
    });
    for (const period of ['today', 'yesterday', 'week', 'month', '2w', '2026-09'])
      expect(analyticsPeriod(period, NOW).from).toMatch(/^2026-/);
    expect(() => analyticsPeriod('0d', NOW)).toThrow();
    expect(() => analyticsPeriod('unknown', NOW)).toThrow();
    await expect(
      runFinanceQuery(env, { view: 'analytics', period: '7d', flags: ['duplicate'] }, NOW),
    ).rejects.toThrow(/flags/);
  });
  it('counts linked payments once, excludes own transfers and reserves, and separates hold and missing conversion', async () => {
    const { env, add } = setup();
    add('paid', -13464, { raw: { financeReference: 'subscription' } });
    add('hold', -18700, { raw: { hold: true } });
    add('verified', -10000, { raw: { hold: true, financeBankVerifiedByOwner: true } });
    add('own-transfer', -800000, { kind: 'transfer' });
    add('reserve', -20000, { kind: 'goal-move' });
    add('unknown', -500, { uah: null });
    add('prior', -10000, { at: '2026-09-30T10:00:00Z' });
    add('fake', -999999, { raw: { test: 1 } });
    const result = await readFinanceAnalytics(env, params(), NOW);
    expect(result.summary).toMatchObject({
      expenseMinor: 42164,
      count: 3,
      medianMinor: 13464,
      previousExpenseMinor: 10000,
      changeMinor: 32164,
      activeDays: 1,
    });
    expect(result.quality).toMatchObject({
      pendingCount: 1,
      pendingMinor: 18700,
      unknownCurrencyCount: 1,
    });
    expect(result.report.resultMinor).toBe(-42164);
    const confirmed = await readFinanceAnalytics(env, params({ status: 'confirmed' }), NOW);
    expect(confirmed.summary.expenseMinor).toBe(23464);
    expect(confirmed.report.expenseMinor).toBe(42164);
    expect(confirmed.reportScope).toBe('all-accounts');
    const details = await readAnalyticsOperations(env, params({ status: 'confirmed' }), NOW);
    expect(new Set(details.items.map((t) => t.id))).toEqual(new Set(['paid', 'verified']));
  });
  it('uses calendar Kyiv boundaries, zero days and equal elapsed days in previous month', () => {
    const s = analyticsSelection(
      new URLSearchParams({ from: '2026-10-01', to: '2026-10-14', comparison: 'month' }),
      NOW,
    );
    expect([s.previousFrom, s.previousTo]).toEqual(['2026-09-01', '2026-09-14']);
    const tx = (id: string, at: string, amountUah: number) => ({
      id,
      at,
      amountUah,
      amountMinor: amountUah,
      currency: 'UAH',
      kind: 'expense',
      category: 'кафе й ресторани',
      description: 'Кафе',
      bank: true,
    });
    const data = buildExpenseAnalytics(
      [
        tx('kyiv-next-day', '2026-09-30T22:30:00Z', -10000),
        tx('outside', '2026-09-30T20:30:00Z', -90000),
      ],
      s,
    );
    expect(data.summary).toMatchObject({
      expenseMinor: 10000,
      count: 1,
      averageDayMinor: 714,
      changeBps: null,
    });
    expect(data.daily).toHaveLength(14);
    expect(data.daily[0]!.expenseMinor).toBe(10000);
    expect(data.daily[13]!.cumulativeMinor).toBe(10000);
    expect(() => analyticsSelection(params({ from: '2026-02-30' }), NOW)).toThrow(/Некорект/);
    expect(() => analyticsSelection(params({ source: 'unknown' }), NOW)).toThrow(/Некорект/);
  });
  it('paginates tied timestamps without duplicates and keeps SQL detail filters identical to the shared reducer', async () => {
    const { env, d1, add } = setup();
    for (let i = 0; i < 63; i++)
      add(`row-${String(i).padStart(3, '0')}`, -100 - i, {
        raw: { hold: i % 3 === 0, financeBankVerifiedByOwner: i % 6 === 0 },
      });
    add('cash', -500, { raw: { account: null, financeAccount: 'cash' } });
    add('missing', -600, { raw: { hold: true, bankMissingFromStatement: true } });
    const filter = params({
      source: 'mono',
      status: 'confirmed',
      account: 'mono:one',
      merchant: 'OKKO',
      category: 'авто',
    });
    const selection = analyticsSelection(filter, NOW);
    const rows = d1.db
      .prepare('SELECT * FROM transactions')
      .all()
      .map((row) => financeTransactionOf(row));
    const expected = buildExpenseAnalytics(rows, selection);
    const analytics = await readFinanceAnalytics(env, filter, NOW);
    expect(analytics.summary).toEqual(expected.summary);
    const details = await readAnalyticsOperations(env, filter, NOW);
    const rest = details.nextCursor
      ? await readAnalyticsOperations(
          env,
          new URLSearchParams([...filter, ['cursor', details.nextCursor]]),
          NOW,
        )
      : { items: [] };
    expect([...details.items, ...rest.items].reduce((sum, t) => sum - (t.amountUah ?? 0), 0)).toBe(
      expected.summary.expenseMinor,
    );
    const first = await readAnalyticsOperations(env, params(), NOW);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await readAnalyticsOperations(env, params({ cursor: first.nextCursor! }), NOW);
    const ids = [...first.items, ...second.items].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(64);
    expect(second.nextCursor).toBeNull();
    await expect(
      readAnalyticsOperations(env, params({ cursor: 'DROP TABLE transactions' }), NOW),
    ).rejects.toThrow(/курсор/);
    expect(
      (await readAnalyticsOperations(env, params({ merchant: "' OR 1=1 --" }), NOW)).items,
    ).toHaveLength(0);
  });
  it('streams multiple pages without losing exact totals or sending all transactions to the browser', async () => {
    const { env, add } = setup();
    for (let i = 0; i < 2100; i++) add(`item-${String(i).padStart(4, '0')}`, -1);
    const data = await readFinanceAnalytics(env, params(), NOW);
    expect(data.summary).toMatchObject({ expenseMinor: 2100, count: 2100, medianMinor: 1 });
    expect(data.categories[0]!.amountMinor).toBe(2100);
    expect(data).not.toHaveProperty('transactions');
    expect(data).not.toHaveProperty('items');
  });
  it('updates an archived bank category with current CAS version, preserving hold, amount and identity', async () => {
    const { env, d1, add } = setup();
    add('archive', -18700, { at: '2026-02-04T10:00:00Z', raw: { hold: true } });
    await executeFinanceCommand(
      env,
      {
        id: 'archive-classify',
        version: 0,
        type: 'classify',
        payload: { transactionId: 'archive', kind: 'expense', category: 'кафе й ресторани' },
      },
      NOW,
    );
    const row = d1.db.prepare('SELECT * FROM transactions WHERE id=?').get('archive')!;
    expect(row.amount).toBe(-18700);
    expect(row.category).toBe('кафе й ресторани');
    expect(JSON.parse(String(row.raw_json)).hold).toBe(true);
    expect(d1.db.prepare('SELECT COUNT(*) n FROM transactions').get()!.n).toBe(1);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'stale-archive',
          version: 0,
          type: 'classify',
          payload: { transactionId: 'archive', kind: 'expense', category: 'авто' },
        },
        NOW,
      ),
    ).rejects.toThrow(/Дані змінилися/);
  });
  it('rejects anonymous analytics and detail reads before returning private data', async () => {
    const { env, add } = setup();
    add('private', -50000);
    for (const view of ['analytics', 'analytics-operations']) {
      const response = await handleFinance(
        new Request(`https://example.test/api/finance?view=${view}`),
        env,
      );
      expect([401, 403]).toContain(response.status);
      expect(await response.text()).not.toContain('private');
    }
  });
});
