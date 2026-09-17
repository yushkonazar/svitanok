import { describe, expect, it } from 'vitest';
import { AssistantResumeDO } from '../web/core/assistant-resume/do.mjs';
import {
  ASSISTANT_RESUME_DO_NAME,
  ASSISTANT_RESUME_TTL_MS,
  assistantResumeLegacyKey,
  assistantResumeSlot,
} from '../web/core/assistant-resume/contract.mjs';
import {
  assistantResumeClear,
  assistantResumeSave,
  assistantResumeTake,
} from '../web/core/assistant-resume/client.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

const CHAT = 42;
const slot = assistantResumeSlot(CHAT, null);
const legacyKey = assistantResumeLegacyKey(slot);

function setup(seed: Record<string, unknown> = {}) {
  const kv = new Map<string, string>();
  if (Object.keys(seed).length) kv.set(legacyKey, JSON.stringify(seed));
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const resume = new AssistantResumeDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
        setAlarm: async () => {},
      },
    } as never,
    env,
  );
  env.ASSISTANT_RESUME = {
    getByName: (name: string) => (name === ASSISTANT_RESUME_DO_NAME ? resume : null),
  } as never;
  return { env, resume, kv };
}

describe('AssistantResumeDO — atomic short-lived continuation', () => {
  it('два одночасних повідомлення списують legacy slot рівно один раз', async () => {
    const { env, kv } = setup({ note: 'створити подію на 15:00', atMs: 1_000 });
    const [first, second] = await Promise.all([
      assistantResumeTake(env, CHAT, null, { note: 'створити подію на 15:00', atMs: 1_000 }, 1_001),
      assistantResumeTake(env, CHAT, null, { note: 'створити подію на 15:00', atMs: 1_000 }, 1_001),
    ]);

    expect([first.resume, second.resume].filter(Boolean)).toEqual([
      expect.objectContaining({ note: 'створити подію на 15:00' }),
    ]);
    expect(kv.has(legacyKey)).toBe(false);
  });

  it('canonical save має TTL mirror, а протухлий note не повертається', async () => {
    const { env, kv } = setup();
    await expect(
      assistantResumeSave(env, CHAT, null, { note: 'старий контекст', atMs: 1_000 }, 1_000),
    ).resolves.toBe(true);
    expect(kv.has(legacyKey)).toBe(true);

    await expect(
      assistantResumeTake(env, CHAT, null, null, 1_000 + ASSISTANT_RESUME_TTL_MS + 1),
    ).resolves.toMatchObject({ canonical: true, resume: null });
    expect(kv.has(legacyKey)).toBe(false);
  });

  it('T2 clear блокує відновлення зі старого KV mirror', async () => {
    const { env, kv } = setup();
    const nowMs = Date.now();
    await assistantResumeSave(env, CHAT, null, { note: 'приватна нотатка', atMs: nowMs }, nowMs);
    await expect(assistantResumeClear(env)).resolves.toEqual({ canonical: true, cleared: true });
    expect(kv.has(legacyKey)).toBe(false);
    kv.set(legacyKey, JSON.stringify({ note: 'застарілий mirror', atMs: nowMs + 1 }));

    await expect(
      assistantResumeTake(
        env,
        CHAT,
        null,
        { note: 'застарілий mirror', atMs: nowMs + 1 },
        nowMs + 2,
      ),
    ).resolves.toMatchObject({ canonical: true, resume: null });
    expect(kv.has(legacyKey)).toBe(false);
  });
});
