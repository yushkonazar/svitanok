/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as runtimeEnv } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { searchBookingStays } from '../../web/core/trips/booking.mjs';

const env = runtimeEnv as Env & {
  TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
};
const testEnv = {
  ...env,
  BOOKING_API_TOKEN: 'fixture-partner-key',
  BOOKING_AFFILIATE_ID: '123',
  BOOKING_BOOKER_COUNTRY: 'ua',
  BOOKING_API_ENV: 'production' as const,
};
const answers = {
  to: 'Прага',
  lodging_from: '2026-11-13',
  lodging_to: '2026-11-15',
  lodging_count: 4,
  lodging_rooms: 1,
};
const now = Date.parse('2026-10-23T09:00:00Z');

beforeEach(async () => {
  await applyD1Migrations(env.DB!, env.TEST_MIGRATIONS);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

describe('Booking requests in workerd', () => {
  it('constructs native read-only requests and returns a dated total for four guests', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith('/search')) {
          expect(await request.clone().json()).toMatchObject({
            checkin: '2026-11-13',
            checkout: '2026-11-15',
            guests: { number_of_adults: 4, number_of_rooms: 1 },
          });
          return Response.json({
            data: [
              {
                id: 123,
                url: 'https://www.booking.com/hotel/cz/fixture.html',
                currency: { booker: 'EUR' },
                price: { total: { booker_currency: 280 } },
              },
            ],
          });
        }
        return Response.json({ data: [{ id: 123, name: { fallback: 'Fixture hotel' } }] });
      }),
    );
    const result = await searchBookingStays(testEnv, answers, now);
    expect(result?.options[0]).toMatchObject({
      availability: 'provider_quote',
      price: { amount: 280, currency: 'EUR', unit: 'stay', total_confirmed: true },
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.method === 'POST' && r.redirect === 'manual')).toBe(true);
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer fixture-partner-key');
    expect(new URL(requests[0]!.url).hostname).toBe('demandapi.booking.com');
  });

  it('rejects a redirect without forwarding partner credentials or making another request', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(null, {
          status: 302,
          headers: { location: 'https://foreign.invalid/' },
        });
      }),
    );
    await expect(searchBookingStays(testEnv, answers, now)).rejects.toThrow('booking-http-302');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.redirect).toBe('manual');
  });
});
