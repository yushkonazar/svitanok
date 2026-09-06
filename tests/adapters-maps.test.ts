// Адаптер Google Maps (етап 5 PR-1, ADR-011, S-1-14): контракти запитів
// (endpoint, ключ у заголовку, field mask = SKU), квоти в quota_counters на
// кожен успішний виклик, кеш `places` (пошук не затирає деталей; деталі
// свіжі < 7 днів без API), деградація при 100 % (пошук - кеш або відмова;
// деталі - кеш будь-якої давнини; маршрут/геокодування - відмова), відсутній
// ключ - гучна помилка.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  placesSearch,
  placeDetails,
  routesEta,
  geocodeAddress,
  readPlace,
  QuotaExhaustedError,
  SEARCH_FIELD_MASK,
  DETAILS_FIELD_MASK,
  ROUTES_FIELD_MASK,
  PLACE_DETAILS_FRESH_MS,
} from '../web/core/adapters/maps.mjs';
import { QUOTA_LIMITS, quotaUsed } from '../web/core/quota/quota.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-07T10:00:00.000Z');
const MIGRATIONS = ['0002_assistant.sql', '0003_telemetry.sql', '0004_ideas_travel.sql'];

type Call = { url: string; init: RequestInit | undefined };

function setup(over: Record<string, unknown> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({ DB: d1.stub, MAPS_API_KEY: 'maps-key', ...over });
  return { d1, db: d1.db, env };
}

/** fetch-заглушка: черга відповідей по порядку; записує виклики. */
function stubFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error('несподіваний fetch');
      return typeof next === 'function' ? next() : next;
    }),
  );
  return calls;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const SEARCH_BODY = {
  places: [
    {
      id: 'ChIJabc',
      displayName: { text: 'Креденс Кафе', languageCode: 'uk' },
      formattedAddress: 'вул. Вірменська 6, Львів',
      location: { latitude: 49.8425, longitude: 24.0322 },
      googleMapsUri: 'https://maps.google.com/?cid=1',
    },
    { id: 'bad id!', displayName: { text: 'Сміття' } },
    { id: 'ChIJdef', displayName: { text: 'Креденс Дім' }, formattedAddress: 'пл. Ринок 10' },
  ],
};

/** Поставити лічильник на стелю (100 %). */
function exhaust(db: ReturnType<typeof setup>['db'], key: string) {
  db.prepare(
    `INSERT INTO quota_counters (key, period, value, limit_value, updated_at) VALUES (?, '2026-09', ?, ?, 'x')
     ON CONFLICT (key, period) DO UPDATE SET value = excluded.value`,
  ).run(key, QUOTA_LIMITS[key] ?? 0, QUOTA_LIMITS[key] ?? 0);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('placesSearch', () => {
  it('POST searchText з ключем у заголовку і маскою SKU Pro; кандидати в кеш; квота +1', async () => {
    const { env, db } = setup();
    const calls = stubFetch([ok(SEARCH_BODY)]);
    const out = await placesSearch(
      env,
      { query: 'Креденс', city: 'Львів', near: { lat: 49.84, lon: 24.03 } },
      NOW,
    );
    expect(out.source).toBe('api');
    expect(out.places.map((p) => p.place_id)).toEqual(['ChIJabc', 'ChIJdef']);
    const call = calls[0]!;
    expect(call.url).toBe('https://places.googleapis.com/v1/places:searchText');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('maps-key');
    // Літерал, не константа модуля: маска = SKU Pro; зайве поле (rating,
    // websiteUri…) тягне Enterprise, і тест мусить це побачити.
    expect(headers['X-Goog-FieldMask']).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri',
    );
    expect(SEARCH_FIELD_MASK).toBe(headers['X-Goog-FieldMask']);
    // Ключ НЕ в URL (логи/історія).
    expect(call.url).not.toContain('maps-key');
    const body = JSON.parse(String(call.init?.body));
    expect(body).toMatchObject({
      textQuery: 'Креденс, Львів',
      pageSize: 8,
      languageCode: 'uk',
      regionCode: 'UA',
      locationBias: { circle: { center: { latitude: 49.84, longitude: 24.03 } } },
    });
    const rows = db
      .prepare('SELECT place_id, name, address, lat, maps_uri FROM places ORDER BY place_id')
      .all();
    expect(rows).toEqual([
      {
        place_id: 'ChIJabc',
        name: 'Креденс Кафе',
        address: 'вул. Вірменська 6, Львів',
        lat: 49.8425,
        maps_uri: 'https://maps.google.com/?cid=1',
      },
      {
        place_id: 'ChIJdef',
        name: 'Креденс Дім',
        address: 'пл. Ринок 10',
        lat: null,
        maps_uri: null,
      },
    ]);
    expect(await quotaUsed(env, 'places_text', NOW)).toBe(1);
  });

  it('пошук не затирає телефон/години/улюблене з кешу; limit ≤ 8', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO places (place_id, name, phone, hours_json, is_favorite, visits) VALUES ('ChIJabc', 'Старе', '+380', '{"weekday":["пн 9-22"]}', 1, 3)`,
    ).run();
    stubFetch([ok(SEARCH_BODY)]);
    await placesSearch(env, { query: 'Креденс', limit: 99 }, NOW);
    const row = db
      .prepare('SELECT name, phone, hours_json, is_favorite, visits FROM places WHERE place_id = ?')
      .get('ChIJabc');
    expect(row).toEqual({
      name: 'Креденс Кафе',
      phone: '+380',
      hours_json: '{"weekday":["пн 9-22"]}',
      is_favorite: 1,
      visits: 3,
    });
    const body = JSON.parse(
      String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body),
    );
    expect(body.pageSize).toBe(8);
  });

  it('HTTP-помилка - виняток без ключа в тексті, квота не росте', async () => {
    const { env } = setup();
    stubFetch([
      new Response('{"error":{"message":"API key not valid key=maps-key"}}', { status: 403 }),
    ]);
    await expect(placesSearch(env, { query: 'x' }, NOW)).rejects.toThrow(/HTTP 403/);
    await expect(placesSearch(env, { query: 'x' }, NOW)).rejects.toThrow(/несподіваний fetch/);
    expect(await quotaUsed(env, 'places_text', NOW)).toBe(0);
  });

  it('квота 100 %: API не викликається, кеш за назвою (улюблені перші); порожній кеш - QuotaExhaustedError', async () => {
    const { env, db } = setup();
    exhaust(db, 'places_text');
    const calls = stubFetch([]);
    await expect(placesSearch(env, { query: 'Креденс' }, NOW)).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
    db.prepare(
      `INSERT INTO places (place_id, name, visits) VALUES ('a', 'Креденс Кафе', 5), ('b', 'Креденс Дім', 1)`,
    ).run();
    db.prepare(`UPDATE places SET is_favorite = 1 WHERE place_id = 'b'`).run();
    const out = await placesSearch(env, { query: 'Креденс' }, NOW);
    expect(out.source).toBe('cache');
    expect(out.places.map((p) => p.place_id)).toEqual(['b', 'a']);
    expect(calls).toHaveLength(0);
  });

  it('без MAPS_API_KEY - гучна відмова до fetch', async () => {
    const { env } = setup({ MAPS_API_KEY: undefined });
    const calls = stubFetch([]);
    await expect(placesSearch(env, { query: 'x' }, NOW)).rejects.toThrow(/MAPS_API_KEY/);
    expect(calls).toHaveLength(0);
  });
});

const DETAILS_BODY = {
  id: 'ChIJabc',
  displayName: { text: 'Креденс Кафе' },
  formattedAddress: 'вул. Вірменська 6, Львів',
  location: { latitude: 49.8425, longitude: 24.0322 },
  internationalPhoneNumber: '+380 32 235 5555',
  nationalPhoneNumber: '032 235 5555',
  websiteUri: 'https://kredens.ua',
  regularOpeningHours: { weekdayDescriptions: ['понеділок: 09:00–22:00', 'вівторок: 09:00–22:00'] },
  googleMapsUri: 'https://maps.google.com/?cid=1',
};

describe('placeDetails', () => {
  it('GET places/{id} з маскою Enterprise; телефон/сайт/години в кеш; квота places_details +1', async () => {
    const { env } = setup();
    const calls = stubFetch([ok(DETAILS_BODY)]);
    const out = await placeDetails(env, 'ChIJabc', NOW);
    expect(out.source).toBe('api');
    expect(out.place).toMatchObject({
      place_id: 'ChIJabc',
      name: 'Креденс Кафе',
      phone: '+380 32 235 5555',
      site: 'https://kredens.ua',
      hours: ['понеділок: 09:00–22:00', 'вівторок: 09:00–22:00'],
      is_favorite: false,
      visits: 0,
    });
    expect(calls[0]!.url).toBe(
      'https://places.googleapis.com/v1/places/ChIJabc?languageCode=uk&regionCode=UA',
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['X-Goog-FieldMask']).toBe(
      'id,displayName,formattedAddress,location,nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,googleMapsUri',
    );
    expect(DETAILS_FIELD_MASK).toBe(headers['X-Goog-FieldMask']);
    expect(await quotaUsed(env, 'places_details', NOW)).toBe(1);
    expect(await readPlace(env, 'ChIJabc')).toMatchObject({ phone: '+380 32 235 5555' });
  });

  it('свіжий кеш (< 7 днів) - без API; застарілий - знову API; свіжість рахує details, не пошук', async () => {
    const { env } = setup();
    stubFetch([
      ok(DETAILS_BODY),
      ok(SEARCH_BODY),
      ok({ ...DETAILS_BODY, websiteUri: 'https://new' }),
    ]);
    await placeDetails(env, 'ChIJabc', NOW);
    const cached = await placeDetails(env, 'ChIJabc', NOW + PLACE_DETAILS_FRESH_MS - 1);
    expect(cached.source).toBe('cache');
    // Пошук через 8 днів оновлює fetched_at, але деталі лишаються старими.
    await placesSearch(env, { query: 'Креденс' }, NOW + PLACE_DETAILS_FRESH_MS + 1);
    const again = await placeDetails(env, 'ChIJabc', NOW + PLACE_DETAILS_FRESH_MS + 2);
    expect(again.source).toBe('api');
    expect(again.place.site).toBe('https://new');
    expect(await quotaUsed(env, 'places_details', NOW)).toBe(2);
  });

  it('квота 100 %: кеш будь-якої давнини, без кешу - QuotaExhaustedError; телефону немає - null', async () => {
    const { env, db } = setup();
    stubFetch([
      ok({ ...DETAILS_BODY, internationalPhoneNumber: undefined, nationalPhoneNumber: undefined }),
    ]);
    const first = await placeDetails(env, 'ChIJabc', NOW);
    expect(first.place.phone).toBeNull();
    exhaust(db, 'places_details');
    // Той самий місяць (період квоти), але старше за 7 днів.
    const stale = await placeDetails(env, 'ChIJabc', NOW + 10 * 86_400_000);
    expect(stale.source).toBe('cache');
    await expect(placeDetails(env, 'ChIJother', NOW)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it('place_id поза [A-Za-z0-9_-] не йде в URL', async () => {
    const { env } = setup();
    const calls = stubFetch([]);
    await expect(placeDetails(env, '../x', NOW)).rejects.toThrow(/place_id/);
    expect(calls).toHaveLength(0);
  });
});

describe('routesEta', () => {
  it('computeRoutes: latLng/placeId/address, DRIVE з майбутнім виїздом = TRAFFIC_AWARE, квота routes +1', async () => {
    const { env } = setup();
    const calls = stubFetch([ok({ routes: [{ duration: '1920s', distanceMeters: 2340 }] })]);
    const out = await routesEta(
      env,
      {
        from: { lat: 49.84, lon: 24.03 },
        to: { place_id: 'ChIJabc' },
        mode: 'car',
        departAtMs: NOW + 3_600_000,
      },
      NOW,
    );
    expect(out).toEqual({ distance_m: 2340, duration_s: 1920, duration_min: 32, mode: 'car' });
    expect(calls[0]!.url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['X-Goog-FieldMask']).toBe('routes.duration,routes.distanceMeters');
    expect(ROUTES_FIELD_MASK).toBe(headers['X-Goog-FieldMask']);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      origin: { location: { latLng: { latitude: 49.84, longitude: 24.03 } } },
      destination: { placeId: 'ChIJabc' },
      travelMode: 'DRIVE',
      languageCode: 'uk',
      units: 'METRIC',
      departureTime: new Date(NOW + 3_600_000).toISOString(),
      routingPreference: 'TRAFFIC_AWARE',
    });
    expect(await quotaUsed(env, 'routes', NOW)).toBe(1);
  });

  it('TRANSIT із майбутнім виїздом: departureTime є, routingPreference немає (лише DRIVE)', async () => {
    const { env } = setup();
    const calls = stubFetch([ok({ routes: [{ duration: '600s', distanceMeters: 5000 }] })]);
    await routesEta(
      env,
      { from: { address: 'a' }, to: { address: 'b' }, mode: 'transit', departAtMs: NOW + 60_000 },
      NOW,
    );
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.travelMode).toBe('TRANSIT');
    expect(body.departureTime).toBe(new Date(NOW + 60_000).toISOString());
    expect(body.routingPreference).toBeUndefined();
  });

  it('WALK без departureTime/routingPreference навіть із часом; час у минулому - без departureTime', async () => {
    const { env } = setup();
    const calls = stubFetch([
      ok({ routes: [{ duration: '100s', distanceMeters: 100 }] }),
      ok({ routes: [{ duration: '100s', distanceMeters: 100 }] }),
    ]);
    await routesEta(
      env,
      { from: { address: 'дім' }, to: { address: 'Ринок' }, mode: 'walk', departAtMs: NOW + 1 },
      NOW,
    );
    await routesEta(
      env,
      { from: { address: 'дім' }, to: { address: 'Ринок' }, mode: 'car', departAtMs: NOW - 1 },
      NOW,
    );
    for (const c of calls) {
      const body = JSON.parse(String(c.init?.body));
      expect(body.departureTime).toBeUndefined();
      expect(body.routingPreference).toBeUndefined();
    }
    expect(JSON.parse(String(calls[0]!.init?.body)).origin).toEqual({ address: 'дім' });
  });

  it('невідомий mode / порожній маршрут / квота 100 % - винятки', async () => {
    const { env, db } = setup();
    stubFetch([ok({ routes: [] })]);
    await expect(
      routesEta(env, { from: { address: 'a' }, to: { address: 'b' }, mode: 'plane' as never }, NOW),
    ).rejects.toThrow(/mode/);
    await expect(
      routesEta(env, { from: { address: 'a' }, to: { address: 'b' }, mode: 'walk' }, NOW),
    ).rejects.toThrow(/не знайдено/);
    exhaust(db, 'routes');
    await expect(
      routesEta(env, { from: { address: 'a' }, to: { address: 'b' }, mode: 'walk' }, NOW),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });
});

describe('geocodeAddress', () => {
  it('GET geocode/json з address/language/region; OK → координати й locality; квота geocoding +1', async () => {
    const { env } = setup();
    const calls = stubFetch([
      ok({
        status: 'OK',
        results: [
          {
            formatted_address: 'Львів, Львівська область, Україна',
            geometry: { location: { lat: 49.84, lng: 24.03 } },
            address_components: [{ long_name: 'Львів', types: ['locality', 'political'] }],
          },
        ],
      }),
    ]);
    const out = await geocodeAddress(env, 'Львів', NOW);
    expect(out).toEqual({
      found: true,
      lat: 49.84,
      lon: 24.03,
      name: 'Львів, Львівська область, Україна',
      locality: 'Львів',
    });
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(url.searchParams.get('address')).toBe('Львів');
    expect(url.searchParams.get('language')).toBe('uk');
    expect(url.searchParams.get('region')).toBe('ua');
    expect(await quotaUsed(env, 'geocoding', NOW)).toBe(1);
  });

  it('ZERO_RESULTS → found:false (рахується); REQUEST_DENIED → виняток; квота 100 % → відмова', async () => {
    const { env, db } = setup();
    stubFetch([
      ok({ status: 'ZERO_RESULTS', results: [] }),
      ok({ status: 'REQUEST_DENIED', error_message: 'API not enabled' }),
    ]);
    expect(await geocodeAddress(env, 'Нуль', NOW)).toEqual({ found: false });
    await expect(geocodeAddress(env, 'x', NOW)).rejects.toThrow(/REQUEST_DENIED.*not enabled/);
    expect(await quotaUsed(env, 'geocoding', NOW)).toBe(1);
    exhaust(db, 'geocoding');
    await expect(geocodeAddress(env, 'x', NOW)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });
});
