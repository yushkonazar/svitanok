import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { readFinanceWorkspace, executeFinanceCommand } from '../web/core/finance/workspace.mjs';
import { handleFinance } from '../web/api-finance.mjs';
import { applyRule, RETENTION } from '../web/core/retention/cleanup.mjs';
import { runFinanceQuery } from '../web/core/tools/finance.mjs';
import { queueMiniAppNotice, miniAppPaymentRemindTask } from '../web/core/finance/reminders.mjs';

const NOW = Date.parse('2026-10-08T15:00:00Z');
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0005_finance.sql',
    '0028_mini_app_finance.sql',
    '0029_finance_credit_limits.sql',
  ]);
  const originalBatch = d1.stub.batch;
  d1.stub.batch = async (statements) => {
    d1.db.exec('BEGIN');
    try {
      const out = await originalBatch(statements);
      d1.db.exec('COMMIT');
      return out;
    } catch (e) {
      d1.db.exec('ROLLBACK');
      throw e;
    }
  };
  return { d1, env: workerEnv({ DB: d1.stub }) };
}
describe('finance workspace · real migration and SQLite transactions', () => {
  it('offers bank purchase categories and accounts for installment payments without duplicating debt or cash', async () => {
    const { env } = setup();
    const before = await readFinanceWorkspace(env, NOW);
    expect(before.categories).toEqual(
      expect.arrayContaining(['покупка частинами', 'розстрочка', 'кіно', 'комуналка та інтернет']),
    );
    await executeFinanceCommand(
      env,
      {
        id: 'parts-proove',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Proove',
          kind: 'installment',
          amountMinor: 9070,
          remainingMinor: 108840,
          totalMinor: 181400,
          installmentsLeft: 12,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'покупка частинами',
        },
      },
      NOW,
    );
    const scheduled = await readFinanceWorkspace(env, NOW);
    expect(scheduled.accounts[0]?.balanceMinor).toBe(before.accounts[0]?.balanceMinor);
    await executeFinanceCommand(
      env,
      {
        id: 'parts-proove-paid',
        version: 1,
        type: 'payment-paid',
        payload: { paymentId: 'parts-proove', amountMinor: 9070, accountId: 'cash' },
      },
      NOW,
    );
    const after = await readFinanceWorkspace(env, NOW);
    expect(after.payments[0]).toMatchObject({
      remainingMinor: 99770,
      installmentsLeft: 11,
      nextDate: '2026-11-09',
      category: 'покупка частинами',
    });
    expect(after.accounts[0]?.balanceMinor).toBe(-9070);
    expect(after.transactions[0]).toMatchObject({
      category: 'покупка частинами',
      amountMinor: -9070,
    });
  });
  it('payment reminders are persistent, configurable and never send directly', async () => {
    const { env, d1 } = setup();
    env.TELEGRAM_CHAT_ID = '123';
    env.TELEGRAM_BOT_TOKEN = 'test-only';
    d1.db.exec(
      'CREATE TABLE outbox(id TEXT PRIMARY KEY,chat_id TEXT,thread_id TEXT,kind TEXT,payload_json TEXT,attempts INTEGER,next_at TEXT,status TEXT)',
    );
    const at = Date.parse('2026-10-08T08:00:00Z');
    await executeFinanceCommand(
      env,
      {
        id: 'bill-0001',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Інтернет',
          kind: 'subscription',
          amountMinor: 30000,
          nextDate: '2026-10-10',
          anchorDay: 10,
          recurrence: 'month',
          category: 'звʼязок та інтернет',
          remindDays: 3,
        },
      },
      at,
    );
    expect(await miniAppPaymentRemindTask(env, at)).toEqual({ queued: 1 });
    expect(await miniAppPaymentRemindTask(env, at + 300000)).toEqual({ queued: 0 });
    d1.db.exec('DELETE FROM outbox');
    expect(await miniAppPaymentRemindTask(env, at + 600000)).toEqual({ queued: 0 });
    expect(await queueMiniAppNotice(env, 'checkin:2026-10-08:am', 'Чек-ін', at)).toBe(true);
    expect(await queueMiniAppNotice(env, 'checkin:2026-10-08:am', 'Чек-ін', at + 1)).toBe(false);
    await executeFinanceCommand(
      env,
      {
        id: 'prefs-0001',
        version: 1,
        type: 'settings',
        payload: {
          incomePeriod: 'week',
          taxiVisible: true,
          categories: [],
          paymentReminders: false,
          checkinReminders: false,
        },
      },
      at,
    );
    expect(await miniAppPaymentRemindTask(env, Date.parse('2026-10-10T08:00:00Z'))).toEqual({
      skipped: 'disabled',
    });
    expect((await readFinanceWorkspace(env, at)).settings.checkinReminders).toBe(false);
  });
  it('links an imported payment once, and preserves the manual balance ledger through retention', async () => {
    const { env, d1 } = setup();
    d1.db
      .prepare(
        'INSERT INTO transactions(id,at,amount,currency,amount_uah,category,description,raw_json,flags_json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'bank-pay',
        '2026-10-08T12:00:00Z',
        -30000,
        'UAH',
        -30000,
        'інше',
        'Internet',
        JSON.stringify({ account: 'mono-1', hold: false }),
        '[]',
      );
    await executeFinanceCommand(
      env,
      {
        id: 'payment-0001',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Інтернет',
          kind: 'subscription',
          amountMinor: 30000,
          nextDate: '2026-10-08',
          anchorDay: 8,
          recurrence: 'month',
          category: 'звʼязок та інтернет',
        },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'paid-0001',
        version: 1,
        type: 'payment-paid',
        payload: { paymentId: 'payment-0001', transactionId: 'bank-pay', amountMinor: 30000 },
      },
      NOW,
    );
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(1);
    expect((await readFinanceWorkspace(env, NOW)).payments[0]!.nextDate).toBe('2026-11-08');
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'paid-0002',
          version: 2,
          type: 'payment-paid',
          payload: { paymentId: 'payment-0001', transactionId: 'bank-pay', amountMinor: 30000 },
        },
        NOW,
      ),
    ).rejects.toThrow('непов’язаний');
    await executeFinanceCommand(
      env,
      {
        id: 'opening-0001',
        version: 2,
        type: 'transaction',
        payload: { kind: 'adjustment', accountId: 'cash', amountMinor: 100000 },
      },
      NOW,
    );
    await applyRule(
      env,
      RETENTION.find((r) => r.table === 'transactions')!,
      Date.parse('2029-10-08T15:00:00Z'),
    );
    expect(
      (await readFinanceWorkspace(env, Date.parse('2029-10-08T15:00:00Z'))).accounts.find(
        (a) => a.id === 'cash',
      )!.balanceMinor,
    ).toBe(100000);
  });
  it('assistant spending excludes transfers and cash held for the fleet', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'opening-0001',
        version: 0,
        type: 'transaction',
        payload: { kind: 'adjustment', accountId: 'cash', amountMinor: 100000 },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'expense-0001',
        version: 1,
        type: 'transaction',
        payload: {
          kind: 'expense',
          accountId: 'cash',
          amountMinor: 10000,
          category: 'продукти',
          at: new Date(NOW - 60000).toISOString(),
        },
      },
      NOW,
    );
    const result = await runFinanceQuery(env, { period: 'день' }, NOW);
    if (!('total_uah' in result.result)) throw new Error('Expected period summary');
    expect(result.result.total_uah).toBe(10000);
    expect(result.result.workspace!.available_minor).toBe(90000);
  });
  it('taxi cash, fleet reserve, personal spending and goals are accounted once', async () => {
    const { env, d1 } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'taxi-0001',
        version: 0,
        type: 'taxi-entry',
        payload: {
          at: '2026-10-06T18:00:00Z',
          accountId: 'cash',
          netCashMinor: 400000,
          commissionMinor: 70000,
          fuelMinor: 100000,
          receivedCashMinor: 200000,
        },
      },
      NOW,
    );
    const expense = {
      id: 'expense-0001',
      version: 1,
      type: 'transaction',
      payload: {
        kind: 'expense',
        amountMinor: 100000,
        accountId: 'cash',
        category: 'продукти',
        description: 'Продукти',
      },
    };
    await executeFinanceCommand(env, expense, NOW);
    await executeFinanceCommand(env, expense, NOW);
    let view = await readFinanceWorkspace(env, NOW);
    expect(view.version).toBe(2);
    expect(view.accounts[0]!.balanceMinor).toBe(100000);
    expect(view.reserveMinor).toBe(50000);
    expect(view.taxiWeeks[0]!.earnedMinor).toBe(150000);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(2);
    await executeFinanceCommand(
      env,
      {
        id: 'goal-0001',
        version: 2,
        type: 'goal',
        payload: { name: 'Навчання', targetMinor: 1000000 },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'move-0001',
        version: 3,
        type: 'goal-move',
        payload: { goalId: 'goal-0001', accountId: 'cash', amountMinor: 20000 },
      },
      NOW,
    );
    view = await readFinanceWorkspace(env, NOW);
    expect(view.accounts[0]!.balanceMinor).toBe(100000);
    expect(view.goalMoves[0]!.amountMinor).toBe(20000);
    expect(view.transactions.filter((t) => t.kind === 'expense')).toHaveLength(1);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'return-0001',
          version: 4,
          type: 'goal-move',
          payload: { goalId: 'goal-0001', accountId: 'cash', amountMinor: -20001 },
        },
        NOW,
      ),
    ).rejects.toThrow();
    expect((await readFinanceWorkspace(env, NOW)).version).toBe(4);
  });
  it('a taxi week rollover preserves fleet debt until the actual settlement', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'taxi-0001',
        version: 0,
        type: 'taxi-entry',
        payload: {
          at: '2026-10-06T18:00:00Z',
          accountId: 'cash',
          netCashMinor: 400000,
          commissionMinor: 70000,
          fuelMinor: 100000,
          receivedCashMinor: 200000,
        },
      },
      NOW,
    );
    const monday = Date.parse('2026-10-12T10:00:01Z');
    const before = await readFinanceWorkspace(env, monday);
    expect(before.reserveMinor).toBe(50000);
    expect(before.taxiWeeks[0]!.closed).toBe(true);
    const settle = {
      id: 'settle-0001',
      version: 1,
      type: 'taxi-settle',
      payload: { weekKey: '2026-10-05', accountId: 'cash' },
    };
    await executeFinanceCommand(env, settle, monday);
    await executeFinanceCommand(env, settle, monday);
    const after = await readFinanceWorkspace(env, monday);
    expect(after.reserveMinor).toBe(0);
    expect(after.accounts[0]!.balanceMinor).toBe(150000);
    expect(after.transactions.filter((t) => t.kind === 'income')).toHaveLength(0);
    expect(after.taxiWeeks[0]!.settled).toBe(true);
  });
  it('incomplete entries stay visible but cannot create a falsely final settlement', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'taxi-0001',
        version: 0,
        type: 'taxi-entry',
        payload: { at: '2026-10-06T18:00:00Z', accountId: 'cash', netCashMinor: 400000 },
      },
      NOW,
    );
    expect((await readFinanceWorkspace(env, NOW)).taxiWeeks[0]!.complete).toBe(false);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'settle-0001',
          version: 1,
          type: 'taxi-settle',
          payload: { weekKey: '2026-10-05', accountId: 'cash' },
        },
        Date.parse('2026-10-12T11:00:00Z'),
      ),
    ).rejects.toThrow();
    const edit = {
      id: 'taxi-edit-0001',
      version: 1,
      type: 'taxi-edit',
      payload: {
        entryId: 'taxi-0001',
        at: '2026-10-06T18:00:00Z',
        accountId: 'cash',
        netCashMinor: 400000,
        commissionMinor: 70000,
        fuelMinor: 100000,
        receivedCashMinor: 200000,
      },
    };
    await executeFinanceCommand(env, edit, NOW);
    await executeFinanceCommand(env, edit, NOW);
    const amended = await readFinanceWorkspace(env, NOW);
    expect(amended.taxiEntries).toHaveLength(1);
    expect(amended.taxiWeeks[0]!.complete).toBe(true);
    expect(amended.accounts[0]!.balanceMinor).toBe(200000);
    expect(amended.taxiWeeks[0]!.earnedMinor).toBe(150000);
    await executeFinanceCommand(
      env,
      {
        ...edit,
        id: 'taxi-edit-0002',
        version: 2,
        payload: { ...edit.payload, receivedCashMinor: 250000 },
      },
      NOW,
    );
    expect((await readFinanceWorkspace(env, NOW)).accounts[0]!.balanceMinor).toBe(250000);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'classify-0001',
          version: 3,
          type: 'classify',
          payload: { transactionId: 'taxi-cash:taxi-edit-0002', kind: 'income', category: 'дохід' },
        },
        NOW,
      ),
    ).rejects.toThrow('обліком');
  });
  it('rejects stale versions and reused IDs with different amounts, without partial writes', async () => {
    const { env, d1 } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'income-0001',
        version: 0,
        type: 'transaction',
        payload: { kind: 'income', accountId: 'cash', amountMinor: 10000, category: 'дохід' },
      },
      NOW,
    );
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'stale-0001',
          version: 0,
          type: 'transaction',
          payload: { kind: 'income', accountId: 'cash', amountMinor: 10000, category: 'дохід' },
        },
        NOW,
      ),
    ).rejects.toThrow('Дані змінилися');
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'income-0001',
          version: 0,
          type: 'transaction',
          payload: { kind: 'income', accountId: 'cash', amountMinor: 20000, category: 'дохід' },
        },
        NOW,
      ),
    ).rejects.toThrow('ID');
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(1);
  });
  it('private API rejects anonymous requests before touching finance data', async () => {
    const { env, d1 } = setup();
    const response = await handleFinance(
      new Request('https://example.test/api/finance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'income-0001',
          version: 0,
          type: 'transaction',
          payload: { kind: 'income', accountId: 'cash', amountMinor: 10000, category: 'дохід' },
        }),
      }),
      env,
    );
    expect([401, 403]).toContain(response.status);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(0);
  });
});
