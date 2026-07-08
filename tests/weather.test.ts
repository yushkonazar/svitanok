import { describe, it, expect, vi } from 'vitest';
import {
  parseOneCall,
  createWeatherModule,
  slugFor,
  weatherBusKey,
  adviceFor,
  dayLenSec,
  mergeAqi,
  COLD_THRESHOLD_C,
  DAILY_REQUEST_LIMIT,
} from '../src/modules/weather.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig, LocationConfig } from '../src/core/config.js';

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Схід/захід для дати 2026-07-01 (умовні, але sunset > sunrise). Довжина дня — фікс.
const SUNRISE = sec('2026-07-01T02:00:00Z'); // 05:00 Kyiv
const SUNSET = sec('2026-07-01T18:00:00Z'); // 21:00 Kyiv → 16 год = 57600 с

// One Call 3.0 фікстура: дощовий прохолодний день у Львові.
const oneCall = {
  current: {
    sunrise: SUNRISE,
    sunset: SUNSET,
    temp: 8,
    feels_like: 6,
    humidity: 70,
    uvi: 5.6,
    wind_speed: 5.2,
    wind_gust: 9.1,
    weather: [{ id: 500, description: 'дощ' }],
  },
  hourly: [
    { dt: sec('2026-07-01T06:00:00Z'), temp: 10, pop: 0.1, weather: [{ id: 800 }] }, // 09:00 Kyiv
    { dt: sec('2026-07-01T09:00:00Z'), temp: 8, pop: 0.8, weather: [{ id: 500 }] }, // 12:00 Kyiv
    { dt: sec('2026-07-01T12:00:00Z'), temp: 12, pop: 0.7, weather: [{ id: 500 }] }, // 15:00 Kyiv
    { dt: sec('2026-07-01T15:00:00Z'), temp: 11, pop: 0.2, weather: [{ id: 803 }] }, // 18:00 Kyiv
    { dt: sec('2026-07-02T09:00:00Z'), temp: 25, pop: 0, weather: [{ id: 800 }] }, // завтра — ігнор
  ],
  daily: [
    {
      sunrise: SUNRISE,
      sunset: SUNSET,
      summary: 'Очікується дощ протягом дня',
      temp: { min: 7, max: 16 },
      pop: 0.8,
      weather: [{ id: 500, description: 'дощ' }],
    },
  ],
  alerts: [{ event: 'Гроза' }],
};

describe('parseOneCall', () => {
  it('актуальна температура, стан, willRain/willBeCold за порогами', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01')!;
    expect(w).not.toBeNull();
    expect(w.tempC).toBe(8); // current.temp
    expect(w.condition).toBe('дощ');
    expect(w.emoji).toBe('🌧'); // id 500
    expect(w.willRain).toBe(true); // денний maxRain 0.8 >= 0.5
    expect(w.popPercent).toBe(80);
    expect(w.willBeCold).toBe(true); // 8 < 10
  });

  it('збагачені поля: відч., вітер+пориви, вологість, UV, мін/макс дня', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01')!;
    expect(w.feelsLikeC).toBe(6);
    expect(w.windMps).toBe(5); // round(5.2)
    expect(w.gustMps).toBe(9); // round(9.1)
    expect(w.humidity).toBe(70);
    expect(w.uv).toBe(6); // round(5.6)
    expect(w.minC).toBe(7); // daily[0].temp.min
    expect(w.maxC).toBe(16); // daily[0].temp.max
  });

  it('вікно дощу з погодинних (перша..остання дощова +1 год)', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01')!;
    expect(w.rainWindow).toBe('12:00–16:00'); // pop≥0.5 о 12:00 і 15:00 Kyiv
  });

  it('погодинна температура (спарклайн) — денні слоти доби', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01')!;
    expect(w.hourlyTemp).toEqual([10, 8, 12, 11]); // 09/12/15/18 Kyiv, без завтра
  });

  it('hourly {година, температура} за сьогодні (для графіка з віссю годин)', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01')!;
    expect(w.hourly).toEqual([
      { h: 9, t: 10 },
      { h: 12, t: 8 },
      { h: 15, t: 12 },
      { h: 18, t: 11 },
    ]);
  });

  it('advice, alerts, summary, схід/захід з добового запису', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01')!;
    expect(w.advice).toBe('Прохолодно — куртка'); // відч. 6
    expect(w.alerts).toEqual(['Гроза']);
    expect(w.summary).toBe('Очікується дощ протягом дня');
    expect(w.sunrise).toBe(SUNRISE);
    expect(w.sunset).toBe(SUNSET);
  });

  it('нічний/вечірній дощ із низьким pop удень — БЕЗ парасольки й вікна', () => {
    const hotStormy = {
      current: { temp: 34, feels_like: 34, weather: [{ id: 803, description: 'рвані хмари' }] },
      hourly: [
        { dt: sec('2026-07-01T09:00:00Z'), temp: 34, pop: 0.1, weather: [{ id: 803 }] }, // 12:00
        { dt: sec('2026-07-01T15:00:00Z'), temp: 32, pop: 0.2, weather: [{ id: 200 }] }, // 18:00
      ],
      daily: [{ temp: { min: 24, max: 36 } }],
    };
    const w = parseOneCall(hotStormy, 'Львів', '2026-07-01')!;
    expect(w.willRain).toBe(false); // maxRain 0.2 < 0.5
    expect(w.rainWindow).toBeUndefined();
    expect(w.advice).toBe('Спекотно — легкий одяг, більше води');
  });

  it('фолбек мін/макс і температури з погодинних, коли daily відсутній', () => {
    const noDaily = {
      current: { temp: 20, feels_like: 20, weather: [{ id: 800, description: 'ясно' }] },
      hourly: [
        { dt: sec('2026-07-01T09:00:00Z'), temp: 18, pop: 0 },
        { dt: sec('2026-07-01T12:00:00Z'), temp: 24, pop: 0 },
      ],
    };
    const w = parseOneCall(noDaily, 'Львів', '2026-07-01')!;
    expect(w.minC).toBe(18);
    expect(w.maxC).toBe(24);
    expect(w.hourlyTemp).toEqual([18, 24]);
    expect(w.uv).toBeUndefined(); // немає uvi
    expect(w.gustMps).toBeUndefined();
  });

  it('фільтрує по київській даті (наступний день не впливає)', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-02')!;
    // Немає погодинних за 2026-07-02 у денному вікні, крім 12:00 Kyiv (25°).
    expect(w.hourlyTemp).toBeUndefined(); // <2 денних точок за цю дату
    expect(w.willRain).toBe(false);
  });

  it('порожній/некоректний — null', () => {
    expect(parseOneCall({}, 'X', '2026-07-01')).toBeNull();
    expect(parseOneCall({ current: {} }, 'X', '2026-07-01')).toBeNull(); // без temp
  });
});

describe('чисті хелпери', () => {
  it('adviceFor — за відчутною температурою', () => {
    expect(adviceFor(-5)).toContain('Морозно');
    expect(adviceFor(5)).toBe('Прохолодно — куртка');
    expect(adviceFor(15)).toContain('светр');
    expect(adviceFor(22)).toContain('Комфортно');
    expect(adviceFor(30)).toContain('Спекотно');
    expect(adviceFor(NaN)).toBe('');
  });
  it('dayLenSec — тривалість дня в секундах', () => {
    expect(dayLenSec(SUNRISE, SUNSET)).toBe(SUNSET - SUNRISE);
    expect(dayLenSec(100, 50)).toBe(0); // некоректно → 0
  });
  it('mergeAqi — 1..5 з Air Pollution, інакше undefined', () => {
    expect(mergeAqi({ list: [{ main: { aqi: 3 } }] })).toBe(3);
    expect(mergeAqi({ list: [{ main: { aqi: 0 } }] })).toBeUndefined();
    expect(mergeAqi({ list: [] })).toBeUndefined();
    expect(mergeAqi({})).toBeUndefined();
  });
});

describe('slug — детермінований', () => {
  it('weatherBusKey(slugFor(loc, i)) стабільний', () => {
    const loc = { lat: 1, lon: 2, name: 'Львів' };
    expect(weatherBusKey(slugFor(loc, 0))).toBe('weather.today.loc0');
    expect(weatherBusKey(slugFor(loc, 1))).toBe('weather.today.loc1');
  });
  it('COLD_THRESHOLD_C = 10, DAILY_REQUEST_LIMIT = 1000', () => {
    expect(COLD_THRESHOLD_C).toBe(10);
    expect(DAILY_REQUEST_LIMIT).toBe(1000);
  });
});

// --- модуль: мульти-локація, лічильник запитів, AQI ---
const locations: LocationConfig[] = [
  { lat: 49.8, lon: 24.0, name: 'Львів' },
  { lat: 51.1, lon: 26.4, name: 'Немовичі' },
];

function makeCtx(seed: Record<string, unknown> = {}): Ctx<AppConfig> {
  const bus = createRunBus();
  const store = new Map<string, unknown>(Object.entries(seed));
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
    state: {
      get: <T>(k: string) => store.get(k) as T | undefined,
      set: <T>(k: string, v: T) => void store.set(k, v),
      flush: async () => {},
      prune: () => {},
    },
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  };
}

/** fetch-мок: розрізняє onecall / air_pollution за URL; per-lat перевизначення. */
function makeFetch(overrides: { failLat?: string; aqi?: number } = {}) {
  return vi.fn(async (url: string) => {
    if (overrides.failLat && url.includes(`lat=${overrides.failLat}`)) {
      return new Response('err', { status: 500 });
    }
    if (url.includes('/3.0/onecall')) {
      return new Response(JSON.stringify(oneCall), { status: 200 });
    }
    if (url.includes('air_pollution')) {
      return new Response(JSON.stringify({ list: [{ main: { aqi: overrides.aqi ?? 2 } }] }), {
        status: 200,
      });
    }
    return new Response('err', { status: 404 });
  });
}

describe('weather module — мульти-локація + AQI', () => {
  it('обидві локації ok: bus заповнено, AQI змерджено, лічильник = 2×2', async () => {
    const mod = createWeatherModule({
      fetchImpl: makeFetch({ aqi: 3 }) as unknown as typeof fetch,
      apiKey: 'K',
    });
    const ctx = makeCtx();
    const block = await mod.run(ctx);

    expect(block).not.toBeNull();
    const locs = (block!.data as { locations: { aqi?: number }[] }).locations;
    expect(locs).toHaveLength(2);
    expect(locs[0]!.aqi).toBe(3);
    // 2 локації × (onecall + air_pollution) = 4 запити.
    expect(ctx.state.get<{ count: number }>('weatherRequests')!.count).toBe(4);
  });

  it('одна локація впала — інша лишається; bus містить лише успішну', async () => {
    const mod = createWeatherModule({
      fetchImpl: makeFetch({ failLat: '51.1' }) as unknown as typeof fetch,
      apiKey: 'K',
    });
    const ctx = makeCtx();
    const block = await mod.run(ctx);

    expect(block!.summary).toContain('Львів');
    expect(block!.summary).not.toContain('Немовичі');
    expect(ctx.bus.get('weather.today.loc0')).toBeDefined();
    expect(ctx.bus.get('weather.today.loc1')).toBeUndefined();
  });

  it('AQI-ендпоінт впав — локація лишається без aqi', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/3.0/onecall'))
        return new Response(JSON.stringify(oneCall), { status: 200 });
      return new Response('err', { status: 500 }); // air_pollution впав
    });
    const mod = createWeatherModule({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'K',
    });
    const block = await mod.run(makeCtx());
    const locs = (block!.data as { locations: { aqi?: number }[] }).locations;
    expect(locs[0]!.aqi).toBeUndefined();
  });

  it('дельта довжини дня vs учора — зі стану', async () => {
    const prevLen = SUNSET - SUNRISE - 180; // учора день був на 3 хв коротший
    const mod = createWeatherModule({
      fetchImpl: makeFetch() as unknown as typeof fetch,
      apiKey: 'K',
    });
    const ctx = makeCtx({
      'weatherDayLen:loc0': { date: '2026-06-30', lenSec: prevLen },
    });
    const block = await mod.run(ctx);
    const locs = (block!.data as { locations: { dayLenDeltaMin?: number }[] }).locations;
    expect(locs[0]!.dayLenDeltaMin).toBe(3); // +180с = +3 хв
    // Стан оновлено на сьогодні.
    expect(ctx.state.get<{ date: string }>('weatherDayLen:loc0')!.date).toBe('2026-07-01');
  });

  it('денний ліміт запитів вичерпано — локації пропущено, деградує в null', async () => {
    const fetchImpl = makeFetch();
    const mod = createWeatherModule({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'K',
    });
    const ctx = makeCtx({
      weatherRequests: { date: '2026-07-01', count: DAILY_REQUEST_LIMIT },
    });
    const block = await mod.run(ctx);
    expect(block).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled(); // жодного запиту понад ліміт
  });

  it('лічильник скидається на нову добу', async () => {
    const mod = createWeatherModule({
      fetchImpl: makeFetch() as unknown as typeof fetch,
      apiKey: 'K',
    });
    const ctx = makeCtx({
      weatherRequests: { date: '2026-06-30', count: 999 }, // вчорашній — скидається
    });
    await mod.run(ctx);
    expect(ctx.state.get<{ date: string; count: number }>('weatherRequests')).toEqual({
      date: '2026-07-01',
      count: 4,
    });
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
