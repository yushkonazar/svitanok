import { describe, expect, it } from 'vitest';
import { agentHostHealthTransition } from '../web/core/agent-host-health/client.mjs';
import {
  AGENT_HOST_HEALTH_DO_NAME,
  AGENT_HOST_HEALTH_KEY,
} from '../web/core/agent-host-health/contract.mjs';
import { AgentHostHealthDO } from '../web/core/agent-host-health/do.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

function setup(seed: Record<string, unknown> = {}) {
  const kv = new Map<string, string>();
  if (Object.keys(seed).length) kv.set(AGENT_HOST_HEALTH_KEY, JSON.stringify(seed));
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const health = new AgentHostHealthDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
      },
    } as never,
    env,
  );
  env.AGENT_HOST_HEALTH = {
    getByName: (name: string) => (name === AGENT_HOST_HEALTH_DO_NAME ? health : null),
  } as never;
  return { env, kv };
}

describe('AgentHostHealthDO — atomic owner-alert transition', () => {
  it('паралельні 404-проби створюють рівно один desync alert', async () => {
    const { env, kv } = setup({ state: 'ok', atMs: 1 });
    const [first, second] = await Promise.all([
      agentHostHealthTransition(env, { state: 'ok', atMs: 1 }, 'desync', 2),
      agentHostHealthTransition(env, { state: 'ok', atMs: 1 }, 'desync', 2),
    ]);

    expect([first.alert, second.alert].filter(Boolean)).toEqual(['warn']);
    expect(JSON.parse(kv.get(AGENT_HOST_HEALTH_KEY) ?? '{}')).toEqual({ state: 'desync', atMs: 2 });
  });

  it('unknown probe не перетворюється на вигадане відновлення', async () => {
    const { env } = setup({ state: 'desync', atMs: 1 });
    await expect(
      agentHostHealthTransition(env, { state: 'desync', atMs: 1 }, 'unknown', 2),
    ).resolves.toMatchObject({ canonical: true, previous: 'desync', next: 'desync', alert: null });
  });

  it('після desync саме один здоровий probe створює recovery alert', async () => {
    const { env, kv } = setup({ state: 'desync', atMs: 1 });
    await expect(
      agentHostHealthTransition(env, { state: 'desync', atMs: 1 }, 'ok', 2),
    ).resolves.toMatchObject({ canonical: true, previous: 'desync', next: 'ok', alert: 'clear' });
    expect(JSON.parse(kv.get(AGENT_HOST_HEALTH_KEY) ?? '{}')).toEqual({ state: 'ok', atMs: 2 });
  });

  it('недоступний canonical control plane приглушує невизначений alert', async () => {
    const { env } = setup();
    env.AGENT_HOST_HEALTH = {
      getByName: () => ({
        transition: async () => {
          throw new Error('DO unavailable');
        },
      }),
    } as never;

    await expect(agentHostHealthTransition(env, null, 'desync', 1)).resolves.toMatchObject({
      canonical: true,
      alert: null,
    });
  });
});
