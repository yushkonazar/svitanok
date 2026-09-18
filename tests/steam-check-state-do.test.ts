import { describe, expect, it } from 'vitest';
import {
  steamCheckClaim,
  steamCheckComplete,
  steamCheckRelease,
} from '../web/core/steam-check-state/client.mjs';
import {
  STEAM_CHECK_LEASE_MS,
  STEAM_CHECK_STATE_DO_NAME,
} from '../web/core/steam-check-state/contract.mjs';
import { SteamCheckStateDO } from '../web/core/steam-check-state/do.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

function setup() {
  const kv = new Map<string, string>();
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const state = new SteamCheckStateDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        delete: async (key: string) => void storage.delete(key),
      },
    } as never,
    env,
  );
  env.STEAM_CHECK_STATE = {
    getByName: (name: string) => (name === STEAM_CHECK_STATE_DO_NAME ? state : null),
  } as never;
  return { env, kv };
}

describe('SteamCheckStateDO — atomic daily check', () => {
  it('дає рівно одному паралельному тіку виконати перевірку та зберігає результат', async () => {
    const { env, kv } = setup();
    const legacy = { marker: '', misses: '2', saleShare: '0.2' };
    const claims = await Promise.all([
      steamCheckClaim(env, legacy, '2026-09-07', 1_000, STEAM_CHECK_LEASE_MS),
      steamCheckClaim(env, legacy, '2026-09-07', 1_000, STEAM_CHECK_LEASE_MS),
    ]);
    const winner = claims.find((claim) => claim.ok);
    expect(winner).toMatchObject({ ok: true, state: { misses: 2, saleShare: 0.2 } });
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);

    await expect(
      steamCheckComplete(env, winner?.token, {
        completedDay: '2026-09-07',
        misses: 0,
        saleShare: 0.7,
      }),
    ).resolves.toBe(true);
    expect(kv.get('steamCheckDay')).toBe('2026-09-07');
    expect(kv.get('steamCheckMisses')).toBe('0');
    expect(kv.get('steamSaleShare')).toBe('0.7');
    await expect(
      steamCheckClaim(env, legacy, '2026-09-07', 2_000, STEAM_CHECK_LEASE_MS),
    ).resolves.toMatchObject({ ok: false, reason: 'done' });
  });

  it('звільнений retry lease дозволяє наступний тік у тому самому вікні', async () => {
    const { env } = setup();
    const first = await steamCheckClaim(env, {}, '2026-09-07', 1_000, STEAM_CHECK_LEASE_MS);
    await expect(steamCheckRelease(env, first.token)).resolves.toBe(true);
    await expect(
      steamCheckClaim(env, {}, '2026-09-07', 1_001, STEAM_CHECK_LEASE_MS),
    ).resolves.toMatchObject({ ok: true });
  });
});
