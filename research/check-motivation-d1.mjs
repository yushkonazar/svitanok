// Local Miniflare D1 acceptance; no production bindings or external services.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { executePlanCommand, readPlanWorkspace } from '../web/core/motivation/store.mjs';
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}',
    compatibilityDate: '2026-08-20',
    d1Databases: ['DB'],
  }),
);
try {
  const DB = await mf.getD1Database('DB'),
    env = { DB },
    now = Date.now(),
    date = new Date(now).toISOString().slice(0, 10);
  const sql = await readFile(
    new URL('../web/core/migrations/0042_motivation_plan.sql', import.meta.url),
    'utf8',
  );
  await DB.batch(
    sql
      .split(';')
      .filter((s) => s.trim())
      .map((s) => DB.prepare(s)),
  );
  let revision = 0;
  const write = (op, payload = {}, id) =>
    executePlanCommand(
      env,
      { op, payload, id, revision: revision++, commandId: crypto.randomUUID() },
      now,
    );
  await write('settings', { enabled: true });
  const task = await write('task-save', {
    date,
    title: 'Local result',
    criterion: 'One result',
    xp: 35,
    deadlineKind: 'time',
    dueAt: new Date(now + 3600000).toISOString(),
  });
  await write('accept', { date });
  await write('report', { units: 1 }, task.id);
  const reward = await write('reward-save', {
    title: 'Local reward',
    price: 30,
    repeatable: true,
    scale: 'near',
  });
  const commands = [0, 1].map(() => ({
    op: 'redeem',
    payload: {},
    id: reward.id,
    revision,
    commandId: crypto.randomUUID(),
  }));
  const results = await Promise.allSettled(commands.map((c) => executePlanCommand(env, c, now)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const workspace = await readPlanWorkspace(env, now);
  assert.equal(workspace.wallet.balance, 5);
  assert.equal(workspace.wallet.experience, 35);
  assert.equal(workspace.coupons.length, 1);
  const winner = results.findIndex((r) => r.status === 'fulfilled');
  await executePlanCommand(env, commands[winner], now);
  assert.equal((await readPlanWorkspace(env, now)).wallet.balance, 5);
  assert.equal((await DB.prepare('SELECT sum(delta) AS n FROM motivation_ledger').first()).n, 5);
  console.log(
    JSON.stringify({
      runtime: 'local Miniflare D1',
      concurrentRedemptions: results.map((r) => r.status),
      wallet: workspace.wallet,
      coupons: workspace.coupons.length,
      retry: 'same receipt; no second debit',
    }),
  );
} finally {
  await mf.dispose();
}
