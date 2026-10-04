import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import { executeFinanceCommand } from '../web/core/finance/workspace.mjs';
import { handleFinance } from '../web/api-finance.mjs';

const now = Date.parse('2026-10-08T15:00:00Z');
const transaction = {
  kind: 'expense',
  accountId: 'cash',
  amountMinor: 10000,
  category: 'продукти',
};
const settings = { incomePeriod: 'month', taxiVisible: true, categories: [] };
const budget = {
  category: 'Продукти',
  period: 'month',
  limitMinor: 500000,
  categories: ['продукти'],
};
const payment = {
  name: 'Інтернет',
  kind: 'bill',
  nextDate: '2026-10-10',
  recurrence: 'once',
  category: 'звʼязок та інтернет',
  amountMinor: 30000,
};
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0005_finance.sql',
    '0028_mini_app_finance.sql',
    '0029_finance_credit_limits.sql',
  ]);
  return {
    d1,
    env: workerEnv({
      DB: d1.stub,
      TELEGRAM_BOT_TOKEN: 'finance-test-token',
      TELEGRAM_OWNER_USER_ID: '42',
      TELEGRAM_COOWNER_USER_IDS: '43',
    }),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('invalid finance records never create a ledger entry or consume a command version', () => {
  const cases: [string, string, Record<string, unknown>, RegExp][] = [
    ['fractional kopecks', 'transaction', { ...transaction, amountMinor: 1.5 }, /сума/],
    ['negative expense', 'transaction', { ...transaction, amountMinor: -1 }, /сума/],
    [
      'unsafe amount',
      'transaction',
      { ...transaction, amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      /сума/,
    ],
    ['zero expense', 'transaction', { ...transaction, amountMinor: 0 }, /більшою/],
    ['unknown account', 'transaction', { ...transaction, accountId: 'missing' }, /рахунок/],
    ['empty category', 'transaction', { ...transaction, category: '' }, /текст/],
    ['invalid timestamp', 'transaction', { ...transaction, at: 'tomorrow' }, /час/],
    [
      'future transaction',
      'transaction',
      { ...transaction, at: '2026-10-09T15:00:00Z' },
      /майбутньому/,
    ],
    [
      'before opening balance',
      'transaction',
      { ...transaction, at: '1969-12-31T15:00:00Z' },
      /початкового/,
    ],
    [
      'self transfer',
      'transaction',
      { ...transaction, kind: 'transfer', toAccountId: 'cash' },
      /інший рахунок/,
    ],
    [
      'missing editable transaction',
      'transaction-edit',
      { ...transaction, transactionId: 'absent' },
      /редагувати/,
    ],
    ['unsupported income mode', 'settings', { ...settings, incomePeriod: 'day' }, /варіант/],
    ['nonboolean visibility', 'settings', { ...settings, taxiVisible: 'false' }, /перемикач/],
    ['nonlist categories', 'settings', { ...settings, categories: 'продукти' }, /список/],
    [
      'too many categories',
      'settings',
      { ...settings, categories: Array(101).fill('продукти') },
      /список/,
    ],
    ['blank custom category', 'settings', { ...settings, categories: [''] }, /текст/],
    ['invalid notification switch', 'settings', { ...settings, paymentReminders: 1 }, /перемикач/],
    ['missing budget to edit', 'budget', { ...budget, budgetId: 'absent' }, /не знайдено/],
    ['both budget limit modes', 'budget', { ...budget, shareBps: 5000 }, /суму або/],
    ['no budget limit', 'budget', { ...budget, limitMinor: null }, /суму або/],
    [
      'share over 100 percent',
      'budget',
      { ...budget, limitMinor: null, shareBps: 10001 },
      /суму або/,
    ],
    ['fractional share', 'budget', { ...budget, limitMinor: null, shareBps: 1.5 }, /суму або/],
    ['missing budget categories', 'budget', { ...budget, categories: null }, /категорії/],
    [
      'too many budget categories',
      'budget',
      { ...budget, categories: Array(101).fill('продукти') },
      /категорії/,
    ],
    [
      'nonexistent goal',
      'goal',
      { name: 'Ціль', targetMinor: 10000, goalId: 'absent' },
      /не знайдена/,
    ],
    ['zero goal', 'goal', { name: 'Ціль', targetMinor: 0 }, /більшою/],
    [
      'invalid calendar date',
      'goal',
      { name: 'Ціль', targetMinor: 10000, deadline: '2026-02-30' },
      /дата/,
    ],
    [
      'missing allocation goal',
      'goal-move',
      { goalId: 'absent', accountId: 'cash', amountMinor: 10000 },
      /не знайдена/,
    ],
    ['missing payment to edit', 'payment', { ...payment, paymentId: 'absent' }, /не знайдено/],
    ['zero payment', 'payment', { ...payment, amountMinor: 0 }, /більшою/],
    ['anchor zero', 'payment', { ...payment, anchorDay: 0 }, /день списання/],
    ['anchor over month length', 'payment', { ...payment, anchorDay: 32 }, /день списання/],
    ['negative reminder days', 'payment', { ...payment, remindDays: -1 }, /нагадування/],
    ['unbounded reminder days', 'payment', { ...payment, remindDays: 31 }, /нагадування/],
    ['fractional installments', 'payment', { ...payment, installmentsLeft: 1.5 }, /кількість/],
    ['negative installments', 'payment', { ...payment, installmentsLeft: -1 }, /кількість/],
    ['unbounded installments', 'payment', { ...payment, installmentsLeft: 1201 }, /кількість/],
    ['negative interest rate', 'payment', { ...payment, rateBps: -1 }, /ставка/],
    ['fractional interest rate', 'payment', { ...payment, rateBps: 1.5 }, /ставка/],
    ['unbounded interest rate', 'payment', { ...payment, rateBps: 30001 }, /ставка/],
    [
      'debt above original principal',
      'payment',
      { ...payment, totalMinor: 10000, remainingMinor: 20000 },
      /Залишок/,
    ],
    ['fee consumes whole payment', 'payment', { ...payment, feeMinor: 30000 }, /Комісія/],
    [
      'missing active payment',
      'payment-paid',
      { paymentId: 'absent', amountMinor: 10000 },
      /не знайдено/,
    ],
    ['missing taxi entry to edit', 'taxi-edit', { entryId: 'absent' }, /не знайдено/],
    [
      'future taxi shift',
      'taxi-entry',
      { at: '2026-10-09T15:00:00Z', accountId: 'cash', netCashMinor: 10000 },
      /майбутню/,
    ],
    ['empty taxi shift', 'taxi-entry', { at: '2026-10-08T15:00:00Z', accountId: 'cash' }, /хоча б/],
    [
      'missing transaction for classification',
      'classify',
      { transactionId: 'absent', kind: 'income', category: 'дохід' },
      /не знайдена/,
    ],
    ['unknown command', 'unsupported', {}, /Невідома/],
  ];
  it.each(cases)('%s', async (_name, type, payload, error) => {
    const { d1, env } = setup();
    await expect(
      executeFinanceCommand(env, { id: 'validation-0001', version: 0, type, payload }, now),
    ).rejects.toThrow(error);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(0);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM finance_commands').get()!.n).toBe(0);
    expect(
      d1.db.prepare("SELECT version FROM finance_settings WHERE id='owner'").get()!.version,
    ).toBe(0);
  });
});

describe('finance HTTP contract with real Telegram signatures', () => {
  it('enforces owner writes, validates money, returns conflicts and makes retries idempotent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { d1, env } = setup();
    const owner = await buildInitData(42, 'finance-test-token');
    const reader = await buildInitData(43, 'finance-test-token');
    const post = (body: unknown, signature = owner) =>
      handleFinance(
        new Request('https://example.test/api/finance', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': signature },
          body: JSON.stringify(body),
        }),
        env,
      );
    const command = {
      id: 'http-income-0001',
      version: 0,
      type: 'transaction',
      payload: { ...transaction, kind: 'income' },
    };
    const read = await handleFinance(
      new Request('https://example.test/api/finance', {
        headers: { 'X-Telegram-Init-Data': owner },
      }),
      env,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('private, no-store');
    expect((await post(command, reader)).status).toBe(403);
    expect(
      (await post({ ...command, payload: { ...command.payload, amountMinor: -1 } })).status,
    ).toBe(400);
    expect((await post(command)).status).toBe(200);
    expect(await (await post(command)).json()).toMatchObject({ ok: true, duplicate: true });
    expect((await post({ ...command, id: 'http-income-0002' })).status).toBe(409);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(1);
    expect(
      d1.db.prepare("SELECT version FROM finance_settings WHERE id='owner'").get()!.version,
    ).toBe(1);
  });
  it('rejects malformed bodies, unsupported methods and expired sessions; DB failure never returns demo money', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { env } = setup();
    expect(
      (await handleFinance(new Request('https://example.test/api/finance', { method: 'PUT' }), env))
        .status,
    ).toBe(405);
    expect(
      (
        await handleFinance(
          new Request('https://example.test/api/finance', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
          }),
          env,
        )
      ).status,
    ).toBe(400);
    const expired = await buildInitData(42, 'finance-test-token', {
      authDateSec: now / 1000 - 86401,
    });
    expect(
      (
        await handleFinance(
          new Request('https://example.test/api/finance', {
            headers: { 'X-Telegram-Init-Data': expired },
          }),
          env,
        )
      ).status,
    ).toBe(401);
    const owner = await buildInitData(42, 'finance-test-token');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleFinance(
      new Request('https://example.test/api/finance', {
        headers: { 'X-Telegram-Init-Data': owner },
      }),
      { ...env, DB: undefined },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
