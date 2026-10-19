import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  freshLeisurePlace,
  freshLeisurePhoto,
  validPhotoResource,
  LEISURE_GOOGLE_DETAILS_MASK,
  LEISURE_GOOGLE_EXTENDED_MASK,
} from '../web/core/leisure/google-details.mjs';
import { enrichLeisureItem, leisureItemImage } from '../web/core/leisure/enrichment.mjs';
import { reserveQuota, quotaPeriod } from '../web/core/quota/quota.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { ALL_MIGRATIONS } from './helpers/migrations.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import { normalizeLeisureItem } from '../web/core/leisure/model.mjs';
import {
  upsertLeisureItems,
  leisureItems,
  executeLeisureCommand,
} from '../web/core/leisure/store.mjs';
import { handleLeisure } from '../web/api-leisure.mjs';
import { leisureOpenDuring, buildLeisureSuggestions } from '../web/core/leisure/planning.mjs';
import { forecastForDates } from '../web/core/adapters/weather.mjs';

const now = Date.parse('2026-10-19T08:00:00Z');
function setup() {
  const d = d1FromSqlite(ALL_MIGRATIONS, { atomicBatch: true });
  const DB = {
    ...d.stub,
    prepare(sql: string) {
      const p = d.stub.prepare(sql);
      return { ...p, ...p.bind() };
    },
  };
  return {
    ...d,
    env: workerEnv({
      DB,
      MAPS_API_KEY: 'test-google-key',
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_OWNER_USER_ID: '42',
    }),
  };
}
const googlePlace = {
  id: 'place1',
  displayName: { text: 'Кав’ярня' },
  formattedAddress: 'Львів, вулиця 1',
  googleMapsUri: 'https://maps.google.com/?cid=1',
  rating: 4.6,
  userRatingCount: 123,
  priceRange: {
    startPrice: { currencyCode: 'UAH', units: '300' },
    endPrice: { currencyCode: 'UAH', units: '600' },
  },
  photos: [
    {
      name: 'places/place1/photos/photo1',
      authorAttributions: [
        { displayName: 'Автор фото', uri: 'https://maps.google.com/maps/contrib/1' },
      ],
    },
  ],
  regularOpeningHours: {
    weekdayDescriptions: ['Понеділок: 10–22'],
    periods: [{ open: { day: 1, hour: 10 }, close: { day: 1, hour: 22 } }],
  },
  businessStatus: 'OPERATIONAL',
  websiteUri: 'https://cafe.example/menu',
  outdoorSeating: true,
  liveMusic: false,
};
const json = (v: unknown) =>
  new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('on-demand Google content and cost guards', () => {
  it('uses fixed standard/extended SKU masks and preserves unknown versus false', async () => {
    const { env, db } = setup();
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json(googlePlace)));
    vi.stubGlobal('fetch', fetch);
    const standard = await freshLeisurePlace(env, 'place1', now);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('X-Goog-FieldMask')).toBe(
      LEISURE_GOOGLE_DETAILS_MASK,
    );
    expect(LEISURE_GOOGLE_DETAILS_MASK).not.toContain('reviews');
    expect(standard).toMatchObject({
      rating: 4.6,
      userRatingCount: 123,
      amenities: { outdoorSeating: true, liveMusic: false },
      photos: [{ authors: [{ name: 'Автор фото' }] }],
    });
    expect(standard.amenities.allowsDogs).toBeUndefined();
    await freshLeisurePlace(env, 'place1', now, true);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('X-Goog-FieldMask')).toBe(
      LEISURE_GOOGLE_EXTENDED_MASK,
    );
    expect(
      (await freshLeisurePlace(env, 'place1', Date.parse('2026-10-19T22:30:00Z')))
        .currentHoursThrough,
    ).toBe('2026-10-26');
    expect(db.prepare('SELECT count(*) AS n FROM places').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT feature,sku FROM usage_receipts ORDER BY sku').all()).toEqual(
      expect.arrayContaining([
        { feature: 'leisure', sku: 'places-details-enterprise' },
        { feature: 'leisure', sku: 'places-details-enterprise-atmosphere' },
      ]),
    );
    db.close();
  });
  it('reserves the last allowance atomically and does not call Google after exhaustion', async () => {
    const { env, db } = setup();
    db.prepare(
      'INSERT INTO quota_counters(key,period,value,limit_value,updated_at) VALUES(?,?,?,?,?)',
    ).run('places_details', quotaPeriod(now), 999, 1000, new Date(now).toISOString());
    const result = await Promise.allSettled([
      reserveQuota(env, 'places_details', now),
      reserveQuota(env, 'places_details', now),
    ]);
    expect(result.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(freshLeisurePlace(env, 'place1', now)).rejects.toThrow('100 %');
    expect(fetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT value FROM quota_counters').get()).toMatchObject({ value: 1000 });
    db.close();
  });
  it('counts failed attempts while keeping provider errors and keys out of the response', async () => {
    const { env, db } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret-error', { status: 403 })),
    );
    await expect(freshLeisurePlace(env, 'place1', now)).rejects.toThrow(
      'google-details-unavailable',
    );
    expect(db.prepare('SELECT value FROM quota_counters').get()).toMatchObject({ value: 1 });
    expect(db.prepare('SELECT ok FROM usage_receipts').get()).toMatchObject({ ok: 0 });
    db.close();
  });
  it('loads one photo without forwarding the key to the image host or following arbitrary redirects', async () => {
    const { env, db } = setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ photoUri: 'https://lh3.googleusercontent.com/photo' }))
      .mockResolvedValueOnce(new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } }));
    vi.stubGlobal('fetch', fetch);
    const image = await freshLeisurePhoto(env, 'place1', 'places/place1/photos/photo1', now);
    expect(image.type).toBe('image/jpeg');
    expect(image.bytes.byteLength).toBe(4);
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain('test-google-key');
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error' });
    expect(fetch.mock.calls[1]?.[1]?.headers).toBeUndefined();
    expect(validPhotoResource('places/other/photos/p', 'place1')).toBe(false);
    expect(validPhotoResource('places/place1/photos/../../admin', 'place1')).toBe(false);
    fetch.mockResolvedValueOnce(json({ photoUri: 'https://127.0.0.1/private' }));
    await expect(
      freshLeisurePhoto(env, 'place1', 'places/place1/photos/photo1', now),
    ).rejects.toThrow('invalid-photo-response');
    db.close();
  });
});

describe('authenticated card enrichment', () => {
  it('returns live facts without rewriting the catalog, personal decisions, plans or receipts', async () => {
    const { env, db } = setup();
    const item = await normalizeLeisureItem(
      {
        title: 'Заклад',
        category: 'food',
        source: 'Google Places',
        sourceUrl: 'https://maps.google.com/?cid=1',
        placeId: 'place1',
      },
      now,
    );
    await upsertLeisureItems(env, [item]);
    const before = db.prepare('SELECT data_json FROM leisure_items').get();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(json(googlePlace))),
    );
    const enrichment = await enrichLeisureItem(env, { itemId: item!.id }, now);
    expect(enrichment.place?.rating).toBe(4.6);
    const check = await executeLeisureCommand(
      env,
      { op: 'place-check', id: item!.id, payload: {}, commandId: crypto.randomUUID() },
      now,
    );
    expect(check.place?.photos).toHaveLength(1);
    expect(db.prepare('SELECT data_json FROM leisure_items').get()).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM leisure_commands').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM leisure_records').get()).toMatchObject({ n: 0 });
    db.close();
  });
  it('requires the owner session before reading photos and uses a private no-store binary response', async () => {
    const { env, db } = setup();
    const item = await normalizeLeisureItem(
      {
        title: 'Концерт',
        category: 'concert',
        source: 'Органний зал',
        sourceUrl: 'https://www.lvivconcert.house/event-details/show',
        media: [{ url: 'https://static.wixstatic.com/media/poster.jpg', kind: 'poster' }],
      },
      now,
    );
    await upsertLeisureItems(env, [item]);
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('webp', { headers: { 'content-type': 'image/webp' } }));
    vi.stubGlobal('fetch', fetch);
    const request = (init = '') =>
      new Request('https://app.test/api/leisure', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': init },
        body: JSON.stringify({
          op: 'image',
          payload: { itemId: item!.id, index: 0, url: 'https://127.0.0.1/ignored' },
        }),
      });
    expect((await handleLeisure(request(), env)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    const response = await handleLeisure(request(await buildInitData(42, 'test-token')), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://static.wixstatic.com/media/poster.jpg');
    db.close();
  });
  it('rejects unknown items, dangerous media redirects, SVG and oversized image bodies', async () => {
    const { env, db } = setup();
    await expect(enrichLeisureItem(env, { itemId: 'item-missing' }, now)).rejects.toMatchObject({
      status: 404,
    });
    const item = await normalizeLeisureItem(
      {
        title: 'Подія',
        category: 'show',
        source: 'Jam',
        sourceUrl: 'https://jamfactory.ua/events/x/',
        media: [{ url: 'https://jamfactory.ua/poster.jpg' }],
      },
      now,
    );
    await upsertLeisureItems(env, [item]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://localhost/private' } }),
      )
      .mockResolvedValueOnce(
        new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
      )
      .mockResolvedValueOnce(
        new Response('x', {
          headers: { 'content-type': 'image/jpeg', 'content-length': '4000000' },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(leisureItemImage(env, { itemId: item!.id, index: 0 }, now)).rejects.toThrow(
      'недоступне',
    );
    await expect(leisureItemImage(env, { itemId: item!.id, index: 0 }, now)).rejects.toThrow(
      'недоступне',
    );
    await expect(leisureItemImage(env, { itemId: item!.id, index: 0 }, now)).rejects.toThrow(
      'source-too-large',
    );
    await expect(leisureItemImage(env, { itemId: item!.id, index: 99 }, now)).rejects.toMatchObject(
      { status: 404 },
    );
    db.close();
  });
  it('merges an exactly matched film across cinemas while keeping the canonical item ID and decisions', async () => {
    const { env, db } = setup();
    const film = { originalTitle: 'Same Film', year: 2026 };
    const normalize = (source: string, url: string, slug: string) =>
      normalizeLeisureItem(
        {
          title: 'Фільм',
          category: 'cinema',
          source,
          sourceUrl: url,
          film: { ...film, ...(source === 'Планета кіно' ? { imdbId: 'tt1234567' } : {}) },
          sessions: [
            {
              id: slug + '-one',
              cinema: slug,
              cinemaSlug: slug,
              startAt:
                slug === 'multiplex-victoria' ? '2026-10-22T22:30:00Z' : '2026-10-22T16:00:00Z',
              endAt:
                slug === 'multiplex-victoria' ? '2026-10-23T00:30:00Z' : '2026-10-22T18:00:00Z',
            },
          ],
        },
        now,
      );
    const first = (await normalize(
      'Планета кіно',
      'https://planetakino.ua/movie/one/',
      'forum-lviv',
    ))!;
    await upsertLeisureItems(env, [first]);
    db.prepare(
      'INSERT INTO leisure_records(id,kind,item_id,data_json,updated_at) VALUES(?,?,?,?,?)',
    ).run(
      'reaction',
      'reaction',
      first.id,
      JSON.stringify({ verdict: 'interested', interestLevel: 'priority' }),
      new Date(now).toISOString(),
    );
    const second = (await normalize(
      'Multiplex',
      'https://multiplex.ua/movie/12',
      'multiplex-victoria',
    ))!;
    await upsertLeisureItems(env, [second]);
    const stored = await leisureItems(env);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: first.id,
      source: 'Планета кіно',
      sourceUrl: first.sourceUrl,
    });
    expect(stored[0].sessions).toHaveLength(2);
    expect(stored[0].film.imdbId).toBe('tt1234567');
    expect(stored[0].endDate).toBe('2026-10-23');
    expect(db.prepare('SELECT item_id FROM leisure_records').get()).toMatchObject({
      item_id: first.id,
    });
    const pending = await normalizeLeisureItem(
      {
        title: 'Фільм',
        category: 'cinema',
        source: 'Планета кіно',
        sourceUrl: first.sourceUrl,
        film,
        sessions: [],
        status: 'schedule-pending',
      },
      now + 1000,
    );
    await upsertLeisureItems(env, [pending]);
    const current = (await leisureItems(env))[0];
    expect(current).toMatchObject({
      id: first.id,
      status: 'available',
      startDate: '2026-10-23',
      endDate: '2026-10-23',
      film: { imdbId: 'tt1234567' },
    });
    expect(current.sessions.map((s: { cinemaSlug: string }) => s.cinemaSlug)).toEqual([
      'multiplex-victoria',
    ]);
    db.close();
  });
  it('does not merge conflicting IMDb IDs or resolve an ambiguous original title by choosing an arbitrary film', async () => {
    const { env, db } = setup();
    const make = (id: string, imdbId?: string) =>
      normalizeLeisureItem(
        {
          title: 'Однакова назва',
          category: 'cinema',
          source: 'Кінотеатр',
          sourceUrl: 'https://planetakino.ua/movie/' + id + '/',
          film: { originalTitle: 'Same Name', year: 2026, imdbId },
          sessions: [],
        },
        now,
      );
    const a = (await make('first', 'tt1111111'))!,
      b = (await make('second', 'tt2222222'))!;
    await upsertLeisureItems(env, [a, b]);
    expect(await leisureItems(env)).toHaveLength(2);
    await upsertLeisureItems(env, [(await make('third'))!]);
    expect(await leisureItems(env)).toHaveLength(3);
    db.close();
  });
});

describe('planning with reliable facts', () => {
  it('rechecks live Google hours on the server and ignores legacy stored details before saving a plan', async () => {
    const { env, db } = setup();
    const item = (await normalizeLeisureItem(
      {
        title: 'Кав’ярня',
        category: 'food',
        source: 'Google Places',
        sourceUrl: 'https://maps.google.com/',
        placeId: 'place1',
      },
      now,
    ))!;
    await upsertLeisureItems(env, [{ ...item, placeDetails: { periods: [{ open: { day: 0 } }] } }]);
    expect((await leisureItems(env))[0].placeDetails).toBeUndefined();
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json({ ...googlePlace, businessStatus: 'CLOSED_TEMPORARILY' })),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(
      executeLeisureCommand(
        env,
        {
          op: 'plan',
          commandId: crypto.randomUUID(),
          payload: {
            title: 'Вечір',
            calendar: false,
            calendarUnavailableConfirmed: true,
            sourceAvailabilityConfirmed: true,
            stops: [
              { itemId: item.id, startAt: '2026-10-22T15:00:00Z', endAt: '2026-10-22T17:00:00Z' },
            ],
          },
        },
        now,
      ),
    ).rejects.toThrow('зачинений');
    expect(
      db.prepare("SELECT count(*) AS n FROM leisure_records WHERE kind='plan'").get(),
    ).toMatchObject({ n: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    db.close();
  });
  it('allows a manually confirmed on-request activity only after marking the reservation', async () => {
    const { env, db } = setup();
    const item = (await normalizeLeisureItem(
      {
        title: 'Гончарство',
        category: 'meetup',
        source: 'Скансен',
        sourceUrl: 'https://lvivskansen.org/majster-klasy/goncharstvo/',
        schedule: { kind: 'on-request', precision: 'date' },
      },
      now,
    ))!;
    await upsertLeisureItems(env, [item]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const payload = {
      title: 'Наш майстер-клас',
      calendar: false,
      calendarUnavailableConfirmed: true,
      sourceAvailabilityConfirmed: true,
      stops: [
        {
          itemId: item.id,
          startAt: '2026-10-22T15:00:00Z',
          endAt: '2026-10-22T17:00:00Z',
          reservation: false,
        },
      ],
    };
    await expect(
      executeLeisureCommand(env, { op: 'plan', commandId: crypto.randomUUID(), payload }, now),
    ).rejects.toThrow('умови участі');
    payload.stops[0]!.reservation = true;
    const receipt = await executeLeisureCommand(
      env,
      { op: 'plan', commandId: crypto.randomUUID(), payload },
      now,
    );
    expect(receipt.id).toMatch(/^plan-/);
    expect(
      db.prepare("SELECT count(*) AS n FROM leisure_records WHERE kind='plan'").get(),
    ).toMatchObject({ n: 1 });
    db.close();
  });
  it('uses exceptional dated opening periods and the regular schedule only beyond the current horizon', () => {
    const place = {
      placeDetails: {
        currentHoursThrough: '2026-10-25',
        currentPeriods: [
          {
            open: { date: { year: 2026, month: 10, day: 22 }, hour: 12 },
            close: { date: { year: 2026, month: 10, day: 22 }, hour: 16 },
          },
        ],
        periods: [{ open: { day: 4, hour: 9 }, close: { day: 4, hour: 22 } }],
      },
    };
    expect(
      leisureOpenDuring(place, Date.parse('2026-10-22T14:00Z'), Date.parse('2026-10-22T15:00Z')),
    ).toBe(false);
    expect(
      leisureOpenDuring(place, Date.parse('2026-10-29T14:00Z'), Date.parse('2026-10-29T15:00Z')),
    ).toBe(true);
    expect(
      leisureOpenDuring(
        { placeDetails: { businessStatus: 'CLOSED_TEMPORARILY' } },
        now,
        now + 3600000,
      ),
    ).toBe(false);
  });
  it('shows a budget range and flags an uncertain upper cost rather than calling a minimum a full budget', () => {
    const item = {
      id: 'food',
      category: 'food',
      title: 'Кав’ярня',
      sourceUrl: 'https://example.com',
      status: 'available',
      price: { min: 300, max: 800, currency: 'UAH', basis: 'person' },
    };
    const workspace = { items: [item], saved: ['food'], records: [] };
    const result = buildLeisureSuggestions(
      workspace,
      {
        date: '2026-10-22',
        startTime: '16:00',
        endTime: '20:00',
        budgetMinor: 100000,
        transport: 'walk',
      },
      now,
    );
    expect(result.days[0].plans[0]).toMatchObject({
      costRange: { min: 60000, max: 160000 },
      confidence: 'needs-check',
    });
    expect(result.days[0].plans[0].warnings.join(' ')).toContain('Верхня межа');
  });
  it('uses hourly rain, wind and alerts for the outing while preserving the existing weather adapter contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          daily: [
            {
              dt: Date.parse('2026-10-20T12:00Z') / 1000,
              temp: { min: 10, max: 20 },
              pop: 0.8,
              wind_speed: 12,
              sunset: Date.parse('2026-10-20T15:00Z') / 1000,
              weather: [{ description: 'ясно' }],
            },
          ],
          hourly: [
            {
              dt: Date.parse('2026-10-20T14:00Z') / 1000,
              temp: 12,
              pop: 0.9,
              wind_speed: 13,
              weather: [{ description: 'дощ' }],
            },
          ],
          alerts: [
            {
              start: Date.parse('2026-10-20T12:00Z') / 1000,
              end: Date.parse('2026-10-20T18:00Z') / 1000,
              event: 'Сильний вітер',
            },
          ],
        }),
      ),
    );
    const f = await forecastForDates(
      workerEnv({ WEATHER_API_KEY: 'weather' }),
      { lat: 49.84, lon: 24.03 },
      ['2026-10-20'],
      null,
      { hourly: true },
    );
    expect(f.hourly?.[0]).toMatchObject({ temp: 12, pop: 0.9, wind: 13 });
    expect(f.alerts?.[0]?.event).toBe('Сильний вітер');
    const item = {
      id: 'park',
      title: 'Парк',
      category: 'trip',
      placeType: 'park',
      lat: 49.84,
      lon: 24.03,
      status: 'available',
      sourceUrl: 'https://example.com',
    };
    const result = buildLeisureSuggestions(
      { items: [item], saved: ['park'], records: [] },
      { date: '2026-10-20', startTime: '16:00', endTime: '20:00', transport: 'walk' },
      now,
      { forecasts: [{ at: { lat: 49.84, lon: 24.03 }, ...f }] },
    );
    expect(result.days[0].plans[0].warnings.join(' ')).toContain('Сильний вітер');
    expect(result.days[0].plans[0].weather.join(' ')).toContain('на час прогулянки');
  });
});
