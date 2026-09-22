import { describe, expect, it } from 'vitest';
import { readDeliverySlo, REMINDER_DELIVERY_SLO_MS } from '../web/core/ops/delivery-slo.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';
import { memoryKv } from './helpers/kv.js';

const NOW = Date.parse('2026-09-23T09:00:00.000Z'); // 12:00 Kyiv (UTC+3)

function setup(state = {}) {
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql']);
  const kv = memoryKv(new Map([['state', JSON.stringify(state)]]));
  return { d1, env: workerEnv({ DB: d1.stub, BRIEFING: kv }) };
}

describe('delivery SLO', () => {
  it('називає прострочене pending нагадування порушенням, а не нульовою доставкою', async () => {
    const { d1, env } = setup({ lastSentDate: '2026-09-23' });
    d1.db
      .prepare(
        `INSERT INTO reminders (id, text, due_at, status) VALUES ('late', 'test', ?, 'pending')`,
      )
      .run(new Date(NOW - REMINDER_DELIVERY_SLO_MS - 1).toISOString());

    const slo = await readDeliverySlo(env, NOW);
    expect(slo.reminders).toMatchObject({ due: 1, breached: 1, status: 'breached' });
    expect(slo.briefing).toMatchObject({ status: 'ok' });
  });

  it('до дедлайну briefing чесно pending, а після дедлайну без підтвердження breached', async () => {
    const { env } = setup();
    const beforeDeadline = Date.parse('2026-09-23T07:30:00.000Z'); // 10:30 Kyiv
    expect((await readDeliverySlo(env, beforeDeadline)).briefing.status).toBe('pending_window');
    expect((await readDeliverySlo(env, NOW)).briefing.status).toBe('breached');
  });
});
