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
let geocodeEmpty: boolean;
let geocodeDirectEmpty: boolean;

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
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

async function getWeather(initData: string | null, e = env(), cf?: Record<string, unknown>) {
  const req = new Request('https://svitanok.example/api/weather', {
    headers: initData ? { 'X-Telegram-Init-Data': initData } : {},
  });
  // Реальний Cloudflare Workers runtime сам додає request.cf на кожен живий
  // запит; тестове середовище — plain Node Request (без workerd), тож
  // симулюємо тим самим шляхом, що й Cloudflare — прямим присвоєнням.
  if (cf) Object.assign(req, { cf });
  return worker.fetch(req, e, { waitUntil: () => {} });
}

const LVIV_CF = { latitude: '49.84', longitude: '24.03', city: 'Lviv' };
const KYIV_CF = { latitude: '50.45', longitude: '30.52', city: 'Kyiv' };

async function setLocation(initData: string | null, city: string, e = env()) {
  const req = new Request('https://svitanok.example/api/weather/location', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ city, initData }),
  });
  return worker.fetch(req, e, { waitUntil: () => {} });
}

async function setLocationExact(
  initData: string | null,
  pick: { lat: number; lon: number; name: string },
  e = env(),
) {
  const req = new Request('https://svitanok.example/api/weather/location', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...pick, initData }),
  });
  return worker.fetch(req, e, { waitUntil: () => {} });
}

async function clearLocation(initData: string | null, e = env()) {
  const req = new Request('https://svitanok.example/api/weather/location', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  return worker.fetch(req, e, { waitUntil: () => {} });
}

beforeEach(() => {
  kv = new Map();
  openWeatherCalls = [];
  openWeatherFail = false;
  geocodeEmpty = false;
  geocodeDirectEmpty = false;
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    if (url.includes('api.openweathermap.org')) {
      openWeatherCalls.push(url);
      if (openWeatherFail) return new Response('down', { status: 500 });
      if (url.includes('/geo/1.0/direct')) {
        return new Response(
          JSON.stringify(
            geocodeDirectEmpty ? [] : [{ lat: 50.62, lon: 26.24, local_names: { uk: 'Рівне' } }],
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/geo/1.0/reverse')) {
        return new Response(JSON.stringify(geocodeEmpty ? [] : [{ name: 'Твоя точка' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
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

describe('GET /api/weather — геопозиція власника (request.cf)', () => {
  it('перший запит з cf -> зберігає ownerGeo, підміняє головну локацію', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await getWeather(initData, env(), LVIV_CF);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locations: { name: string }[] };
    // Твоя точка -> слот 1, Львів (WEATHER_LOCATIONS[0]) зсунувся у слот 2.
    expect(body.locations.map((l) => l.name)).toEqual(['Твоя точка', 'Львів']);
    expect(JSON.parse(kv.get('ownerGeo')!)).toEqual({ lat: 49.84, lon: 24.03 });
  });

  it('та сама позиція вдруге -> ownerGeo НЕ переписується, кеш обслуговує без нового фетчу', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await getWeather(initData, env(), LVIV_CF);
    const storedAfterFirst = kv.get('ownerGeo');
    const callsAfterFirst = openWeatherCalls.length;

    const res = await getWeather(initData, env(), LVIV_CF);
    expect(res.status).toBe(200);
    expect(kv.get('ownerGeo')).toBe(storedAfterFirst); // байтово той самий запис — жодного нового put
    expect(openWeatherCalls).toHaveLength(callsAfterFirst); // кеш обслужив, без нового фетчу/геокоду
  });

  it('позиція відрізняється -> переписує ownerGeo, інвалідує кеш і фетчить заново (навіть у межах TTL)', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await getWeather(initData, env(), LVIV_CF); // valid, свіжий кеш під Львів-позицію

    const callsAfterFirst = openWeatherCalls.length;
    const res = await getWeather(initData, env(), KYIV_CF);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locations: { name: string }[] };
    expect(body.locations.map((l) => l.name)).toEqual(['Твоя точка', 'Львів']);
    expect(openWeatherCalls.length).toBeGreaterThan(callsAfterFirst); // кеш під СТАРУ позицію не рахується валідним
    expect(JSON.parse(kv.get('ownerGeo')!)).toEqual({ lat: 50.45, lon: 30.52 });
  });

  it('незначний джиттер координат (у межах ~2км) -> трактується як «та сама позиція», без перезапису', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await getWeather(initData, env(), LVIV_CF);
    const storedAfterFirst = kv.get('ownerGeo');

    const jitterCf = { latitude: '49.85', longitude: '24.04', city: 'Lviv' }; // ~0.01° зсув
    const res = await getWeather(initData, env(), jitterCf);
    expect(res.status).toBe(200);
    expect(kv.get('ownerGeo')).toBe(storedAfterFirst);
  });

  it('немає cf (напр. локальний dev), АЛЕ вже є збережена позиція -> тримається останньої відомої', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await getWeather(initData, env(), LVIV_CF); // зберігає ownerGeo

    const res = await getWeather(initData); // без cf узагалі
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locations: { name: string }[] };
    expect(body.locations.map((l) => l.name)).toEqual(['Твоя точка', 'Львів']);
  });

  it('геокодування не дало назви -> фолбек «Твоя локація», геопозиція все одно застосована', async () => {
    geocodeEmpty = true;
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await getWeather(initData, env(), LVIV_CF);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locations: { name: string }[] };
    expect(body.locations[0]?.name).toBe('Твоя локація');
  });

  it('cf.latitude/longitude відсутні (null) -> НЕ трактується як (0,0), лишається дефолтна пара', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await getWeather(initData, env(), { latitude: null, longitude: null, city: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locations: { name: string }[] };
    expect(body.locations.map((l) => l.name)).toEqual(['Львів', 'Немовичі']);
    expect(kv.get('ownerGeo')).toBeUndefined();
  });

  it('cf.latitude/longitude — порожні рядки (не null) -> також НЕ (0,0), лишається дефолтна пара', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await getWeather(initData, env(), { latitude: '', longitude: '', city: '' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locations: { name: string }[] };
    expect(body.locations.map((l) => l.name)).toEqual(['Львів', 'Немовичі']);
    expect(kv.get('ownerGeo')).toBeUndefined();
  });
});

describe('POST/DELETE /api/weather/location — ручне перевизначення (фідбек власника)', () => {
  it('без initData -> 401', async () => {
    const res = await setLocation(null, 'Рівне');
    expect(res.status).toBe(401);
  });

  it('чужий user id -> 403', async () => {
    const initData = await buildInitData(9999, BOT_TOKEN);
    const res = await setLocation(initData, 'Рівне');
    expect(res.status).toBe(403);
  });

  it('порожнє місто -> 400 bad-params', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await setLocation(initData, '   ');
    expect(res.status).toBe(400);
  });

  it('немає WEATHER_API_KEY -> 503 not-configured', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await setLocation(initData, 'Рівне', env({ WEATHER_API_KEY: undefined }));
    expect(res.status).toBe(503);
  });

  it('місто не знайдено (геокодування — порожній результат) -> 404 not-found, KV не чіпає', async () => {
    geocodeDirectEmpty = true;
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await setLocation(initData, 'Невідоме Місто');
    expect(res.status).toBe(404);
    expect(kv.get('ownerGeoManual')).toBeUndefined();
  });

  it('успіх -> зберігає ownerGeoManual, віддає {ok:true, manualGeo:{name}}', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await setLocation(initData, 'Рівне');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; manualGeo: { name: string } };
    expect(body).toEqual({ ok: true, manualGeo: { name: 'Рівне' } });
    expect(JSON.parse(kv.get('ownerGeoManual')!)).toMatchObject({
      lat: 50.62,
      lon: 26.24,
      name: 'Рівне',
    });
  });

  it('мануальне перевизначення ПЕРЕВАЖАЄ request.cf цілком — навіть коли cf каже інше', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await setLocation(initData, 'Рівне');

    // Cloudflare продовжує репортити КИЇВ (владелец фізично там за IP) —
    // manual має перемогти й показати Рівне, не Київ.
    const res = await getWeather(initData, env(), KYIV_CF);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      locations: { name: string }[];
      manualGeo: { name: string } | null;
    };
    expect(body.locations.map((l) => l.name)).toEqual(['Рівне', 'Львів']);
    expect(body.manualGeo).toEqual({ name: 'Рівне' });
    // Авто-детекція все одно пишеться в ownerGeo (є на що впасти після clear).
    expect(JSON.parse(kv.get('ownerGeo')!)).toEqual({ lat: 50.45, lon: 30.52 });
  });

  it('manual override не викликає зворотне геокодування — назва напряму з geocodeCity', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await setLocation(initData, 'Рівне');
    const callsAfterSet = openWeatherCalls.filter((u) => u.includes('/geo/1.0/reverse')).length;

    await getWeather(initData, env(), KYIV_CF);
    const callsAfterGet = openWeatherCalls.filter((u) => u.includes('/geo/1.0/reverse')).length;
    expect(callsAfterGet).toBe(callsAfterSet); // жодного нового /reverse-виклику
  });

  it('без initData -> DELETE 401', async () => {
    const res = await clearLocation(null);
    expect(res.status).toBe(401);
  });

  it('DELETE прибирає override -> наступний GET повертається до авто-детекції (cf)', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    await setLocation(initData, 'Рівне');

    const delRes = await clearLocation(initData);
    expect(delRes.status).toBe(200);
    expect(kv.get('ownerGeoManual')).toBeUndefined();

    const res = await getWeather(initData, env(), KYIV_CF);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      locations: { name: string }[];
      manualGeo: { name: string } | null;
    };
    expect(body.locations.map((l) => l.name)).toEqual(['Твоя точка', 'Львів']);
    expect(body.manualGeo).toBeNull();
  });

  it('GET /api/weather без manual override -> manualGeo: null', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await getWeather(initData);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manualGeo: { name: string } | null };
    expect(body.manualGeo).toBeNull();
  });

  it('явний вибір {lat,lon,name} -> зберігає БЕЗ геокодування (жодного /geo/1.0/direct виклику)', async () => {
    const initData = await buildInitData(OWNER, BOT_TOKEN);
    const res = await setLocationExact(initData, {
      lat: 50.62,
      lon: 26.24,
      name: 'Рівне (обране)',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; manualGeo: { name: string } };
    expect(body).toEqual({ ok: true, manualGeo: { name: 'Рівне (обране)' } });
    expect(openWeatherCalls.filter((u) => u.includes('/geo/1.0/direct'))).toHaveLength(0);
    expect(JSON.parse(kv.get('ownerGeoManual')!)).toMatchObject({
      lat: 50.62,
      lon: 26.24,
      name: 'Рівне (обране)',
    });
  });
});
