import { describe, expect, it, vi } from 'vitest';
import worker from '../web/worker.js';
import { handleNewsImage } from '../web/api-news.mjs';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import { memoryKv } from './helpers/kv.js';
describe('news API ownership and publisher photo proxy', () => {
  it('requires the primary owner before starting collection or recording preferences', async () => {
    const refresh = vi.fn(async () => ({ updated: true }));
    const e = workerEnv({
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_OWNER_USER_ID: '42',
      TELEGRAM_COOWNER_USER_IDS: '43',
      NEWS_REFRESH: { getByName: () => ({ refresh }) },
    });
    for (const user of [null, 43]) {
      const auth = user ? await buildInitData(user, 'test-token') : '';
      const response = await worker.fetch(
        new Request('https://example.test/api/news', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': auth, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'refresh' }),
        }),
        e,
        { waitUntil() {} },
      );
      expect([401, 403]).toContain(response.status);
    }
    expect(refresh).not.toHaveBeenCalled();
    const response = await worker.fetch(
      new Request('https://example.test/api/news', {
        method: 'POST',
        headers: {
          'X-Telegram-Init-Data': await buildInitData(42, 'test-token'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ type: 'refresh' }),
      }),
      e,
      { waitUntil() {} },
    );
    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('serves only registered publisher photos and rejects redirects to private hosts', async () => {
    const id = 'a'.repeat(64);
    const snapshot = {
      groups: [{ items: [{ imageId: id, image: 'https://ichef.bbci.co.uk/photo.jpg' }] }],
    };
    const e = workerEnv({
      BRIEFING: memoryKv(new Map([['miniAppNewsSnapshot', JSON.stringify(snapshot)]])),
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/jpeg' } }),
      );
    const photo = await handleNewsImage(
      new Request(`https://example.test/api/news/image/${id}`),
      e,
      fetcher,
    );
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(
      (
        await handleNewsImage(
          new Request(`https://example.test/api/news/image/${'b'.repeat(64)}`),
          e,
          fetcher,
        )
      ).status,
    ).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
    );
    expect(
      (await handleNewsImage(new Request(`https://example.test/api/news/image/${id}`), e, fetcher))
        .status,
    ).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects HTML/SVG and oversized image bodies', async () => {
    const id = 'a'.repeat(64);
    const e = workerEnv({
      BRIEFING: memoryKv(
        new Map([
          [
            'miniAppNewsSnapshot',
            JSON.stringify({
              groups: [{ items: [{ imageId: id, image: 'https://ichef.bbci.co.uk/photo.jpg' }] }],
            }),
          ],
        ]),
      ),
    });
    for (const response of [
      new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
      new Response('body', {
        headers: { 'content-type': 'image/jpeg', 'content-length': '3000000' },
      }),
    ]) {
      expect(
        (
          await handleNewsImage(
            new Request(`https://example.test/api/news/image/${id}`),
            e,
            async () => response,
          )
        ).status,
      ).toBe(404);
    }
  });
});
