import { afterEach, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { ingestTransaction, writeMonoAccounts } from '../web/core/finance/store.mjs';
import { parseStatementItem } from '../web/core/adapters/mono.mjs';
import {
  refreshMonoAccount,
  claimMonoStatementRefresh,
} from '../web/core/finance/bank-refresh.mjs';
import { monoReconcileTask } from '../web/core/finance/reconcile.mjs';
import { handleFinance } from '../web/api-finance.mjs';
import { memoryKv } from './helpers/kv.js';
const now = Date.parse('2026-10-05T20:35:00Z');
const account = 'card-uah';
const bankRow = {
  id: 'deposit-8000',
  time: Math.floor(now / 1000) - 86400 * 3,
  description: 'Термінал mono',
  amount: 800000,
  operationAmount: 800000,
  currencyCode: 980,
  mcc: 6012,
  balance: 910000,
  hold: true,
};
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0005_finance.sql',
    '0007_instructions_plans.sql',
  ]);
  const env = workerEnv({ DB: d1.stub, MONO_TOKEN: 'test-token', BRIEFING: memoryKv(new Map()) });
  await writeMonoAccounts(env, [{ id: account, currency: 'UAH', maskedPan: null }], now);
  await ingestTransaction(env, {
    item: parseStatementItem(bankRow)!,
    account,
    accountCurrency: 'UAH',
    silent: true,
  });
  return { env, db: d1.db };
}
it('rereads older holds from the bank without duplicate rows or clearing finance classifications', async () => {
  const { env, db } = await setup();
  db.prepare(`UPDATE transactions SET raw_json=json_patch(raw_json,?) WHERE id=?`).run(
    JSON.stringify({ financeKind: 'income', financeReference: 'kept-reference' }),
    bankRow.id,
  );
  const fetch = vi.fn(async () => Response.json([{ ...bankRow, hold: false }]));
  vi.stubGlobal('fetch', fetch);
  expect(await refreshMonoAccount(env, `mono:${account}`, now)).toEqual({
    updated: 1,
    imported: 0,
  });
  const row = db.prepare('SELECT raw_json FROM transactions WHERE id=?').get(bankRow.id) as {
    raw_json: string;
  };
  expect(JSON.parse(row.raw_json)).toMatchObject({
    hold: false,
    financeKind: 'income',
    financeReference: 'kept-reference',
  });
  expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: 1 });
  await expect(refreshMonoAccount(env, `mono:${account}`, now + 59000)).rejects.toThrow('429');
  expect(fetch).toHaveBeenCalledTimes(1);
  await refreshMonoAccount(env, `mono:${account}`, now + 60000);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('prevents simultaneous refreshes and rejects an unconnected account before calling the bank', async () => {
  const { env } = await setup();
  const calls = await Promise.allSettled([
    claimMonoStatementRefresh(env, now),
    claimMonoStatementRefresh(env, now),
  ]);
  expect(calls.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(refreshMonoAccount(env, 'mono:other', now)).rejects.toThrow('Некоректний рахунок');
  expect(fetch).not.toHaveBeenCalled();
});
it('nightly reconciliation revisits previous days and settles their holds', async () => {
  const { env, db } = await setup();
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('client-info'))
        return Response.json({ accounts: [{ id: account, currencyCode: 980 }] });
      return Response.json([{ ...bankRow, hold: false }]);
    }),
  );
  await monoReconcileTask(env, now);
  await monoReconcileTask(env, now + 300000);
  const request = calls.find((url) => url.includes('/statement/'))!;
  expect(Number(request.split('/').at(-1)) - Number(request.split('/').at(-2))).toBe(31 * 86400);
  const row = db.prepare('SELECT raw_json FROM transactions WHERE id=?').get(bankRow.id) as {
    raw_json: string;
  };
  expect(JSON.parse(row.raw_json).hold).toBe(false);
});

it('requires owner authentication before a bank refresh', async () => {
  const { env } = await setup();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const response = await handleFinance(
    new Request('https://svitanok.yushko.dev/api/finance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bank-refresh', payload: { accountId: `mono:${account}` } }),
    }),
    env,
  );
  expect([401, 403]).toContain(response.status);
  expect(fetch).not.toHaveBeenCalled();
});
