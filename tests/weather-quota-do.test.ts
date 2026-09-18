import { describe, expect, it } from 'vitest';
import { weatherQuotaClear, weatherQuotaConsume } from '../web/core/weather-quota/client.mjs';
import {
  WEATHER_LIVE_COUNTER_KEY,
  WEATHER_QUOTA_DO_NAME,
} from '../web/core/weather-quota/contract.mjs';
import { WeatherQuotaDO } from '../web/core/weather-quota/do.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const TODAY = '2026-09-18';

function setup(seed: Record<string, unknown> = {}) {
  const kv = new Map<string, string>();
  if (Object.keys(seed).length) kv.set(WEATHER_LIVE_COUNTER_KEY, JSON.stringify(seed));
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const quota = new WeatherQuotaDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
      },
    } as never,
    env,
  );
  env.WEATHER_QUOTA = {
    getByName: (name: string) => (name === WEATHER_QUOTA_DO_NAME ? quota : null),
  } as never;
  return { env, kv };
}

describe('WeatherQuotaDO — atomic live-weather budget', () => {
  it('паралельні cache miss резервують спільну пачку OpenWeather рівно один раз', async () => {
    const { env, kv } = setup({ date: TODAY, count: 0 });
    const [first, second] = await Promise.all([
      weatherQuotaConsume(env, { date: TODAY, count: 0 }, TODAY, 4, 4),
      weatherQuotaConsume(env, { date: TODAY, count: 0 }, TODAY, 4, 4),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(kv.get(WEATHER_LIVE_COUNTER_KEY) ?? '{}')).toEqual({
      date: TODAY,
      count: 4,
    });
  });

  it('нова київська дата скидає вичерпаний budget, але не перевищує новий limit', async () => {
    const { env } = setup({ date: '2026-09-17', count: 149 });
    await expect(
      weatherQuotaConsume(env, { date: '2026-09-17', count: 149 }, TODAY, 4, 4),
    ).resolves.toMatchObject({ canonical: true, ok: true, count: 4, remaining: 0 });
    await expect(
      weatherQuotaConsume(env, { date: '2026-09-17', count: 149 }, TODAY, 1, 4),
    ).resolves.toMatchObject({ canonical: true, ok: false, count: 4, remaining: 0 });
  });

  it('T2 clear не дозволяє старому KV mirror воскресити ліміт', async () => {
    const { env, kv } = setup({ date: TODAY, count: 149 });
    // Навіть порожній canonical state стає tombstone: T2 може відбутися до
    // першого live-weather запиту, коли значення існувало лише в legacy KV.
    await expect(weatherQuotaClear(env)).resolves.toEqual({ canonical: true, cleared: false });
    kv.set(WEATHER_LIVE_COUNTER_KEY, JSON.stringify({ date: TODAY, count: 149 }));

    await expect(
      weatherQuotaConsume(env, { date: TODAY, count: 149 }, TODAY, 4, 4),
    ).resolves.toMatchObject({ canonical: true, ok: true, count: 4 });
  });
});
