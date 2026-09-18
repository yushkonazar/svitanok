import { describe, expect, it } from 'vitest';
import {
  monoReconcileClaim,
  monoReconcileComplete,
  monoReconcileRelease,
} from '../web/core/mono-reconcile/client.mjs';
import { MONO_RECONCILE_DO_NAME } from '../web/core/mono-reconcile/contract.mjs';
import { MonoReconcileDO } from '../web/core/mono-reconcile/do.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const STATE = { date: '2026-09-18', phase: 'statement', idx: 1, alerted: false };

function setup() {
  const kv = new Map<string, string>();
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const reconcile = new MonoReconcileDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        delete: async (key: string) => void storage.delete(key),
      },
    } as never,
    env,
  );
  env.MONO_RECONCILE = {
    getByName: (name: string) => (name === MONO_RECONCILE_DO_NAME ? reconcile : null),
  } as never;
  return { env, kv };
}

describe('MonoReconcileDO — one external phase at a time', () => {
  it('паралельні scheduler ticks отримують рівно один lease', async () => {
    const { env } = setup();
    const [first, second] = await Promise.all([
      monoReconcileClaim(env, STATE, 1_000, 10_000),
      monoReconcileClaim(env, STATE, 1_000, 10_000),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  });

  it('лише власник lease може записати progress і звільнити наступний tick', async () => {
    const { env, kv } = setup();
    const claim = await monoReconcileClaim(env, STATE, 1_000, 10_000);
    await expect(monoReconcileComplete(env, 'wrong', { ...STATE, idx: 2 })).resolves.toBe(false);
    await expect(monoReconcileComplete(env, claim.token, { ...STATE, idx: 2 })).resolves.toBe(true);
    expect(JSON.parse(kv.get('monoReconcile') ?? '{}')).toMatchObject({ idx: 2 });
    await expect(monoReconcileClaim(env, STATE, 1_001, 10_000)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('release після retryable помилки дозволяє наступному tick повторити ту саму фазу', async () => {
    const { env } = setup();
    const claim = await monoReconcileClaim(env, STATE, 1_000, 10_000);
    await expect(monoReconcileRelease(env, claim.token)).resolves.toBe(true);
    await expect(monoReconcileClaim(env, STATE, 1_001, 10_000)).resolves.toMatchObject({
      ok: true,
      state: STATE,
    });
  });
});
