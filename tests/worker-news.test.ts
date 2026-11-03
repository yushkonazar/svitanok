import { describe, expect, it, vi } from 'vitest';
import worker from '../web/worker.js';
import { handleNewsImage } from '../web/api-news.mjs';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import { memoryKv } from './helpers/kv.js';
describe('news API ownership and publisher photo proxy', () => {
  it('returns private reader state but omits editorial source buffers and public history', async () => {
    const e = workerEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_OWNER_USER_ID: '42',
      NEWS_REFRESH: {
        getByName: () => ({
          getSnapshot: async () => ({
            generatedAt: '2026-11-03T10:00:00Z',
            history: [{ sourceText: 'old' }],
            groups: [
              {
                items: [
                  {
                    title: 'Подія',
                    url: 'https://example.test/a',
                    sourceExcerpt: 'raw',
                    excerpt: 'buffer',
                    historyStoryId: 'internal',
                  },
                ],
              },
            ],
          }),
          getFeedback: async () => ({}),
          getLastSeen: async () => null,
          getReader: async () => ({
            following: {},
            mutedUntil: {},
            readVersions: { event: ['v1'] },
          }),
        }),
      },
    });
    const response = await worker.fetch(
      new Request('https://example.test/api/news', {
        headers: { 'X-Telegram-Init-Data': await buildInitData(42, 'token') },
      }),
      e,
      { waitUntil() {} },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = (await response.json()) as {
      history?: unknown;
      groups: { items: unknown[] }[];
      reader: unknown;
    };
    expect(result.history).toBeUndefined();
    expect(result.groups[0]?.items[0]).toEqual({ title: 'Подія', url: 'https://example.test/a' });
    expect(result.reader).toMatchObject({ readVersions: { event: ['v1'] } });
  });
  it('protects reader state and validates explicit story operations before the Durable Object', async () => {
    const storyAction = vi.fn(async () => ({
      ok: true,
      reader: { following: {}, readVersions: {}, mutedUntil: {} },
    }));
    const e = workerEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_OWNER_USER_ID: '42',
      TELEGRAM_COOWNER_USER_IDS: '43',
      NEWS_REFRESH: { getByName: () => ({ storyAction }) },
    });
    const send = async (user: number | null, body: unknown) =>
      worker.fetch(
        new Request('https://example.test/api/news', {
          method: 'POST',
          headers: {
            'X-Telegram-Init-Data': user ? await buildInitData(user, 'token') : '',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
        e,
        { waitUntil() {} },
      );
    for (const user of [null, 43])
      expect([401, 403]).toContain(
        (await send(user, { type: 'story', storyId: 'event', action: 'follow' })).status,
      );
    for (const body of [
      { storyId: '', action: 'follow' },
      { storyId: 'event', action: 'toggle' },
      { storyId: 'event', action: 'read' },
      { storyId: 'event', action: 'read', version: 3 },
    ])
      expect((await send(42, { type: 'story', ...body })).status).toBe(400);
    expect(storyAction).not.toHaveBeenCalled();
    expect((await send(42, { type: 'story', storyId: 'event', action: 'follow' })).status).toBe(
      200,
    );
    expect(storyAction).toHaveBeenCalledWith('event', 'follow', undefined);
  });
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
