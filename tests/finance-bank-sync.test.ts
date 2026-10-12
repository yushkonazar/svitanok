import { handleFinance } from '../web/api-finance.mjs';
import { buildInitData } from './helpers/init-data.js';
import { MONO_RECONCILE_DO_NAME } from '../web/core/mono-reconcile/contract.mjs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { MonoReconcileDO } from '../web/core/mono-reconcile/do.mjs';
import { writeMonoAccounts, ingestTransaction } from '../web/core/finance/store.mjs';
import { parseStatementItem } from '../web/core/adapters/mono.mjs';
import { readFinanceWorkspace, executeFinanceCommand } from '../web/core/finance/workspace.mjs';
import {
  claimMonoClientRefresh,
  claimMonoStatementRefresh,
} from '../web/core/finance/bank-refresh.mjs';
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
const clientRows = [
  {
    id: 'card',
    currencyCode: 980,
    balance: 405000,
    creditLimit: 300000,
    maskedPan: ['537541******1111'],
  },
  { id: 'second', currencyCode: 980, balance: 0, creditLimit: 0 },
];
function bankFetch(
  statementFetch: (url: string, init?: RequestInit) => Response | Promise<Response>,
  accounts = clientRows,
) {
  const client = vi.fn(async () => Response.json({ accounts }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url.endsWith('/personal/client-info') ? client() : statementFetch(url, init),
    ),
  );
  return client;
}
const step = new WeakMap<MonoReconcileDO, () => Promise<void>>();
const advance = (collector: MonoReconcileDO) => step.get(collector)!();
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
  step.set(collector, async () => {
    if (getJob(storage).phase === 'accounts') await collector.alarm();
    await collector.alarm();
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
    bankFetch(fetch);
    await Promise.all([
      collector.requestRefresh('mono:card', undefined, NOW),
      collector.requestRefresh('mono:card', undefined, NOW),
    ]);
    expect(getJob(storage).tasks).toHaveLength(1);
    await advance(collector);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getJob(storage).phase).toBe('ingest');
    await advance(collector);
    await advance(collector);
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
    bankFetch(fetch);
    await collector.requestRefresh('mono:card', undefined, NOW);
    for (let i = 0; i < 3; i++) {
      await advance(collector);
      await advance(collector);
      vi.advanceTimersByTime(61000);
    }
    await advance(collector);
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
    bankFetch(fetch);
    await collector.requestRefresh('mono:card', undefined, NOW);
    await advance(collector);
    for (let i = 0; i < 17; i++) await advance(collector);
    expect(getJob(storage).phase).toBe('fetch');
    await advance(collector);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61000);
    await advance(collector);
    await advance(collector);
    await advance(collector);
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
    bankFetch(fetch);
    await collector.requestRefresh('mono:card', undefined, NOW);
    await advance(collector);
    for (let i = 0; i < 17; i++) await advance(collector);
    vi.advanceTimersByTime(61000);
    await advance(collector);
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
  bankFetch(fetch);
  const initData = await buildInitData(42, 'test-token');
  const request = new Request('https://test.invalid/api/finance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Sync': '2' },
    body: JSON.stringify({ type: 'bank-refresh', initData, payload: { accountId: 'all' } }),
  });
  const response = await handleFinance(request, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ bankSync: { active: true, total: 3 } });
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
  bankFetch(vi.fn(async () => Response.json([row('retry')])));
  await collector.requestRefresh('mono:card', undefined, NOW);
  await advance(collector);
  const failing = vi
    .spyOn(env.DB!, 'batch')
    .mockRejectedValueOnce(new Error('temporary D1 failure'));
  await advance(collector);
  expect((await readFinanceWorkspace(env, NOW)).bankSync?.active).toBe(true);
  await advance(collector);
  await advance(collector);
  failing.mockRestore();
  const f = await readFinanceWorkspace(env, NOW);
  expect(f.transactions.filter((t) => t.id === 'retry')).toHaveLength(1);
  expect(f.bankSync).toMatchObject({ active: false, phase: 'done' });
});
it('ends repeated ingestion failures with a recoverable error instead of a permanently disabled refresh button', async () => {
  const { env, collector, storage } = await setup();
  bankFetch(vi.fn(async () => Response.json([row('retry')])));
  await collector.requestRefresh('mono:card', undefined, NOW);
  await advance(collector);
  const failing = vi.spyOn(env.DB!, 'batch').mockRejectedValue(new Error('D1 failure'));
  for (let i = 0; i < 4; i++) await advance(collector);
  failing.mockRestore();
  await advance(collector);
  expect((await readFinanceWorkspace(env, NOW)).bankSync).toMatchObject({
    active: false,
    phase: 'error',
  });
  expect([...storage.keys()].filter((k) => k.startsWith('bank-page-'))).toHaveLength(0);
});

it('refreshes the real card snapshot after a limit change, without treating credit as income or inserting transactions', async () => {
  const { env, collector, seed } = await setup();
  await writeMonoAccounts(
    env,
    [
      {
        id: 'card',
        currency: 'UAH',
        maskedPan: null,
        balanceMinor: 880000,
        creditLimitMinor: 700000,
        asOf: new Date(NOW - 86400000).toISOString(),
      },
    ],
    NOW - 86400000,
  );
  await seed({
    ...row('grocery', NOW / 1000 - 300, true, -75000),
    operationAmount: -75000,
    currencyCode: 980,
    description: 'Супермаркет',
    balance: 805000,
  });
  await executeFinanceCommand(
    env,
    {
      id: 'limit-reduced',
      version: 0,
      type: 'credit-limit',
      payload: { accountId: 'mono:card', creditLimitMinor: 300000 },
    },
    NOW,
  );
  const pending = await readFinanceWorkspace(env, NOW);
  expect(pending.accounts.find((a) => a.kind === 'mono')).toMatchObject({
    balanceMinor: null,
    balancePending: true,
  });
  const statement = vi.fn();
  const client = bankFetch(statement);
  await collector.requestRefresh('mono:card', undefined, NOW, true);
  await collector.alarm();
  await collector.alarm();
  const f = await readFinanceWorkspace(env, NOW);
  expect(f.accounts.find((a) => a.kind === 'mono')).toMatchObject({
    availableMinor: 405000,
    creditLimitMinor: 300000,
    balanceMinor: 105000,
    balancePending: false,
  });
  expect(f.transactions).toHaveLength(1);
  expect(f.transactions[0]!.description).toBe('Супермаркет');
  expect(f.transactions.filter((t) => t.kind === 'income')).toHaveLength(0);
  expect(statement).not.toHaveBeenCalled();
  expect(client).toHaveBeenCalledOnce();
  expect(f.bankSync).toMatchObject({ active: false, done: 1, total: 1 });
});
it('uses independent client-info and statement cooldowns, shared with nightly reconciliation', async () => {
  const { env } = await setup();
  await claimMonoClientRefresh(env, NOW);
  await claimMonoStatementRefresh(env, NOW);
  await expect(claimMonoClientRefresh(env, NOW + 1000)).rejects.toThrow(/Mono/);
  await expect(claimMonoStatementRefresh(env, NOW + 1000)).rejects.toThrow(/Mono/);
  await expect(claimMonoClientRefresh(env, NOW + 60000)).resolves.toBeUndefined();
});
it('prioritizes recent operations of every card before older held windows', async () => {
  const { env, seed } = await setup();
  await seed(row('old', NOW / 1000 - 65 * 86400, true));
  const tasks = await bankRefreshTasks(env, 'all', undefined, NOW);
  expect(tasks.slice(0, 2).map((t) => t.account.id)).toEqual(['card', 'second']);
  expect(tasks.slice(0, 2).every((t) => t.toS === NOW / 1000)).toBe(true);
});

it('automatically queues only account metadata after saving a credit limit through the owner API', async () => {
  const { env, collector } = await setup();
  env.TELEGRAM_BOT_TOKEN = 'test-token';
  env.TELEGRAM_OWNER_USER_ID = '42';
  env.MONO_RECONCILE = { getByName: () => collector } as never;
  const initData = await buildInitData(42, 'test-token');
  const response = await handleFinance(
    new Request('https://test.invalid/api/finance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData,
        id: 'credit-via-api',
        version: 0,
        type: 'credit-limit',
        payload: { accountId: 'mono:card', creditLimitMinor: 300000 },
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    bankSync: { active: true, phase: 'accounts', total: 1 },
  });
  const statements = vi.fn();
  bankFetch(statements);
  await collector.alarm();
  await collector.alarm();
  expect(statements).not.toHaveBeenCalled();
  expect(
    (await readFinanceWorkspace(env, NOW)).accounts.find((a) => a.kind === 'mono'),
  ).toMatchObject({ balanceMinor: 105000, availableMinor: 405000, creditLimitMinor: 300000 });
});
it('refreshes a changed limit during statement ingestion without losing queued records', async () => {
  const { env, collector } = await setup();
  const statement = vi.fn(async () => Response.json([row('kept')]));
  bankFetch(statement);
  await collector.requestRefresh('mono:card', undefined, NOW);
  await collector.alarm();
  await collector.alarm();
  await collector.requestRefresh('mono:card', undefined, NOW + 61000, true);
  vi.advanceTimersByTime(61000);
  await collector.alarm();
  await collector.alarm();
  await collector.alarm();
  const f = await readFinanceWorkspace(env, NOW + 61000);
  expect(f.transactions.filter((t) => t.id === 'kept')).toHaveLength(1);
  expect(f.bankSync?.active).toBe(false);
});
it('waits on the bank client-info limit before importing statements and retains visible progress', async () => {
  const { env, collector } = await setup();
  const statement = vi.fn(async () => Response.json([])),
    client = bankFetch(statement);
  client.mockResolvedValueOnce(new Response('', { status: 429 }));
  await collector.requestRefresh('mono:card', undefined, NOW);
  await collector.alarm();
  const f = await readFinanceWorkspace(env, NOW);
  expect(f.bankSync).toMatchObject({ active: true, phase: 'accounts' });
  expect(statement).not.toHaveBeenCalled();
  vi.advanceTimersByTime(61000);
  await collector.alarm();
  await collector.alarm();
  await collector.alarm();
  await collector.alarm();
  expect(client).toHaveBeenCalledTimes(2);
  expect((await readFinanceWorkspace(env, NOW)).bankSync?.active).toBe(false);
});
