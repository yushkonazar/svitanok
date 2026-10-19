/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as runtimeEnv } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { freshLeisurePlace, freshLeisurePhoto } from '../../web/core/leisure/google-details.mjs';

const env = runtimeEnv as Env & {
  DB: D1Database;
  TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
};
const now = Date.parse('2026-10-19T14:00:00Z');
const testEnv = { ...env, MAPS_API_KEY: 'workers-test-maps-key' };

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

// Construct every outbound Request using workerd's native implementation.
// Only the external response is fake; no network or production bindings are used.
function googleFetch(redirectAt?: 'details' | 'photo-api' | 'photo-cdn') {
  const requests: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      const kind =
        url.hostname === 'lh3.googleusercontent.com'
          ? 'photo-cdn'
          : url.pathname.endsWith('/media')
            ? 'photo-api'
            : 'details';
      if (kind === redirectAt)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://unexpected.invalid/image' },
        });
      if (kind === 'photo-api')
        return Response.json({ photoUri: 'https://lh3.googleusercontent.com/photo' });
      if (kind === 'photo-cdn')
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { 'content-type': 'image/jpeg' },
        });
      return Response.json({
        id: 'place1',
        displayName: { text: 'Test cafe' },
        photos: [{ name: 'places/place1/photos/photo1', authorAttributions: [] }],
      });
    }),
  );
  return requests;
}

describe('Google leisure requests in workerd', () => {
  it('constructs details and photo requests in the production runtime and keeps the key off the CDN', async () => {
    const requests = googleFetch();
    const place = await freshLeisurePlace(testEnv, 'place1', now);
    const photo = await freshLeisurePhoto(testEnv, 'place1', place.photos[0]!.name, now);
    expect(photo.type).toBe('image/jpeg');
    expect(photo.bytes.byteLength).toBe(4);
    expect(requests.map((request) => request.redirect)).toEqual(['manual', 'manual', 'manual']);
    expect(requests[0]!.headers.get('X-Goog-Api-Key')).toBe('workers-test-maps-key');
    expect(requests[1]!.headers.get('X-Goog-Api-Key')).toBe('workers-test-maps-key');
    expect(requests[2]!.headers.has('X-Goog-Api-Key')).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM places').first()).toEqual({ n: 0 });
  });

  it.each(['details', 'photo-api', 'photo-cdn'] as const)(
    'rejects %s redirects without another outbound request',
    async (target) => {
      const requests = googleFetch(target);
      const action =
        target === 'details'
          ? freshLeisurePlace(testEnv, 'place1', now)
          : freshLeisurePhoto(testEnv, 'place1', 'places/place1/photos/photo1', now);
      await expect(action).rejects.toThrow(
        target === 'photo-cdn' ? 'invalid-photo-response' : 'google-details-unavailable',
      );
      expect(requests).toHaveLength(target === 'photo-cdn' ? 2 : 1);
      expect(requests.every((request) => request.redirect === 'manual')).toBe(true);
      expect(
        requests.every((request) => !request.url.startsWith('https://unexpected.invalid/')),
      ).toBe(true);
    },
  );
});
