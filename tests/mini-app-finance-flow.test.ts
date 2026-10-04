import { describe, it, expect, vi, afterEach } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { executeFinanceCommand, readFinanceWorkspace } from '../web/core/finance/workspace.mjs';
import { queueMiniAppNotice } from '../web/core/finance/reminders.mjs';
import { drainOutbox } from '../web/core/tg/outbox.mjs';
import { CRON_TASKS } from '../web/worker.js';
const monday = Date.parse('2026-10-12T10:00:00Z');
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0005_finance.sql',
    '0028_mini_app_finance.sql',
  ]);
  const original = d1.stub.batch;
  d1.stub.batch = async (s) => {
    d1.db.exec('BEGIN');
    try {
      const r = await original(s);
      d1.db.exec('COMMIT');
      return r;
    } catch (e) {
      d1.db.exec('ROLLBACK');
      throw e;
    }
  };
  return {
    d1,
    env: workerEnv({ DB: d1.stub, TELEGRAM_CHAT_ID: '123', TELEGRAM_BOT_TOKEN: 'test-only' }),
  };
}
describe('Mini App finance and reminder integration', () => {
  it('keeps principal distinct from interest and fees, including the last scheduled installment', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'credit-001',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Credit',
          kind: 'loan',
          amountMinor: 10000,
          totalMinor: 100000,
          remainingMinor: 80000,
          rateBps: 2400,
          feeMinor: 500,
          lender: 'Bank',
          note: 'Contract',
          installmentsLeft: 1,
          nextDate: '2026-10-15',
          anchorDay: 15,
          recurrence: 'month',
          category: 'кредити',
        },
      },
      monday,
    );
    const before = await readFinanceWorkspace(env, monday);
    const payment = before.payments[0];
    expect(payment).toMatchObject({
      totalMinor: 100000,
      remainingMinor: 80000,
      rateBps: 2400,
      feeMinor: 500,
      lender: 'Bank',
      note: 'Contract',
    });
    const command = {
      id: 'pay-credit-001',
      version: 1,
      type: 'payment-paid',
      payload: { paymentId: payment!.id, amountMinor: 10000, accountId: 'cash' },
    };
    await expect(executeFinanceCommand(env, command, monday)).rejects.toThrow('тіло');
    const untouched = await readFinanceWorkspace(env, monday);
    expect(untouched.version).toBe(1);
    expect(untouched.transactions).toHaveLength(0);
    await expect(
      executeFinanceCommand(
        env,
        { ...command, payload: { ...command.payload, principalMinor: 10001 } },
        monday,
      ),
    ).rejects.toThrow('перевищувати');
    const valid = { ...command, payload: { ...command.payload, principalMinor: 7500 } };
    await executeFinanceCommand(env, valid, monday);
    await executeFinanceCommand(env, valid, monday);
    const after = await readFinanceWorkspace(env, monday);
    expect(after.payments[0]).toMatchObject({
      remainingMinor: 72500,
      installmentsLeft: 0,
      status: 'active',
      nextDate: '2026-11-15',
    });
    expect(after.accounts[0]?.balanceMinor).toBe(-10000);
    expect(after.transactions).toHaveLength(1);
  });
  it('rejects debt above initial principal and subtracts a fixed fee only once', async () => {
    const { env } = setup();
    const p = {
      name: 'Installment',
      kind: 'installment',
      amountMinor: 10050,
      totalMinor: 20000,
      remainingMinor: 20001,
      feeMinor: 50,
      installmentsLeft: 2,
      nextDate: '2026-10-31',
      anchorDay: 31,
      recurrence: 'month',
      category: 'кредити',
    };
    await expect(
      executeFinanceCommand(
        env,
        { id: 'credit-002', version: 0, type: 'payment', payload: p },
        monday,
      ),
    ).rejects.toThrow('початкову');
    await executeFinanceCommand(
      env,
      { id: 'credit-002', version: 0, type: 'payment', payload: { ...p, remainingMinor: 20000 } },
      monday,
    );
    const before = await readFinanceWorkspace(env, monday);
    await executeFinanceCommand(
      env,
      {
        id: 'pay-credit-002',
        version: 1,
        type: 'payment-paid',
        payload: { paymentId: before.payments[0]!.id, amountMinor: 10050, accountId: 'cash' },
      },
      monday,
    );
    const after = await readFinanceWorkspace(env, monday);
    expect(after.payments[0]).toMatchObject({ remainingMinor: 10000, nextDate: '2026-11-30' });
    expect(after.accounts[0]?.balanceMinor).toBe(-10050);
  });
  it('manual corrections update the same ledger entry, retain the previous value and remain idempotent', async () => {
    const { d1, env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'expense-0001',
        version: 0,
        type: 'transaction',
        payload: { kind: 'expense', accountId: 'cash', amountMinor: 35050, category: 'продукти' },
      },
      monday,
    );
    const edit = {
      id: 'edit-0001',
      version: 1,
      type: 'transaction-edit',
      payload: {
        transactionId: 'manual:expense-0001',
        kind: 'expense',
        amountMinor: 25050,
        category: 'кафе й ресторани',
        description: 'Обід',
      },
    };
    await executeFinanceCommand(env, edit, monday);
    await executeFinanceCommand(env, edit, monday);
    const after = await readFinanceWorkspace(env, monday);
    expect(after.accounts[0]?.balanceMinor).toBe(-25050);
    expect(after.transactions).toHaveLength(1);
    expect(after.transactions[0]).toMatchObject({
      amountMinor: -25050,
      category: 'кафе й ресторани',
      description: 'Обід',
    });
    const raw = JSON.parse(
      String(d1.db.prepare('SELECT raw_json FROM transactions').get()!.raw_json),
    );
    expect(raw.financeRevisions).toHaveLength(1);
    expect(raw.financeRevisions[0]).toMatchObject({ amountMinor: -35050, category: 'продукти' });
    await expect(
      executeFinanceCommand(env, { ...edit, id: 'edit-0002', version: 1 }, monday),
    ).rejects.toThrow('Дані змінилися');
  });
  it.each([200000, 100000])(
    'matches a bank settlement once, for cash held %i, without recording a second income/expense',
    async (held) => {
      const { d1, env } = setup();
      await executeFinanceCommand(
        env,
        {
          id: 'taxi-day-0001',
          version: 0,
          type: 'taxi-entry',
          payload: {
            at: '2026-10-08T15:00:00Z',
            accountId: 'cash',
            netCashMinor: 400000,
            commissionMinor: 70000,
            fuelMinor: 100000,
            receivedCashMinor: held,
          },
        },
        monday,
      );
      const delta = 150000 - held;
      d1.db
        .prepare(
          'INSERT INTO finance_accounts(id,name,kind,currency,opening_minor,opening_at,mono_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          'mono:bank1',
          'Bank',
          'mono',
          'UAH',
          100000,
          '1970-01-01T00:00:00Z',
          'bank1',
          '2026-10-01T00:00:00Z',
        );
      d1.db
        .prepare(
          'INSERT INTO transactions(id,at,amount,currency,amount_uah,category,description,raw_json,flags_json) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          'bank-settlement',
          '2026-10-12T10:01:00Z',
          delta,
          'UAH',
          delta,
          'перекази й готівка',
          'Fleet',
          JSON.stringify({ account: 'bank1', hold: false }),
          '[]',
        );
      const now = monday + 120000;
      const command = {
        id: 'taxi-settle-0001',
        version: 1,
        type: 'taxi-settle',
        payload: { weekKey: '2026-10-05', transactionId: 'bank-settlement' },
      };
      const before = await readFinanceWorkspace(env, now);
      const rows = d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n;
      await executeFinanceCommand(env, command, now);
      await executeFinanceCommand(env, command, now);
      const after = await readFinanceWorkspace(env, now);
      expect(after.reserveMinor).toBe(0);
      expect(after.taxiWeeks[0]?.settled).toBe(true);
      expect(after.accounts).toEqual(before.accounts);
      expect(after.transactions.find((t) => t.id === 'bank-settlement')).toMatchObject({
        kind: 'taxi-settlement',
        reference: '2026-10-05',
      });
      expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(rows);
      expect(
        d1.db.prepare('SELECT bank_tx_id FROM finance_taxi_settlements').get()!.bank_tx_id,
      ).toBe('bank-settlement');
      await expect(
        executeFinanceCommand(env, { ...command, id: 'taxi-settle-0002', version: 2 }, now),
      ).rejects.toThrow('розрахований');
    },
  );
  it('legacy scheduler drains payment/check-in notices; network failure retries without requeueing', async () => {
    const { d1, env } = setup();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await queueMiniAppNotice(env, 'checkin:2026-10-12:pm', 'Пройди чек-ін', monday)).toBe(
      true,
    );
    const task = CRON_TASKS.find((t) => t.name === 'drainOutbox');
    expect(task).toBeDefined();
    expect(await drainOutbox(env, { nowMs: monday, sleep: async () => {} })).toMatchObject({
      retried: 1,
      sent: 0,
    });
    expect(
      await queueMiniAppNotice(env, 'checkin:2026-10-12:pm', 'Пройди чек-ін', monday + 60000),
    ).toBe(false);
    expect(await drainOutbox(env, { nowMs: monday + 60000, sleep: async () => {} })).toMatchObject({
      sent: 1,
      retried: 0,
    });
    await drainOutbox(env, { nowMs: monday + 120000, sleep: async () => {} });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(d1.db.prepare('SELECT status FROM outbox').get()!.status).toBe('sent');
  });
});
