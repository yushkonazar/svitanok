import { describe, it, expect, vi } from 'vitest';
import {
  parseForecast,
  createWeatherModule,
  slugFor,
  weatherBusKey,
  COLD_THRESHOLD_C,
} from '../src/modules/weather.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig, LocationConfig } from '../src/core/config.js';

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const forecast = {
  list: [
    {
      dt: sec('2026-07-01T06:00:00Z'), // 09:00 Kyiv
      main: { temp: 15 },
      weather: [{ id: 800, description: 'ясно' }],
      pop: 0,
    },
    {
      dt: sec('2026-07-01T09:00:00Z'), // 12:00 Kyiv (представницький)
      main: { temp: 8 },
      weather: [{ id: 500, description: 'дощ' }],
      pop: 0.8,
    },
    {
      dt: sec('2026-07-02T09:00:00Z'),
      main: { temp: 20 },
      weather: [{ id: 800, description: 'ясно' }],
      pop: 0,
    },
  ],
};

describe('parseForecast', () => {
  it('бере представницький запис (≈полудень), willRain/willBeCold за порогами', () => {
    const w = parseForecast(forecast, 'Львів', '2026-07-01');
    expect(w).not.toBeNull();
    expect(w!.tempC).toBe(8); // запис 12:00 Kyiv
    expect(w!.condition).toBe('дощ');
    expect(w!.willRain).toBe(true); // pop 0.8 >= 0.5
    expect(w!.popPercent).toBe(80);
    expect(w!.willBeCold).toBe(true); // 8 < 10
  });

  it('willRain false, коли сьогодні без опадів', () => {
    const sunny = {
      list: [
        {
          dt: sec('2026-07-01T09:00:00Z'),
          main: { temp: 22 },
          weather: [{ id: 800, description: 'ясно' }],
          pop: 0.1,
        },
      ],
    };
    const w = parseForecast(sunny, 'Львів', '2026-07-01')!;
    expect(w.willRain).toBe(false);
    expect(w.popPercent).toBe(10);
    expect(w.willBeCold).toBe(false);
  });

  it('спекотний день із грозовим слотом надвечір (низький pop) — БЕЗ парасольки', () => {
    // Реальний баг: рвані хмари вдень + гроза з pop 0.2 надвечір давали парасольку.
    const hotStormy = {
      list: [
        {
          dt: sec('2026-07-01T09:00:00Z'), // 12:00 Kyiv
          main: { temp: 36 },
          weather: [{ id: 803, description: 'рвані хмари' }],
          pop: 0.1,
        },
        {
          dt: sec('2026-07-01T15:00:00Z'), // 18:00 Kyiv
          main: { temp: 34 },
          weather: [{ id: 200, description: 'гроза' }],
          pop: 0.2,
        },
      ],
    };
    const w = parseForecast(hotStormy, 'Львів', '2026-07-01')!;
    expect(w.willRain).toBe(false); // maxRain 0.2 < 0.5
    expect(w.popPercent).toBe(20);
  });

  it('нічний дощ не змушує брати парасольку вдень', () => {
    const nightRain = {
      list: [
        {
          dt: sec('2026-07-01T00:00:00Z'), // 03:00 Kyiv (ніч — ігнор)
          main: { temp: 18 },
          weather: [{ id: 500, description: 'дощ' }],
          pop: 0.9,
        },
        {
          dt: sec('2026-07-01T09:00:00Z'), // 12:00 Kyiv (день)
          main: { temp: 25 },
          weather: [{ id: 800, description: 'ясно' }],
          pop: 0.1,
        },
      ],
    };
    const w = parseForecast(nightRain, 'Львів', '2026-07-01')!;
    expect(w.willRain).toBe(false); // денний maxRain 0.1
  });

  it('фолбек на код опадів, коли pop відсутній', () => {
    const noPop = {
      list: [
        {
          dt: sec('2026-07-01T09:00:00Z'),
          main: { temp: 14 },
          weather: [{ id: 500, description: 'дощ' }],
        },
      ],
    };
    expect(parseForecast(noPop, 'Львів', '2026-07-01')!.willRain).toBe(true);
  });

  it('фільтрує по київській даті (наступний день не впливає)', () => {
    const w = parseForecast(forecast, 'Львів', '2026-07-02')!;
    expect(w.tempC).toBe(20);
  });

  it('порожній/некоректний — null', () => {
    expect(parseForecast({}, 'X', '2026-07-01')).toBeNull();
    expect(parseForecast({ list: [] }, 'X', '2026-07-01')).toBeNull();
  });
});

describe('slug — детермінований', () => {
  it('weatherBusKey(slugFor(loc, i)) стабільний', () => {
    const loc = { lat: 1, lon: 2, name: 'Львів' };
    expect(weatherBusKey(slugFor(loc, 0))).toBe('weather.today.loc0');
    expect(weatherBusKey(slugFor(loc, 1))).toBe('weather.today.loc1');
  });
  it('COLD_THRESHOLD_C = 10', () => {
    expect(COLD_THRESHOLD_C).toBe(10);
  });
});

// --- мульти-локаційна деградація ---
const locations: LocationConfig[] = [
  { lat: 49.8, lon: 24.0, name: 'Львів' },
  { lat: 51.1, lon: 26.4, name: 'Немовичі' },
];

function makeCtx(): Ctx<AppConfig> {
  const bus = createRunBus();
  const noop = () => {};
  return {
    bus,
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date(),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: { locations } as AppConfig,
    state: {} as Ctx['state'],
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  };
}

describe('weather module — мульти-локація', () => {
  it('одна локація впала — інша лишається; bus містить лише успішну', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('lat=49.8')) {
        return new Response(JSON.stringify(forecast), { status: 200 });
      }
      return new Response('err', { status: 500 }); // Немовичі впала
    });
    const mod = createWeatherModule({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'K',
    });
    const ctx = makeCtx();
    const block = await mod.run(ctx);

    expect(block).not.toBeNull();
    expect(block!.summary).toContain('Львів');
    expect(block!.summary).not.toContain('Немовичі');
    expect(ctx.bus.get('weather.today.loc0')).toBeDefined();
    expect(ctx.bus.get('weather.today.loc1')).toBeUndefined();
  });

  it('усі локації впали — null', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }));
    const mod = createWeatherModule({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'K',
    });
    expect(await mod.run(makeCtx())).toBeNull();
  });

  it('без API-ключа — null (не валить, не логує ключ)', async () => {
    const mod = createWeatherModule({ fetchImpl: vi.fn() as unknown as typeof fetch, apiKey: '' });
    expect(await mod.run(makeCtx())).toBeNull();
  });
});
