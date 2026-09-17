import { describe, it, expect } from 'vitest';
import { PendingProposalsDO } from '../web/core/pending-proposals/do.mjs';
import {
  pendingClear,
  pendingClaim,
  pendingRead,
  pendingReplace,
  pendingUpdate,
} from '../web/core/pending-proposals/client.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';
import { claimAssistantPending } from '../web/kv-store.mjs';

function setup(legacy: Record<string, unknown> | null = null) {
  const kv = new Map<string, string>();
  if (legacy) kv.set('assistantPending', JSON.stringify(legacy));
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const pending = new PendingProposalsDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        deleteAll: async () => void storage.clear(),
        setAlarm: async () => {},
      },
    },
    env,
  );
  Object.assign(env, { PENDING_PROPOSALS: { getByName: () => pending } });
  return { env, kv, pending };
}

describe('PendingProposalsDO', () => {
  it('одноразово сіється з legacy KV, а паралельний claim віддає право лише одному callback', async () => {
    const { env, kv } = setup({ id: 'one', items: [] });
    expect((await pendingRead(env, { id: 'one', items: [] })).pending).toMatchObject({
      id: 'one',
    });
    // Після першого read новий/застарілий KV snapshot більше не воскресає.
    expect((await pendingRead(env, { id: 'stale', items: [] })).pending).toMatchObject({
      id: 'one',
    });

    await expect(
      Promise.all([pendingClaim(env, 'one'), pendingClaim(env, 'one')]),
    ).resolves.toEqual([true, false]);
    expect(kv.get('assistantPending')).toBe('null');
  });

  it('першою дією може бути claim: він сам сіє canonical slot із legacy KV', async () => {
    const { env, kv } = setup({ id: 'one', items: [] });
    await expect(
      Promise.all([claimAssistantPending(env, 'one'), claimAssistantPending(env, 'one')]),
    ).resolves.toEqual([true, false]);
    expect(kv.get('assistantPending')).toBe('null');
  });

  it('за помилки доступного DO не повертається до неатомарного KV claim', async () => {
    const { env, kv } = setup({ id: 'one', items: [] });
    Object.assign(env, {
      PENDING_PROPOSALS: {
        getByName: () => ({
          read: async () => {
            throw new Error('temporary DO outage');
          },
        }),
      },
    });

    await expect(claimAssistantPending(env, 'one')).rejects.toThrow('temporary DO outage');
    expect(kv.get('assistantPending')).toBe(JSON.stringify({ id: 'one', items: [] }));
  });

  it('CAS повторює чисту мутацію на свіжій версії, тож два циклічні тапи не губляться', async () => {
    const { env, kv } = setup();
    await expect(pendingReplace(env, { id: 'one', items: [], taps: 0 })).resolves.toBe(true);

    const increment = (current: Record<string, unknown>) => ({
      ...current,
      taps: Number(current.taps ?? 0) + 1,
    });
    const [first, second] = await Promise.all([
      pendingUpdate(env, 'one', increment),
      pendingUpdate(env, 'one', increment),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await pendingRead(env, null)).pending).toMatchObject({ id: 'one', taps: 2 });
    expect(JSON.parse(kv.get('assistantPending') ?? 'null')).toMatchObject({ id: 'one', taps: 2 });
  });

  it('T2 clear прибирає canonical copy, а не лише legacy KV-mirror', async () => {
    const { env } = setup({ id: 'one', items: [] });
    await pendingRead(env, { id: 'one', items: [] }); // seed
    await expect(pendingClear(env)).resolves.toEqual({ canonical: true, cleared: true });
    expect((await pendingRead(env, { id: 'would-resurrect', items: [] })).pending).toBeNull();
  });
});
