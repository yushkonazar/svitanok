import { describe, expect, it } from 'vitest';
import { SentMessagesDO } from '../web/core/sent-messages/do.mjs';
import { SENT_MESSAGES_DO_NAME } from '../web/core/sent-messages/contract.mjs';
import {
  clearSentMessages,
  forgetTrackedMessages,
  loadSentMessages,
  recordTrackedMessage,
  sentMessagesSnapshot,
} from '../web/kv-store.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

function setup(seed: Record<string, unknown> = {}) {
  const kv = new Map<string, string>();
  if (Object.keys(seed).length) kv.set('sentMessages', JSON.stringify(seed));
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const sent = new SentMessagesDO(
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
  env.SENT_MESSAGES = {
    getByName: (name: string) => (name === SENT_MESSAGES_DO_NAME ? sent : null),
  } as never;
  return { env, kv };
}

describe('SentMessagesDO — atomic /clear ring buffer', () => {
  it('одноразово сіється з legacy KV і паралельні writers не гублять id', async () => {
    const { env, kv } = setup({ '42:': [{ id: 1, own: true }] });
    await Promise.all([
      recordTrackedMessage(env, 42, null, 2),
      recordTrackedMessage(env, 42, null, 3),
    ]);

    expect((await loadSentMessages(env))['42:']).toEqual([
      { id: 1, own: true },
      { id: 2, own: false },
      { id: 3, own: false },
    ]);
    expect(JSON.parse(kv.get('sentMessages') ?? '{}')['42:']).toHaveLength(3);
  });

  it('cleanup точних id не затирає одночасно додане повідомлення', async () => {
    const { env } = setup({ '42:': [{ id: 1, own: true }] });
    await Promise.all([
      forgetTrackedMessages(env, 42, null, [1]),
      recordTrackedMessage(env, 42, null, 2),
    ]);

    expect((await loadSentMessages(env))['42:']).toEqual([{ id: 2, own: false }]);
  });

  it('T2 чистить canonical record і застарілий KV snapshot його не воскресає', async () => {
    const { env, kv } = setup({ '42:': [{ id: 1, own: true }] });
    await loadSentMessages(env); // seed DO
    kv.delete('sentMessages'); // FORGET_ALL_KV_KEYS already cleared mirror

    await expect(clearSentMessages(env)).resolves.toBe(true);
    expect(await sentMessagesSnapshot(env)).toEqual({});
    expect(await loadSentMessages(env)).toEqual({});
    expect(kv.has('sentMessages')).toBe(false);
  });
});
