import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bookingSearchUrl,
  airbnbSearchUrl,
  tripServiceLinks,
  serviceUrl,
} from '../web/core/trips/links.mjs';
import { searchBookingStays } from '../web/core/trips/booking.mjs';
import { normalizeTripSearchResult } from '../web/core/trips/providers.mjs';
import { tripMapData, matchTripMapPlace } from '../web/core/trips/maps.mjs';
import { handleTrips, readTravelWorkspace } from '../web/api-trips.mjs';
import { runTripBrief } from '../web/core/tools/trip.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';
import { buildInitData } from './helpers/init-data.js';

const NOW = Date.parse('2026-10-23T09:00:00Z');
const answers = {
  to: 'Прага',
  from_city: 'Львів',
  mode: 'bus',
  date_from: '2026-11-12',
  date_to: '2026-11-16',
  lodging_from: '2026-11-13',
  lodging_to: '2026-11-15',
  transport_count: 2,
  destination_count: 4,
  lodging_count: 4,
  lodging_rooms: 1,
  children_count: 0,
};
function setup(extra: Record<string, unknown> = {}) {
  const d = d1FromSqlite(
    readdirSync('web/core/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort(),
  );
  return {
    ...d,
    env: workerEnv({
      DB: d.stub,
      TELEGRAM_OWNER_USER_ID: '777',
      TELEGRAM_BOT_TOKEN: 'trip-fixture-token',
      ...extra,
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('travel service redirects', () => {
  it('uses four lodging guests and stay dates, independently of two bus passengers', () => {
    const booking = new URL(bookingSearchUrl(answers));
    expect(booking.searchParams.get('checkin')).toBe('2026-11-13');
    expect(booking.searchParams.get('checkout')).toBe('2026-11-15');
    expect(booking.searchParams.get('group_adults')).toBe('4');
    const airbnb = new URL(airbnbSearchUrl(answers));
    expect(airbnb.searchParams.get('adults')).toBe('4');
    expect(airbnb.searchParams.get('checkin')).toBe('2026-11-13');
    expect(
      new URL(bookingSearchUrl({ ...answers, lodging_from: undefined })).searchParams.has(
        'checkin',
      ),
    ).toBe(false);
  });
  it('keeps genuine property links and rejects imitation domains or embedded credentials', () => {
    expect(
      new URL(
        bookingSearchUrl(answers, {
          source_url: 'https://www.booking.com/hotel/cz/example.html',
          title: 'Example',
        }),
      ).pathname,
    ).toBe('/hotel/cz/example.html');
    expect(serviceUrl('https://booking.com.attacker.invalid/hotel/x', 'booking.com')).toBeNull();
    expect(serviceUrl('https://user:pass@booking.com/hotel/x', 'booking.com')).toBeNull();
    expect(
      new URL(
        bookingSearchUrl(answers, {
          source_url: 'https://official.invalid/room',
          title: 'Actual hotel',
        }),
      ).searchParams.get('ss'),
    ).toBe('Actual hotel, Прага');
    expect(
      new URL(airbnbSearchUrl({ ...answers, children_count: 1 })).searchParams.get('adults'),
    ).toBe('3');
    expect(tripServiceLinks(answers, 'transport').map((link) => [link.id, link.prefilled])).toEqual(
      [
        ['infobus', false],
        ['flixbus', false],
      ],
    );
    expect(tripServiceLinks({ ...answers, mode: 'train' }, 'transport')).toEqual([]);
  });
});

describe('Booking read-only adapter', () => {
  it('makes no calls without access or with incomplete required traveller context', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    expect(await searchBookingStays(workerEnv(), answers, NOW)).toBeNull();
    await expect(
      searchBookingStays(
        workerEnv({ BOOKING_API_TOKEN: 'fixture', BOOKING_AFFILIATE_ID: '123' }),
        answers,
        NOW,
      ),
    ).rejects.toThrow('context');
    await expect(
      searchBookingStays(
        workerEnv({
          BOOKING_API_TOKEN: 'fixture',
          BOOKING_AFFILIATE_ID: '123',
          BOOKING_BOOKER_COUNTRY: 'ua',
        }),
        { ...answers, children_count: 1 },
        NOW,
      ),
    ).rejects.toThrow('child-ages');
    expect(network).not.toHaveBeenCalled();
  });
  it('searches exact occupancy, retrieves content and preserves full stay price and real images', async () => {
    const { env, db } = setup({
      BOOKING_API_TOKEN: 'fixture-private-token',
      BOOKING_AFFILIATE_ID: '123',
      BOOKING_BOOKER_COUNTRY: 'ua',
      BOOKING_API_ENV: 'production',
    });
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          body: JSON.parse(String(init.body)),
          headers: new Headers(init.headers),
        });
        if (url.endsWith('/search'))
          return Response.json({
            data: [
              {
                id: 10004,
                url: 'https://www.booking.com/hotel/cz/example.html',
                currency: { booker: 'EUR' },
                price: { total: { booker_currency: 280 } },
                products: [{ policies: { cancellation: { type: 'non_refundable' } } }],
              },
            ],
          });
        return Response.json({
          data: [
            {
              id: 10004,
              name: { fallback: 'Fixture hotel' },
              location: {
                address: { 'en-gb': 'Praha 1' },
                coordinates: { latitude: 50.08, longitude: 14.42 },
              },
              photos: [
                { url: { standard: 'https://cf.bstatic.com/fixture.jpg' }, main_photo: true },
              ],
              rating: { review_score: 9.1, number_of_reviews: 251 },
            },
          ],
        });
      }),
    );
    const result = await searchBookingStays(env, answers, NOW);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://demandapi.booking.com/3.2/accommodations/search');
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer fixture-private-token');
    expect(calls[0]!.body).toMatchObject({
      checkin: '2026-11-13',
      checkout: '2026-11-15',
      guests: { number_of_adults: 4, number_of_rooms: 1 },
      booker: { country: 'ua', platform: 'mobile' },
      rows: 10,
      filters: { dormitories: 'exclude' },
    });
    expect(calls.every((call) => !/orders|bookings|payments/.test(call.url))).toBe(true);
    const normalized = normalizeTripSearchResult(result, 'stay', NOW, true).options[0];
    expect(normalized).toMatchObject({
      title: 'Fixture hotel',
      location: 'Praha 1',
      availability: 'provider_quote',
      price: { amount: 280, quantity: 1, unit: 'stay', total_confirmed: true },
      coordinates: { lat: 50.08, lon: 14.42 },
      rating: { value: 9.1, source: 'Booking.com' },
    });
    expect(normalized.photos[0].url).toBe('https://cf.bstatic.com/fixture.jpg');
    expect(JSON.stringify(result)).not.toContain('fixture-private-token');
    expect(db.prepare('SELECT count(*) AS n FROM usage_receipts').get()).toMatchObject({ n: 2 });
  });
  it('does not let model output claim a partner quote or provide unverified photos and coordinates', () => {
    const output = {
      options: [
        {
          kind: 'stay',
          title: 'Example',
          source_url: 'https://www.booking.com/hotel/cz/example.html',
          checked_at: new Date(NOW).toISOString(),
          availability: 'provider_quote',
          coordinates: { lat: 50, lon: 14 },
          photos: [{ url: 'https://cf.bstatic.com/fixture.jpg' }],
        },
      ],
    };
    const option = normalizeTripSearchResult(output, 'stay', NOW).options[0];
    expect(option).toMatchObject({ availability: 'unverified', coordinates: null, photos: [] });
  });
  it('uses canonical apartment filters, provider pagination and consistent cancellation terms', async () => {
    const { env } = setup({
      BOOKING_API_TOKEN: 'fixture',
      BOOKING_AFFILIATE_ID: '123',
      BOOKING_BOOKER_COUNTRY: 'ua',
      BOOKING_API_ENV: 'production',
    });
    let searchBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/constants'))
          return Response.json({
            data: { accommodation_types: [{ id: 201, name: { fallback: 'Apartment' } }] },
          });
        if (url.endsWith('/search')) {
          searchBody = JSON.parse(String(init.body));
          return Response.json({
            data: [
              {
                id: 10004,
                url: 'https://www.booking.com/hotel/cz/example.html',
                currency: { booker: 'EUR' },
                price: { total: { booker_currency: 280 } },
                products: [
                  { policies: { cancellation: { type: 'non_refundable' } } },
                  {
                    policies: {
                      cancellation: {
                        type: 'free_cancellation',
                        free_cancellation_until: '2026-11-10',
                      },
                    },
                  },
                ],
              },
            ],
            metadata: { next_page: 'next-fixture-page' },
          });
        }
        return Response.json({ data: [{ id: 10004, name: { 'en-gb': 'Fixture apartment' } }] });
      }),
    );
    const result = await searchBookingStays(
      env,
      { ...answers, lodging_layout: 'apartment', lodging_preference: 'У центрі' },
      NOW,
      'current-fixture-page',
    );
    expect(searchBody).toMatchObject({
      rows: 10,
      filters: { accommodation_types: [201], dormitories: 'exclude' },
      sort: { by: 'distance', direction: 'ascending' },
      page: 'current-fixture-page',
    });
    expect(result).toMatchObject({ next_page: 'next-fixture-page' });
    expect(result!.options[0]!.cancellation).toContain('Умови відрізняються');
  });
  it('bounds results at twelve, rejecting oversized responses rather than silently dropping data', () => {
    const option = {
      kind: 'stay',
      title: 'Example',
      source_url: 'https://example.com/',
      checked_at: new Date(NOW).toISOString(),
    };
    expect(
      normalizeTripSearchResult(
        { options: Array.from({ length: 12 }, (_, i) => ({ ...option, id: `fixture-${i}` })) },
        'stay',
        NOW,
      ).options,
    ).toHaveLength(12);
    expect(() =>
      normalizeTripSearchResult({ options: Array(13).fill(option) }, 'stay', NOW),
    ).toThrow('invalid-search-result');
  });
});

describe('private Google map data', () => {
  it('labels endpoint-only maps honestly and opens directions with both cities even without credentials', async () => {
    const current = { answers };
    const data = await tripMapData(
      workerEnv({ MAPS_BROWSER_API_KEY: 'browser-key', MAPS_MAP_ID: 'map-id' }),
      current,
      'transport',
      NOW,
    );
    expect(data.markers).toHaveLength(2);
    expect(data.route).toBeNull();
    expect(data.caption).toContain('пункти відправлення й прибуття');
    const disabled = await tripMapData(workerEnv(), current, 'transport', NOW);
    expect(disabled.enabled).toBe(false);
    const link = new URL(disabled.external_url);
    expect(link.pathname).toBe('/maps/dir/');
    expect(link.searchParams.get('origin')).toBe(answers.from_city);
    expect(link.searchParams.get('destination')).toBe(answers.to);
    expect(link.searchParams.get('travelmode')).toBe('driving');
    expect(link.searchParams.get('api')).toBe('1');
  });
  it('includes the card requested by the owner even when it is beyond the first eight results', async () => {
    const options = Array.from({ length: 12 }, (_, i) => ({
      id: `booking-${i}`,
      title: `Hotel ${i}`,
      coordinates: { lat: 50.08 + i * 0.001, lon: 14.42 },
      source_url: 'https://www.booking.com/hotel/cz/example.html',
    }));
    const result = await tripMapData(
      workerEnv({ MAPS_BROWSER_API_KEY: 'browser-key', MAPS_MAP_ID: 'map-id' }),
      { answers, planning: { stages: [{ kind: 'stay', options }] } },
      'stay',
      NOW,
      'booking-10',
    );
    expect(result.markers).toHaveLength(8);
    expect(result.markers![0]).toMatchObject({ id: 'booking-10' });
  });
  it('requires owner authentication before reading any map configuration', async () => {
    const { env } = setup({
      MAPS_API_KEY: 'server-only',
      MAPS_BROWSER_API_KEY: 'browser-key',
      MAPS_MAP_ID: 'map-fixture',
    });
    const response = await handleTrips(
      new Request('https://fixture.invalid/api/trips?id=fixture-id&format=map&kind=stay'),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('browser-key');
  });
  it('provides service links in the authenticated workspace without leaking the server key', async () => {
    const { env } = setup({ MAPS_API_KEY: 'server-only' });
    const brief = (await runTripBrief(env, { answers }, NOW, { chatId: 777 })).result;
    const workspace = await readTravelWorkspace(env, brief.draft_id, NOW);
    expect(
      workspace.current!.planning!.stages.find((s: { kind: string }) => s.kind === 'stay')!
        .service_links,
    ).toHaveLength(2);
    expect(JSON.stringify(workspace)).not.toContain('server-only');
    const initData = await buildInitData(777, 'trip-fixture-token');
    const response = await handleTrips(
      new Request(`https://fixture.invalid/api/trips?id=${brief.draft_id}&format=map&kind=stay`, {
        headers: { 'X-Telegram-Init-Data': initData },
      }),
      env,
    );
    expect(await response.json()).toMatchObject({ ok: true, enabled: false });
  });
  it('does not substitute a distant or ambiguous Google result for a hotel pin', () => {
    const center = { lat: 50.08, lon: 14.42 };
    expect(
      matchTripMapPlace('Fixture Hotel', [{ name: 'Fixture Hotel', lat: 48, lon: 16 }], center),
    ).toBeNull();
    expect(
      matchTripMapPlace(
        'Fixture Hotel',
        [
          { name: 'Fixture Hotel East', lat: 50.08, lon: 14.42 },
          { name: 'Fixture Hotel West', lat: 50.09, lon: 14.42 },
        ],
        center,
      ),
    ).toBeNull();
    expect(
      matchTripMapPlace(
        'Fixture Hotel',
        [{ name: 'Fixture Hotel', lat: 50.08, lon: 14.42 }],
        center,
      ),
    ).toMatchObject(center);
  });
  it('renders sourced partner coordinates without further Google calls and never returns the server key', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const data = await tripMapData(
      workerEnv({
        MAPS_API_KEY: 'server-only',
        MAPS_BROWSER_API_KEY: 'browser-key',
        MAPS_MAP_ID: 'map-fixture',
      }),
      {
        answers,
        planning: {
          stages: [
            {
              kind: 'stay',
              options: [
                {
                  id: 'booking-10004',
                  title: 'Fixture Hotel',
                  coordinates: { lat: 50.08, lon: 14.42 },
                  source_url: 'https://www.booking.com/hotel/cz/example.html',
                },
              ],
            },
          ],
        },
      },
      'stay',
      NOW,
    );
    expect(data).toMatchObject({
      enabled: true,
      api_key: 'browser-key',
      markers: [{ id: 'booking-10004', lat: 50.08, lon: 14.42 }],
    });
    expect(JSON.stringify(data)).not.toContain('server-only');
    expect(network).not.toHaveBeenCalled();
  });
});
