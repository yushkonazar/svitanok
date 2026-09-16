import { describe, expect, it } from 'vitest';
import { StateStoreDO } from '../web/core/state-store/do.mjs';
import { STATE_STORE_DO_NAME } from '../web/core/state-store/contract.mjs';
import { loadState, loadStats, mutableStateSnapshot, updateState } from '../web/kv-store.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

function setup(seed: Record<string, string> = {}) {
  const persisted = new Map<string, unknown>();
  const kv = new Map<string, string>(Object.entries(seed));
  const ctx = {
    storage: {
      get: async (key: string) => persisted.get(key),
      put: async (key: string, value: unknown) => void persisted.set(key, value),
      deleteAll: async () => void persisted.clear(),
      setAlarm: async () => {},
    },
  };
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const stateStore = new StateStoreDO(ctx as never, env);
  env.STATE_STORE = {
    getByName: (name: string) => (name === STATE_STORE_DO_NAME ? stateStore : null),
  } as never;
  return { env, kv, stateStore };
}

describe('StateStoreDO — canonical mutable state', () => {
  it('одноразово сіє state з legacy KV і далі не довіряє його застарілій копії', async () => {
    const { env, kv } = setup({ state: JSON.stringify({ legacy: 1 }) });
    expect(await loadState(env)).toEqual({ legacy: 1 });
    kv.set('state', JSON.stringify({ stale: true }));
    expect(await loadState(env)).toEqual({ legacy: 1 });
  });

  it('паралельні CAS-patch не гублять незалежні поля й дзеркало має останню версію', async () => {
    const { env, kv } = setup({ state: JSON.stringify({ base: true }) });
    await Promise.all([
      updateState(env, (state) => ({ ...state, fromWebhook: 1 })),
      updateState(env, (state) => ({ ...state, fromCron: 2 })),
    ]);
    expect(await loadState(env)).toEqual({ base: true, fromWebhook: 1, fromCron: 2 });
    expect(JSON.parse(kv.get('state') ?? '{}')).toEqual({
      base: true,
      fromWebhook: 1,
      fromCron: 2,
    });
  });

  it('backup snapshot бере canonical state/stats, а не змінений legacy KV', async () => {
    const { env, kv } = setup({
      state: JSON.stringify({ stateV: 1 }),
      stats: JSON.stringify({ statsV: 1 }),
    });
    await loadState(env);
    await loadStats(env);
    kv.set('state', JSON.stringify({ stale: true }));
    kv.set('stats', JSON.stringify({ stale: true }));
    await expect(mutableStateSnapshot(env)).resolves.toEqual({
      state: { stateV: 1 },
      stats: { statsV: 1 },
    });
  });

  it('невідомий ключ не створює тихий третій blob', async () => {
    const { stateStore } = setup();
    await expect(stateStore.read('other' as never, {})).rejects.toThrow(/невідомий ключ/);
  });
});
