import { describe, expect, it } from 'vitest';
import { BriefDispatchDO } from '../web/core/brief-dispatch/do.mjs';
import {
  BRIEF_DISPATCH_DO_NAME,
  BRIEF_DISPATCH_KEY,
} from '../web/core/brief-dispatch/contract.mjs';
import {
  briefDispatchClaim,
  briefDispatchComplete,
  briefDispatchRead,
  briefDispatchRelease,
} from '../web/core/brief-dispatch/client.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

function setup(seed: Record<string, unknown> = {}) {
  const kv = new Map<string, string>();
  if (Object.keys(seed).length) kv.set(BRIEF_DISPATCH_KEY, JSON.stringify(seed));
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const dispatch = new BriefDispatchDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
      },
    } as never,
    env,
  );
  env.BRIEF_DISPATCH = {
    getByName: (name: string) => (name === BRIEF_DISPATCH_DO_NAME ? dispatch : null),
  } as never;
  return { env, dispatch, kv };
}

describe('BriefDispatchDO — atomic external workflow gate', () => {
  it('паралельні ручний і cron claim-и допускають рівно один workflow', async () => {
    const { env } = setup();
    const [manual, automatic] = await Promise.all([
      briefDispatchClaim(env, {}, 1_000, null, 60 * 60_000),
      briefDispatchClaim(env, {}, 1_000, '2026-09-18', 15 * 60_000),
    ]);

    const winner = [manual, automatic].filter((claim) => claim.ok);
    expect(winner).toHaveLength(1);
    expect([manual.reason, automatic.reason]).toContain('pending');
  });

  it('тільки підтверджений dispatch оновлює canonical state і KV mirror', async () => {
    const { env, kv } = setup({ lastMs: 500, lastAutoDate: '2026-09-17' });
    const claim = await briefDispatchClaim(
      env,
      { lastMs: 500, lastAutoDate: '2026-09-17' },
      1_000,
      '2026-09-18',
      0,
    );
    expect(claim.ok).toBe(true);

    await expect(
      briefDispatchComplete(env, claim.token ?? null, 1_001, '2026-09-18'),
    ).resolves.toBe(true);
    await expect(briefDispatchRead(env, {})).resolves.toMatchObject({
      canonical: true,
      state: { lastMs: 1_001, lastAutoDate: '2026-09-18' },
    });
    expect(JSON.parse(kv.get(BRIEF_DISPATCH_KEY) ?? '{}')).toEqual({
      lastMs: 1_001,
      lastAutoDate: '2026-09-18',
    });
  });

  it('збій dispatch звільняє lease, тому коректний retry не чекає десять хвилин', async () => {
    const { env } = setup();
    const first = await briefDispatchClaim(env, {}, 1_000, null, 0);
    expect(first.ok).toBe(true);
    await expect(briefDispatchRelease(env, first.token ?? null)).resolves.toBe(true);

    await expect(briefDispatchClaim(env, {}, 1_001, null, 0)).resolves.toMatchObject({ ok: true });
  });
});
