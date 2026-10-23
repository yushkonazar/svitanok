import { describe, expect, it, vi } from 'vitest';
import viewer from '../web/travel-map/worker.mjs';

describe('separate static map host', () => {
  it('serves only map assets with embedding restricted to Svitanok and Telegram', async () => {
    const fetchAsset = vi.fn(
      async () => new Response('<html>map</html>', { headers: { 'Content-Type': 'text/html' } }),
    );
    const response = await viewer.fetch(
      new Request('https://maps.svitanok.yushko.dev/travel-map.html'),
      { ASSETS: { fetch: fetchAsset } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "frame-ancestors 'self' https://svitanok.yushko.dev https://web.telegram.org",
    );
    expect(response.headers.get('Origin-Agent-Cluster')).toBe('?1');
    expect(await response.text()).toBe('<html>map</html>');
    expect(fetchAsset).toHaveBeenCalledTimes(1);
  });
  it.each(['/api/trips', '/api/agent', '/settlements.json', '/'])(
    'never exposes %s through the static host',
    async (path) => {
      const fetchAsset = vi.fn();
      const response = await viewer.fetch(new Request('https://maps.svitanok.yushko.dev' + path), {
        ASSETS: { fetch: fetchAsset },
      });
      expect(response.status).toBe(404);
      expect(fetchAsset).not.toHaveBeenCalled();
    },
  );
  it('rejects writes and preserves missing-asset status', async () => {
    const fetchAsset = vi.fn(async () => new Response('missing', { status: 404 }));
    const url = 'https://maps.svitanok.yushko.dev/travel-map-frame.js';
    expect(
      (await viewer.fetch(new Request(url, { method: 'POST' }), { ASSETS: { fetch: fetchAsset } }))
        .status,
    ).toBe(405);
    expect(fetchAsset).not.toHaveBeenCalled();
    expect((await viewer.fetch(new Request(url), { ASSETS: { fetch: fetchAsset } })).status).toBe(
      404,
    );
  });
});
