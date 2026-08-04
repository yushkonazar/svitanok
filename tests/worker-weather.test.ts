import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';

/* Інтеграційні тести GET /api/weather (PR-7, «жива погода в Mini App» — фідбек
 * власника: статична температура з брифінгу вже за обідом не відповідала
 * дійсності). Owner-gated (initData), кешовано в KV (~30 хв), захисний денний
 * лічильник (спільний OpenWeather-ключ/квота з оркестратором). Той самий
 * стиль, що worker-agenda.test.ts: справжній worker.fetch, стаб fetch. */

const OWNER = 4242;
const BOT_TOKEN = 'bot-token-abc';

let kv: Map<string, string>;
let openWeatherCalls: string[];
let openWeatherFail: boolean;

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      list: async () => ({ keys: [] }),
    },
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    WEATHER_API_KEY: 'wkey',
    ...overrides,
  };
}

/** Той самий HMAC-алгоритм Telegram WebApp initData, що worker.js validateInitData. */
async function buildInitData(userId: number, botToken: string, authDateSec?: number) {
  const user = JSON.stringify({ id: userId, first_name: 'O' });
  const authDate = authDateSec ?? Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ user, auth_date: String(authDate) });
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(botToken)));
  const secretKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheck)));
  const hash = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  params.set('hash', hash);
  return params.toString();
}

async function getWeather(initData: string | null, e = env()) {
  return worker.fetch(
    new Request('https://svitanok.example/api/weather', {
      headers: initData ? { 'X-Telegram-Init-Data': initData } : {},
    }),
    e,
    { waitUntil: () => {} },
  );
}

beforeEach(() => {
  kv = new Map();
  openWeatherCalls = [];
  openWeatherFail = false;
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    if (url.includes('api.openweathermap.org')) {
      openWeatherCalls.push(url);
      if (openWeatherFail) return new Response('down', { status: 500 });
      if (url.includes('/onecall')) {
        return new Response(
          JSON.stringify({ current: { temp: 20, feels_like: 19, weather: [{ id: 800 }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/air_pollution')) {
        return new Response(JSON.stringify({ list: [{ main: { aqi: 2 } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/weather — owner-gate', () => {
  it('без initData -> 401', async () => {
    const res = await getWeather(null);
    expect(res.status).toBe(401);
  });

  it('чужий user id -> 403', async () => {
    const initData = await buildInitData(9999, BOT_TOKEN);
    const res = await getWeather(initData);
    expect(res.status).toBe(403);
  });

  /* ⚠️ Регресія: enc.encode(undefined) у validateInitData давав ПОРОЖНІЙ масив
     байтів, тож HMAC-секрет вироджувався у HMAC("WebAppData", "") — публічну
     константу, яку рахує будь-хто БЕЗ знання токена. Не заданий
     TELEGRAM_BOT_TOKEN (вікно ротації секрету, битий конфіг) тихо перетворював
     misconfig на fail-open: підроблений initData з довільним user id проходив. */
  it('TELEGRAM_BOT_TOKEN не задано -> 401, НАВІТЬ якщо hash порахований проти undefined', async () => {
    const forged = await buildInitData(OWNER, undefined as unknown as string);
    const res = await getWeather(forged, env({ TELEGRAM_BOT_TOKEN: undefined }));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/weather — фетч, кеш, ліміт', () => {
  it('немає WEATHER_API_KEY -> 503 not-configured (graceful, клієнт фолбекає на брифінг)', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await getWeather(initData, env({ WEATHER_API_KEY: undefined }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not-configured');
  });

  it('перший запит -> фетчить OpenWeather (2 локації × onecall+aqi), кешує в KV', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await getWeather(initData);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; locations: { name: string }[] };
    expect(body.ok).toBe(true);
    expect(body.locations.map((l) => l.name)).toEqual(['Львів', 'Немовичі']);
    expect(openWeatherCalls).toHaveLength(4); // 2 локації × (onecall + air_pollution)
    expect(kv.get('weatherLive')).toBeTruthy();
  });

  it('другий запит У МЕЖАХ TTL (30 хв) -> з КЕШУ, без нового фетчу', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await getWeather(initData);
    const callsAfterFirst = openWeatherCalls.length;
    const res = await getWeather(initData);
    expect(res.status).toBe(200);
    expect(openWeatherCalls).toHaveLength(callsAfterFirst); // жодного нового виклику
  });

  it('кеш протух (>30 хв) -> фетчить знову', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await getWeather(initData);
    // Штучно зістарити кеш.
    const cached = JSON.parse(kv.get('weatherLive')!);
    cached.fetchedAtMs = Date.now() - 31 * 60_000;
    kv.set('weatherLive', JSON.stringify(cached));
    const callsAfterFirst = openWeatherCalls.length;
    const res = await getWeather(initData);
    expect(res.status).toBe(200);
    expect(openWeatherCalls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('усі локації впали, є старий кеш -> віддає старий кеш замість помилки', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await getWeather(initData); // валідний кеш
    const cached = JSON.parse(kv.get('weatherLive')!);
    cached.fetchedAtMs = Date.now() - 31 * 60_000; // протух -> наступний запит спробує фетч
    kv.set('weatherLive', JSON.stringify(cached));

    openWeatherFail = true;
    const res = await getWeather(initData);
    expect(res.status).toBe(200); // не 502 — старий кеш урятував
    const body = (await res.json()) as { ok: boolean; locations: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.locations).toHaveLength(2);
  });

  it('усі локації впали, кешу НЕМАЄ -> 502 upstream-failed', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    openWeatherFail = true;
    const res = await getWeather(initData);
    expect(res.status).toBe(502);
  });

  it('денний ліміт вичерпано -> віддає наявний кеш (навіть протухлий), без нового фетчу', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await getWeather(initData); // будує кеш
    const cached = JSON.parse(kv.get('weatherLive')!);
    cached.fetchedAtMs = Date.now() - 31 * 60_000;
    kv.set('weatherLive', JSON.stringify(cached));
    // Штучно вичерпати лічильник на сьогодні.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
    kv.set('weatherLiveCounter', JSON.stringify({ date: today, count: 999 }));

    const callsBefore = openWeatherCalls.length;
    const res = await getWeather(initData);
    expect(res.status).toBe(200);
    expect(openWeatherCalls.length).toBe(callsBefore); // жодного нового фетчу — ліміт зупинив ДО нього
  });
});
