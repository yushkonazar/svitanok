import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantHistoryDO } from '../web/core/assistant-history/do.mjs';
import { ASSISTANT_HISTORY_DO_NAME } from '../web/core/assistant-history/contract.mjs';
import {
  appendAssistantHistory,
  assistantHistorySnapshot,
  clearAssistantHistory,
  loadAssistantHistory,
} from '../web/kv-store.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

function setup(seed: Record<string, unknown> = {}) {
  const kv = new Map<string, string>();
  if (Object.keys(seed).length) kv.set('assistantHistory', JSON.stringify(seed));
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const history = new AssistantHistoryDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        delete: async (key: string) => void storage.delete(key),
        deleteAll: async () => void storage.clear(),
        setAlarm: async () => {},
      },
    } as never,
    env,
  );
  env.ASSISTANT_HISTORY = {
    getByName: (name: string) => (name === ASSISTANT_HISTORY_DO_NAME ? history : null),
  } as never;
  return { env, history, kv };
}

afterEach(() => vi.restoreAllMocks());

describe('AssistantHistoryDO — atomic short conversation context', () => {
  it('одноразово сіється з KV, а паралельні append batches не гублять репліки', async () => {
    const { env, kv } = setup({ '42:': [{ role: 'assistant', text: 'старе' }] });
    await Promise.all([
      appendAssistantHistory(env, 42, null, [
        { role: 'user', text: 'зроби план' },
        { role: 'assistant', text: 'ось план' },
      ]),
      appendAssistantHistory(env, 42, null, [{ role: 'assistant', text: 'уточни час' }]),
    ]);

    const turns = (await loadAssistantHistory(env))['42:'] as { role: string; text: string }[];
    expect(turns).toHaveLength(4);
    expect(turns.map((turn) => turn.text)).toEqual(
      expect.arrayContaining(['старе', 'зроби план', 'ось план', 'уточни час']),
    );
    expect(JSON.parse(kv.get('assistantHistory') ?? '{}')['42:']).toHaveLength(4);
  });

  it('TTL alarm ставить tombstone: застарілий legacy snapshot не воскресає', async () => {
    const { history } = setup({ '42:': [{ role: 'assistant', text: 'старе' }] });
    await history.read({ '42:': [{ role: 'assistant', text: 'старе' }] }, 1_000);
    vi.spyOn(Date, 'now').mockReturnValue(30 * 86_400_000 + 1_001);

    await history.alarm();
    await expect(
      history.read({ '42:': [{ role: 'assistant', text: 'застаріле' }] }, Date.now()),
    ).resolves.toMatchObject({ history: {} });
  });

  it('T2 чистить canonical history без відновлення з KV mirror', async () => {
    const { env, kv } = setup({ '42:': [{ role: 'assistant', text: 'секрет' }] });
    await loadAssistantHistory(env); // seed
    kv.delete('assistantHistory'); // FORGET_ALL_KV_KEYS already cleared mirror

    await expect(clearAssistantHistory(env)).resolves.toBe(true);
    expect(await assistantHistorySnapshot(env)).toEqual({});
    expect(await loadAssistantHistory(env)).toEqual({});
    expect(kv.has('assistantHistory')).toBe(false);
  });
});
