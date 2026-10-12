import { handleFinance } from '../web/api-finance.mjs';
import { buildInitData } from './helpers/init-data.js';
import { MONO_RECONCILE_DO_NAME } from '../web/core/mono-reconcile/contract.mjs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { MonoReconcileDO } from '../web/core/mono-reconcile/do.mjs';
import { writeMonoAccounts, ingestTransaction } from '../web/core/finance/store.mjs';
import { parseStatementItem } from '../web/core/adapters/mono.mjs';
import { readFinanceWorkspace } from '../web/core/finance/workspace.mjs';
import { bankRefreshTasks } from '../web/core/finance/bank-sync.mjs';
const NOW = Date.parse('2026-10-12T18:00:00Z');
const row = (id: string, time = NOW / 1000 - 86400, hold = false, amount = -13464) => ({
  id,
  time,
  description: 'Apple',
  amount,
  operationAmount: -299,
  currencyCode: 840,
  mcc: 5818,
  balance: 500000,
  hold,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function getJob(storage: Map<string, unknown>) {
  return storage.get('bank-refresh') as { tasks: unknown[]; phase: string };
}
async function setup() {
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
  const DB = {
    ...d1.stub,
    prepare: (sql: string) => {
      const s = d1.stub.prepare(sql);
      return { ...s, ...s.bind() };
    },
  };
  const env = workerEnv({ DB, MONO_TOKEN: 'test' });
  await writeMonoAccounts(
    env,
    [
      { id: 'card', currency: 'UAH', maskedPan: null },
      { id: 'second', currency: 'UAH', maskedPan: null },
    ],
    NOW,
  );
  await readFinanceWorkspace(env, NOW);
  const storage = new Map<string, unknown>(),
    alarms: number[] = [];
  const collector = new MonoReconcileDO(
    {
      storage: {
        get: async (key: string) => structuredClone(storage.get(key)),
        put: async (key: string | Record<string, unknown>, value: unknown) => {
          if (typeof key === 'string') storage.set(key, structuredClone(value));
          else for (const [k, v] of Object.entries(key)) storage.set(k, structuredClone(v));
        },
        delete: async (key: string | string[]) => {
          for (const k of Array.isArray(key) ? key : [key]) storage.delete(k);
        },
        setAlarm: async (at: number) => {
          alarms.push(at);
        },
      },
    } as never,
    env,
  );
  const seed = async (item: ReturnType<typeof row>) =>
    ingestTransaction(env, {
      item: parseStatementItem(item)!,
      account: 'card',
      accountCurrency: 'UAH',
      silent: true,
    });
  return { env, db: d1.db, collector, storage, alarms, seed };
}
describe('shared resumable Monobank refresh', () => {
  it('coalesces simultaneous requests, imports in batches and preserves owner links when the bank settles', async () => {
    const { env, db, collector, storage, seed } = await setup();
    await seed(row('apple', undefined, true));
    db.prepare('UPDATE transactions SET raw_json=json_patch(raw_json,?) WHERE id=?').run(
      JSON.stringify({
        financeReference: 'apple-sub',
        financeKind: 'expense',
        financeBankVerifiedByOwner: true,
        financeConfirmedAmountMinor: -13464,
      }),
      'apple',
    );
    const fetch = vi.fn(async () =>
      Response.json([row('apple', undefined, false, -14000), row('new')]),
    );
    vi.stubGlobal('fetch', fetch);
    await Promise.all([
      collector.requestRefresh('mono:card', undefined, NOW),
      collector.requestRefresh('mono:card', undefined, NOW),
    ]);
    expect(getJob(storage).tasks).toHaveLength(1);
    await collector.alarm();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getJob(storage).phase).toBe('ingest');
    await collector.alarm();
    await collector.alarm();
    const f = await readFinanceWorkspace(env, NOW);
    expect(f.transactions).toHaveLength(2);
    expect(f.bankSync).toMatchObject({ active: false, phase: 'done', imported: 1, updated: 1 });
    expect(f.transactions.find((t) => t.id === 'apple')).toMatchObject({
      bankHold: false,
      bankVerifiedByOwner: true,
      bankAmountChanged: true,
      reference: 'apple-sub',
      amountUah: -14000,
    });
    expect(f.version).toBe(2);
    await seed(row('apple', undefined, true));
    expect(
      (await readFinanceWorkspace(env, NOW)).transactions.find((t) => t.id === 'apple')!.bankHold,
    ).toBe(false);
    expect([...storage.keys()].filter((k) => k.startsWith('bank-page-'))).toHaveLength(0);
  });
  it('queries older held windows and never interprets an absent authorization as a posted payment', async () => {
    const { env, collector, seed } = await setup();
    await seed(row('old', NOW / 1000 - 65 * 86400, true));
    const tasks = await bankRefreshTasks(env, 'mono:card', undefined, NOW);
    expect(tasks).toHaveLength(3);
    const fetch = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetch);
    await collector.requestRefresh('mono:card', undefined, NOW);
    for (let i = 0; i < 3; i++) {
      await collector.alarm();
      await collector.alarm();
      vi.advanceTimersByTime(61000);
    }
    await collector.alarm();
    const f = await readFinanceWorkspace(env, NOW);
    expect(f.transactions.find((t) => t.id === 'old')).toMatchObject({
      bankHold: true,
      bankMissingFromStatement: true,
      kind: 'unclassified',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(f.bankSync?.active).toBe(false);
    expect(await bankRefreshTasks(env, 'mono:card', undefined, NOW)).toHaveLength(3);
  });
  it('paginates 500 rows with the inclusive boundary, waits for the shared limit and leaves no duplicate debit', async () => {
    const { env, db, collector, storage } = await setup();
    const items = Array.from({ length: 500 }, (_, i) => row(`page-${i}`, NOW / 1000 - i - 1));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(items))
      .mockResolvedValueOnce(Response.json([items.at(-1), row('older', NOW / 1000 - 1000)]));
    vi.stubGlobal('fetch', fetch);
    await collector.requestRefresh('mono:card', undefined, NOW);
    await collector.alarm();
    for (let i = 0; i < 17; i++) await collector.alarm();
    expect(getJob(storage).phase).toBe('fetch');
    await collector.alarm();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61000);
    await collector.alarm();
    await collector.alarm();
    await collector.alarm();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(501);
    expect((await readFinanceWorkspace(env, NOW)).bankSync).toMatchObject({
      active: false,
      imported: 501,
    });
  });
  it('does not mark unseen holds missing when a later page fails and allows a fresh retry', async () => {
    const { env, collector, seed } = await setup();
    await seed(row('unseen', NOW / 1000 - 10000, true));
    const items = Array.from({ length: 500 }, (_, i) => row(`page-${i}`, NOW / 1000 - i - 1));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(items))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    await collector.requestRefresh('mono:card', undefined, NOW);
    await collector.alarm();
    for (let i = 0; i < 17; i++) await collector.alarm();
    vi.advanceTimersByTime(61000);
    await collector.alarm();
    expect(
      (await readFinanceWorkspace(env, NOW)).transactions.find((t) => t.id === 'unseen')!
        .bankMissingFromStatement,
    ).toBe(false);
    expect((await readFinanceWorkspace(env, NOW)).bankSync?.phase).toBe('error');
    await collector.requestRefresh('mono:card', undefined, NOW + 61000);
    expect((await readFinanceWorkspace(env, NOW)).bankSync?.active).toBe(true);
  });
  it('supports all connected cards and rejects a target operation belonging to another card', async () => {
    const { env, seed } = await setup();
    await seed(row('apple', undefined, true));
    expect((await bankRefreshTasks(env, 'all', undefined, NOW)).map((t) => t.account.id)).toEqual([
      'card',
      'second',
    ]);
    await expect(bankRefreshTasks(env, 'mono:second', 'apple', NOW)).rejects.toThrow(/операція/);
    await expect(bankRefreshTasks(env, 'mono:unknown', undefined, NOW)).rejects.toThrow(/рахунок/);
  });
});

it('queues the authenticated v2 API refresh without waiting for Monobank and keeps the owner boundary', async () => {
  const { env, collector } = await setup();
  env.TELEGRAM_BOT_TOKEN = 'test-token';
  env.TELEGRAM_OWNER_USER_ID = '42';
  env.MONO_RECONCILE = {
    getByName: (name: string) => (name === MONO_RECONCILE_DO_NAME ? collector : null),
  } as never;
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const initData = await buildInitData(42, 'test-token');
  const request = new Request('https://test.invalid/api/finance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Sync': '2' },
    body: JSON.stringify({ type: 'bank-refresh', initData, payload: { accountId: 'all' } }),
  });
  const response = await handleFinance(request, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ bankSync: { active: true, total: 2 } });
  expect(fetch).not.toHaveBeenCalled();
  const stranger = await buildInitData(7, 'test-token');
  const denied = await handleFinance(
    new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Finance-Sync': '2' },
      body: JSON.stringify({
        type: 'bank-refresh',
        initData: stranger,
        payload: { accountId: 'all' },
      }),
    }),
    env,
  );
  expect(denied.status).toBe(403);
});
it('resumes an ingestion failure and finishes without creating a duplicate', async () => {
  const { env, collector } = await setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([row('retry')])),
  );
  await collector.requestRefresh('mono:card', undefined, NOW);
  await collector.alarm();
  const failing = vi
    .spyOn(env.DB!, 'batch')
    .mockRejectedValueOnce(new Error('temporary D1 failure'));
  await collector.alarm();
  expect((await readFinanceWorkspace(env, NOW)).bankSync?.active).toBe(true);
  await collector.alarm();
  await collector.alarm();
  failing.mockRestore();
  const f = await readFinanceWorkspace(env, NOW);
  expect(f.transactions.filter((t) => t.id === 'retry')).toHaveLength(1);
  expect(f.bankSync).toMatchObject({ active: false, phase: 'done' });
});
it('ends repeated ingestion failures with a recoverable error instead of a permanently disabled refresh button', async () => {
  const { env, collector, storage } = await setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([row('retry')])),
  );
  await collector.requestRefresh('mono:card', undefined, NOW);
  await collector.alarm();
  const failing = vi.spyOn(env.DB!, 'batch').mockRejectedValue(new Error('D1 failure'));
  for (let i = 0; i < 4; i++) await collector.alarm();
  failing.mockRestore();
  await collector.alarm();
  expect((await readFinanceWorkspace(env, NOW)).bankSync).toMatchObject({
    active: false,
    phase: 'error',
  });
  expect([...storage.keys()].filter((k) => k.startsWith('bank-page-'))).toHaveLength(0);
});
