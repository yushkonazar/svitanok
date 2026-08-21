import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRun } from '../web/agent-run-do.mjs';
import { AGENT_RUN_DO_KEEP_MS } from '../web/agent-run-core.mjs';

/* Durable Object прогону — сам обʼєкт, а не чиста ухвала (та в
 * agent-run-core.test.ts). Перевіряємо рівно те, заради чого DO й заводився:
 * стан переживає виклики, надгробок видно ОДРАЗУ (на відміну від KV), а
 * сховище по собі прибирається — інакше кожен прогін лишав би вічний запис.
 *
 * `cloudflare:workers` у тестах підмінений заглушкою (vitest.config.ts): базовий
 * клас там робить рівно те, що робить справжній, — кладе ctx/env на this. */

const NOW = 1_752_800_000_000;

/** Сховище DO: Map + журнал алармів (справжнє API — те саме, лише асинхронне). */
function fakeCtx() {
  const map = new Map<string, unknown>();
  const alarms: number[] = [];
  return {
    alarms,
    map,
    storage: {
      get: async (k: string) => map.get(k),
      put: async (k: string, v: unknown) => void map.set(k, v),
      deleteAll: async () => void map.clear(),
      setAlarm: async (t: number) => void alarms.push(t),
    },
  };
}

let ctx: ReturnType<typeof fakeCtx>;
let obj: {
  claimStep: (step: number, nowMs: number) => Promise<{ ok: boolean; error?: string }>;
  finish: (nowMs: number) => Promise<void>;
  alarm: () => Promise<void>;
};

beforeEach(() => {
  ctx = fakeCtx();
  obj = new AgentRun(ctx, {});
});

describe('AgentRun — лічильник кроків у DO', () => {
  it('послідовні кроки приймаються, стан переживає виклики', async () => {
    expect(await obj.claimStep(0, NOW)).toMatchObject({ ok: true });
    expect(await obj.claimStep(1, NOW + 11_000)).toMatchObject({ ok: true });
    expect(await obj.claimStep(2, NOW + 22_000)).toMatchObject({ ok: true });
  });

  it('повторний крок відхиляється — реплей закрито НЕ на «краще ніж нічого»', async () => {
    await obj.claimStep(0, NOW);
    await obj.claimStep(1, NOW + 11_000);
    expect(await obj.claimStep(1, NOW + 12_000)).toMatchObject({
      ok: false,
      error: 'step-replayed',
    });
  });

  it('після finish жоден крок не проходить — і це видно ОДРАЗУ, без лагу KV', async () => {
    await obj.claimStep(0, NOW);
    await obj.finish(NOW + 30_000);
    expect(await obj.claimStep(1, NOW + 31_000)).toMatchObject({
      ok: false,
      error: 'run-finished',
    });
  });

  it('кожен дотик відсуває прибирання сховища на життя токена', async () => {
    await obj.claimStep(0, NOW);
    expect(ctx.alarms.at(-1)).toBe(NOW + AGENT_RUN_DO_KEEP_MS);
    await obj.finish(NOW + 30_000);
    expect(ctx.alarms.at(-1)).toBe(NOW + 30_000 + AGENT_RUN_DO_KEEP_MS);
  });

  it('аларм чистить сховище — інакше кожен прогін лишав би вічний запис', async () => {
    await obj.claimStep(0, NOW);
    expect(ctx.map.size).toBeGreaterThan(0);
    await obj.alarm();
    expect(ctx.map.size).toBe(0);
  });

  it('finish без жодного кроку не падає (прогін, що вмер на старті)', async () => {
    await obj.finish(NOW);
    expect(await obj.claimStep(0, NOW + 1)).toMatchObject({ ok: false, error: 'run-finished' });
  });
});
