import { expect, it } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { executeFinanceCommand, readFinanceWorkspace } from '../web/core/finance/workspace.mjs';
import { writeMonoAccounts } from '../web/core/finance/store.mjs';

const now = Date.parse('2026-10-08T15:00:00Z');
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0005_finance.sql',
    '0028_mini_app_finance.sql',
    '0033_finance_history_and_links.sql',
    '0035_finance_budget_planning.sql',
    '0029_finance_credit_limits.sql',
  ]);
  return { d1, env: workerEnv({ DB: d1.stub }) };
}
it('separates owned money from bank availability, preserves overrides and never books credit as income', async () => {
  const { env, d1 } = setup();
  await writeMonoAccounts(
    env,
    [
      {
        id: 'card',
        currency: 'UAH',
        maskedPan: null,
        balanceMinor: 510000,
        creditLimitMinor: 700000,
        asOf: new Date(now).toISOString(),
      },
    ],
    now,
  );
  const before = await readFinanceWorkspace(env, now);
  expect(before.accounts.find((a) => a.kind === 'mono')).toMatchObject({
    balanceMinor: -190000,
    availableMinor: 510000,
    creditLimitMinor: 700000,
    creditLimitSource: 'bank',
  });
  const command = {
    id: 'credit-limit-001',
    version: 0,
    type: 'credit-limit',
    payload: { accountId: 'mono:card', creditLimitMinor: 600000 },
  };
  await executeFinanceCommand(env, command, now);
  await executeFinanceCommand(env, command, now);
  await writeMonoAccounts(
    env,
    [
      {
        id: 'card',
        currency: 'UAH',
        maskedPan: null,
        balanceMinor: 520000,
        creditLimitMinor: 800000,
        asOf: new Date(now + 60000).toISOString(),
      },
    ],
    now + 60000,
  );
  const manual = await readFinanceWorkspace(env, now + 60000);
  expect(manual.accounts.find((a) => a.kind === 'mono')).toMatchObject({
    balanceMinor: -80000,
    creditLimitSource: 'manual',
  });
  expect(manual.transactions).toHaveLength(0);
  await executeFinanceCommand(
    env,
    {
      ...command,
      id: 'credit-reset-001',
      version: 1,
      payload: { accountId: 'mono:card', creditLimitMinor: null },
    },
    now + 60000,
  );
  expect(
    (await readFinanceWorkspace(env, now + 60000)).accounts.find((a) => a.kind === 'mono')
      ?.balanceMinor,
  ).toBe(-280000);
  d1.db
    .prepare(
      'INSERT INTO transactions(id,at,amount,currency,amount_uah,balance,raw_json,flags_json) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      'latest',
      new Date(now + 120000).toISOString(),
      -20000,
      'UAH',
      -20000,
      500000,
      JSON.stringify({ account: 'card' }),
      '[]',
    );
  expect(
    (await readFinanceWorkspace(env, now + 120000)).accounts.find((a) => a.kind === 'mono')
      ?.balanceMinor,
  ).toBe(-300000);
  await expect(
    executeFinanceCommand(
      env,
      {
        ...command,
        id: 'invalid-limit-001',
        version: 2,
        payload: { accountId: 'mono:card', creditLimitMinor: -1 },
      },
      now + 120000,
    ),
  ).rejects.toThrow();
  expect((await readFinanceWorkspace(env, now + 120000)).version).toBe(2);
});
it('does not present borrowed funds as owned before a legacy card limit has been confirmed', async () => {
  const { env } = setup();
  await writeMonoAccounts(
    env,
    [
      {
        id: 'legacy',
        currency: 'UAH',
        maskedPan: null,
        balanceMinor: 510000,
        asOf: new Date(now).toISOString(),
      },
    ],
    now,
  );
  expect(
    (await readFinanceWorkspace(env, now)).accounts.find((a) => a.kind === 'mono'),
  ).toMatchObject({ balanceMinor: null, availableMinor: 510000, creditLimitMinor: null });
  await executeFinanceCommand(
    env,
    {
      id: 'legacy-limit-001',
      version: 0,
      type: 'credit-limit',
      payload: { accountId: 'mono:legacy', creditLimitMinor: 700000 },
    },
    now,
  );
  expect(
    (await readFinanceWorkspace(env, now)).accounts.find((a) => a.kind === 'mono')?.balanceMinor,
  ).toBe(-190000);
});
it('keeps historical shifts, personal taxi income, cash corrections and the fleet reserve linked without double income', async () => {
  const { env } = setup();
  const run = async (id: string, type: string, payload: Record<string, unknown>) =>
    executeFinanceCommand(
      env,
      { id, type, payload, version: (await readFinanceWorkspace(env, now)).version },
      now,
    );
  await run('shift-old-001', 'taxi-entry', {
    at: '2026-10-06T18:00:00Z',
    accountId: 'cash',
    netCashMinor: 400000,
    commissionMinor: 70000,
    fuelMinor: 100000,
    receivedCashMinor: 200000,
  });
  const before = await readFinanceWorkspace(env, now);
  expect(before.reserveMinor).toBe(50000);
  for (const [i, personalType] of ['change', 'cash-tip', 'direct'].entries()) {
    const command = {
      id: `personal-${i}-001`,
      type: 'taxi-personal-income',
      version: (await readFinanceWorkspace(env, now)).version,
      payload: { accountId: 'cash', personalType, amountMinor: 10000 },
    };
    await executeFinanceCommand(env, command, now);
    await executeFinanceCommand(env, command, now);
  }
  const extra = await readFinanceWorkspace(env, now);
  expect(extra.accounts[0]?.balanceMinor).toBe(230000);
  expect(extra.reserveMinor).toBe(before.reserveMinor);
  expect(extra.taxiWeeks).toEqual(before.taxiWeeks);
  expect(extra.transactions.filter((t) => t.kind === 'income')).toHaveLength(3);
  await run('expense-001', 'transaction', {
    accountId: 'cash',
    kind: 'expense',
    amountMinor: 35000,
    category: 'продукти',
  });
  await run('balance-001', 'account-balance', { accountId: 'cash', balanceMinor: 180000 });
  const corrected = await readFinanceWorkspace(env, now);
  expect(corrected.accounts[0]?.balanceMinor).toBe(180000);
  expect(corrected.transactions.filter((t) => t.kind === 'income')).toHaveLength(3);
  expect(corrected.reserveMinor).toBe(50000);
  await expect(
    run('not-cash-001', 'taxi-personal-income', {
      accountId: 'cash',
      personalType: 'unknown',
      amountMinor: 1,
    }),
  ).rejects.toThrow();
});
