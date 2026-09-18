import { describe, expect, it } from 'vitest';
import { monoAlertClaim } from '../web/core/mono-alert-gate/client.mjs';
import {
  MONO_ALERT_GATE_DO_NAME,
  MONO_UNKNOWN_ALERT_WINDOW_MS,
} from '../web/core/mono-alert-gate/contract.mjs';
import { MonoAlertGateDO } from '../web/core/mono-alert-gate/do.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

function setup() {
  const kv = new Map<string, string>();
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const gate = new MonoAlertGateDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
      },
    } as never,
    env,
  );
  env.MONO_ALERT_GATE = {
    getByName: (name: string) => (name === MONO_ALERT_GATE_DO_NAME ? gate : null),
  } as never;
  return { env, kv };
}

describe('MonoAlertGateDO — atomic unknown-account throttle', () => {
  it('паралельні webhook-и отримують рівно один daily alert claim', async () => {
    const { env, kv } = setup();
    const claims = await Promise.all([
      monoAlertClaim(env, 0, 1_000, MONO_UNKNOWN_ALERT_WINDOW_MS),
      monoAlertClaim(env, 0, 1_000, MONO_UNKNOWN_ALERT_WINDOW_MS),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    expect(kv.get('monoUnknownAlert')).toBe('1000');
  });
});
