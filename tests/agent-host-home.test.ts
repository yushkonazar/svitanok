import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentHostHealthCheck } from '../web/agent-runtime.mjs';
import { workerEnv } from './helpers/env.js';

afterEach(() => vi.unstubAllGlobals());

describe('agent host health delivery', () => {
  it('sends a new desync alert to the private home without a group thread', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('api.telegram.org')) {
          sent.push(JSON.parse(String(init?.body)));
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('', { status: 404 });
      }),
    );
    const saved = new Map<string, string>();
    const env = workerEnv({
      ASSISTANT_HOME: 'dm',
      TELEGRAM_OWNER_USER_ID: '12345',
      TELEGRAM_CHAT_ID: '-100999',
      TOPIC_SYSTEM: '9',
      TELEGRAM_BOT_TOKEN: 'test-token',
      LLM_HOST_URL: 'https://brain.test',
      LLM_HOST_SECRET: 'test-secret',
      BRIEFING: {
        get: async (key: string) => saved.get(key) ?? null,
        put: async (key: string, value: string) => void saved.set(key, value),
      },
    });

    await agentHostHealthCheck(env);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chat_id).toBe(12345);
    expect(sent[0]).not.toHaveProperty('message_thread_id');
  });
});
