/// <reference types="@cloudflare/vitest-plugin/types" />
import { env as runtimeEnv } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { executePlanCommand, readPlanWorkspace } from '../../web/core/motivation/store.mjs';
const env = runtimeEnv as Env & {
  DB: NonNullable<Env['DB']>;
  TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(async () => {
  await reset();
});
it('commits exactly one concurrent redemption in real D1, including its coupon, XP and receipt', async () => {
  const now = Date.now(),
    date = new Date(now).toISOString().slice(0, 10);
  let revision = 0;
  const write = (op: string, payload: Record<string, unknown> = {}, id?: string) =>
    executePlanCommand(
      env,
      { op, payload, id, revision: revision++, commandId: crypto.randomUUID() },
      now,
    );
  await write('settings', { enabled: true });
  const task = await write('task-save', {
    date,
    title: 'Test result',
    criterion: 'One concrete result',
    xp: 35,
    deadlineKind: 'time',
    dueAt: new Date(now + 3600000).toISOString(),
  });
  await write('accept', { date });
  await write('report', { units: 1 }, task.id);
  const reward = await write('reward-save', {
    title: 'Test reward',
    price: 30,
    scale: 'near',
    repeatable: true,
  });
  const commands = [0, 1].map(() => ({
    op: 'redeem',
    id: reward.id,
    payload: {},
    revision,
    commandId: crypto.randomUUID(),
  }));
  const results = await Promise.allSettled(commands.map((c) => executePlanCommand(env, c, now)));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const workspace = await readPlanWorkspace(env, now);
  expect(workspace.wallet.balance).toBe(5);
  expect(workspace.wallet.experience).toBe(35);
  expect(workspace.coupons).toHaveLength(1);
  const index = results.findIndex((r) => r.status === 'fulfilled');
  await expect(executePlanCommand(env, commands[index]!, now)).resolves.toMatchObject({
    id: workspace.coupons[0].id,
  });
  const sum = await env.DB.prepare('SELECT sum(delta) AS balance FROM motivation_ledger').first<{
    balance: number;
  }>();
  expect(sum?.balance).toBe(5);
});
