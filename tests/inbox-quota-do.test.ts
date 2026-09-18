import { describe, expect, it } from 'vitest';
import { inboxQuotaClear, inboxQuotaTake } from '../web/core/inbox-quota/client.mjs';
import { INBOX_COUNT_KEY, INBOX_QUOTA_DO_NAME } from '../web/core/inbox-quota/contract.mjs';
import { InboxQuotaDO } from '../web/core/inbox-quota/do.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const TODAY = '2026-09-18';

function setup(seed: Record<string, unknown> = {}) {
  const kv = new Map<string, string>();
  if (Object.keys(seed).length) kv.set(INBOX_COUNT_KEY, JSON.stringify(seed));
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const quota = new InboxQuotaDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
      },
    } as never,
    env,
  );
  env.INBOX_QUOTA = {
    getByName: (name: string) => (name === INBOX_QUOTA_DO_NAME ? quota : null),
  } as never;
  return { env, kv };
}

describe('InboxQuotaDO — atomic Business-message cap', () => {
  it('паралельні Business-вебхуки резервують останній inbox slot рівно один раз', async () => {
    const { env, kv } = setup({ date: TODAY, n: 0, alerted: false });
    const [first, second] = await Promise.all([
      inboxQuotaTake(env, { date: TODAY, n: 0, alerted: false }, TODAY, 1),
      inboxQuotaTake(env, { date: TODAY, n: 0, alerted: false }, TODAY, 1),
    ]);

    expect([first.allowed, second.allowed].filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(kv.get(INBOX_COUNT_KEY) ?? '{}')).toEqual({
      date: TODAY,
      n: 1,
      // Другий паралельний webhook уже вперся в cap і разово позначив alert.
      alerted: true,
    });
  });

  it('паралельні відмови за cap дають рівно один сигнал для owner alert', async () => {
    const { env } = setup({ date: TODAY, n: 1, alerted: false });
    const [first, second] = await Promise.all([
      inboxQuotaTake(env, { date: TODAY, n: 1, alerted: false }, TODAY, 1),
      inboxQuotaTake(env, { date: TODAY, n: 1, alerted: false }, TODAY, 1),
    ]);

    expect([first.alert, second.alert].filter(Boolean)).toHaveLength(1);
    expect([first.allowed, second.allowed]).toEqual([false, false]);
  });

  it('нова київська дата починає свій cap з нуля', async () => {
    const { env } = setup({ date: '2026-09-17', n: 5_000, alerted: true });
    await expect(
      inboxQuotaTake(env, { date: '2026-09-17', n: 5_000, alerted: true }, TODAY, 1),
    ).resolves.toMatchObject({ canonical: true, allowed: true, n: 1 });
  });

  it('T2 tombstone не дозволяє старому KV mirror воскресити лічильник', async () => {
    const { env, kv } = setup();
    await inboxQuotaTake(env, { date: TODAY, n: 1, alerted: false }, TODAY, 2);
    await expect(inboxQuotaClear(env)).resolves.toEqual({ canonical: true, cleared: true });
    kv.set(INBOX_COUNT_KEY, JSON.stringify({ date: TODAY, n: 1, alerted: true }));

    await expect(
      inboxQuotaTake(env, { date: TODAY, n: 1, alerted: true }, TODAY, 1),
    ).resolves.toMatchObject({ canonical: true, allowed: true, n: 1 });
  });
});
