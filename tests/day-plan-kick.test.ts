// Задача day-plan-kick (етап 3 PR-8, 07 §7): 00:05 Києва - ланцюг на завтра,
// якщо план дня увімкнено, завтра робочий і не поїздка; мітка доби в KV;
// повторний старт на ту саму дату - ні (workflow_id у day_plans).

import { describe, it, expect } from 'vitest';
import { dayPlanKickTask, DAY_PLAN_KICK_MARKER_KEY } from '../web/core/day-plan/kick.mjs';
import { runFactsSet } from '../web/core/tools/facts.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0004_ideas_travel.sql',
  '0007_instructions_plans.sql',
];
// Неділя 06.09.2026 00:10 Києва = сб 05.09 21:10Z; завтра - понеділок 07.09.
const SUN_0010 = Date.parse('2026-09-05T21:10:00.000Z');
const SAT_2350 = Date.parse('2026-09-05T20:50:00.000Z');
// Пʼятниця 04.09 00:10 Києва; завтра - субота.
const FRI_0010 = Date.parse('2026-09-03T21:10:00.000Z');

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const kv = new Map<string, string>();
  const created: { id: string; params: unknown }[] = [];
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(kv),
    DAY_PLAN: {
      create: async (o: { id: string; params: unknown }) => void created.push(o),
      get: async () => ({ sendEvent: async () => undefined }),
    } as unknown as Env['DAY_PLAN'],
  });
  const enable = () =>
    runFactsSet(
      env,
      { kind: 'setting', key: 'day_plan', value: { enabled: true }, source: 'owner' },
      SUN_0010,
    );
  return { d1, kv, env, created, enable };
}

describe('dayPlanKickTask', () => {
  it('поза 00:05-00:59 - пропуск без мітки; вимкнено - мітка дня і тиша', async () => {
    const { env, kv } = setup();
    expect(await dayPlanKickTask(env, SAT_2350)).toEqual({ skipped: 'hour' });
    expect(kv.has(DAY_PLAN_KICK_MARKER_KEY)).toBe(false);
    expect(await dayPlanKickTask(env, SUN_0010)).toEqual({ skipped: 'disabled' });
    expect(kv.get(DAY_PLAN_KICK_MARKER_KEY)).toBe('2026-09-06');
    expect(await dayPlanKickTask(env, SUN_0010 + 60_000)).toEqual({ skipped: 'done' });
  });

  it('увімкнено, завтра робочий - ланцюг на завтра: рядок chains, Workflow.create(id=chainId), day_plans.workflow_id', async () => {
    const { env, d1, created, enable } = setup();
    await enable();
    const out = await dayPlanKickTask(env, SUN_0010);
    expect(out).toMatchObject({ started: true, date: '2026-09-07' });
    const chainId = (out as { chainId: string }).chainId;
    expect(created).toEqual([{ id: chainId, params: { chainId, date: '2026-09-07' } }]);
    expect(d1.db.prepare(`SELECT kind, status, workflow_id FROM chains`).get()).toEqual({
      kind: 'day-plan',
      status: 'running',
      workflow_id: chainId,
    });
    expect(
      d1.db.prepare(`SELECT status, workflow_id FROM day_plans WHERE date = '2026-09-07'`).get(),
    ).toEqual({ status: 'intent', workflow_id: chainId });
    // Той самий день, нова мітка стерта - ланцюг на дату вже є.
    await env.BRIEFING.delete(DAY_PLAN_KICK_MARKER_KEY);
    expect(await dayPlanKickTask(env, SUN_0010 + 60_000)).toEqual({
      skipped: 'exists',
      date: '2026-09-07',
    });
    expect(created).toHaveLength(1);
  });

  it('завтра вихідний за weekdays або день поїздки - пропуск із міткою, без ланцюга', async () => {
    const { env, d1, created, enable } = setup();
    await enable();
    expect(await dayPlanKickTask(env, FRI_0010)).toEqual({
      skipped: 'weekend',
      date: '2026-09-05',
    });
    await env.BRIEFING.delete(DAY_PLAN_KICK_MARKER_KEY);
    d1.db
      .prepare(
        `INSERT INTO trips (id, to_text, date_from, date_to, status) VALUES ('t1', 'Львів', '2026-09-06', '2026-09-08', 'planned')`,
      )
      .run();
    expect(await dayPlanKickTask(env, SUN_0010)).toEqual({ skipped: 'trip', date: '2026-09-07' });
    expect(created).toHaveLength(0);
  });

  it('збій Workflow.create - помилка нагору, мітка НЕ ставиться (наступний тік у вікні спробує знову)', async () => {
    const { env, kv, enable } = setup();
    await enable();
    (env as { DAY_PLAN?: unknown }).DAY_PLAN = {
      create: async () => {
        throw new Error('workflows down');
      },
      get: async () => ({ sendEvent: async () => undefined }),
    };
    await expect(dayPlanKickTask(env, SUN_0010)).rejects.toThrow('workflows down');
    expect(kv.has(DAY_PLAN_KICK_MARKER_KEY)).toBe(false);
  });
});
