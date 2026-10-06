import { describe, expect, it, vi } from 'vitest';
import {
  parseNewsFeed,
  refreshNewsSnapshot,
  NEWS_SNAPSHOT_KEY,
} from '../web/core/brief/news-snapshot.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';

const now = Date.parse('2026-10-04T09:00:00Z');
const item = (link: string, date: string, title = 'Title') =>
  `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate></item>`;
describe('fresh RSS snapshot', () => {
  it('parses British summer dates used by Sky and respects the broader candidate limit', () => {
    const xml = Array.from({ length: 12 }, (_, i) =>
      item(
        `https://www.skysports.com/news/${i}`,
        'Sun, 04 Oct 2026 09:00:00 BST',
        `Football result ${i}`,
      ),
    ).join('');
    expect(parseNewsFeed(xml, now, { britishTime: true, limit: 15 })).toHaveLength(12);
    expect(parseNewsFeed(xml, now, { britishTime: true })[0]?.publishedAt).toBe(
      '2026-10-04T08:00:00.000Z',
    );
  });
  it('extracts enclosure and encoded description photos only from publisher CDNs', () => {
    const xml = item('https://www.skysports.com/news/a', '2026-10-04T08:00:00Z').replace(
      '</item>',
      '<enclosure type="image/jpeg" url="https://e0.365dm.com/photo.jpg"/></item>',
    );
    expect(parseNewsFeed(xml, now)[0]?.image).toBe('https://e0.365dm.com/photo.jpg');
    const html = xml.replace(
      '<enclosure type="image/jpeg" url="https://e0.365dm.com/photo.jpg"/>',
      '<description>&lt;img src=&quot;https://img-cdn.hltv.org/a.jpg&quot;&gt;Details</description>',
    );
    expect(parseNewsFeed(html, now)[0]?.image).toBe('https://img-cdn.hltv.org/a.jpg');
    expect(
      parseNewsFeed(
        xml.replace('https://e0.365dm.com/photo.jpg', 'https://127.0.0.1/a.jpg'),
        now,
      )[0]?.image,
    ).toBeUndefined();
  });
  it('enforces a ten-minute manual collection cooldown independently of the automatic interval', async () => {
    const kv = memoryKv(new Map());
    const env = workerEnv({ BRIEFING: kv });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(item('https://example.test/a', '2026-10-04T08:00:00Z')));
    await refreshNewsSnapshot(env, now, fetcher, true);
    expect(await refreshNewsSnapshot(env, now + 60000, fetcher, true)).toMatchObject({
      skipped: 'cooldown',
      retryAfterSeconds: 540,
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
    await refreshNewsSnapshot(env, now + 11 * 60000, fetcher, true);
    expect(fetcher).toHaveBeenCalledTimes(12);
  });
  it('curates default sources, deduplicates feeds and caps the balanced selection at eighteen', async () => {
    const kv = memoryKv(new Map());
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (url) =>
          new Response(
            Array.from({ length: 3 }, (_, i) =>
              item(
                i === 0
                  ? 'https://example.test/shared'
                  : `https://example.test/${encodeURIComponent(String(url))}/${i}`,
                '2026-10-04T08:00:00Z',
              ),
            ).join(''),
          ),
      );
    await refreshNewsSnapshot(workerEnv({ BRIEFING: kv }), now, fetcher);
    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls).toContain('https://www.pravda.com.ua/rss/');
    expect(urls).toContain('https://www.skysports.com/rss/11095');
    expect(urls.some((url) => url.includes('guardian'))).toBe(false);
    const saved = JSON.parse((await kv.get(NEWS_SNAPSHOT_KEY))!);
    const items = saved.groups.flatMap((g: { items: { url: string }[] }) => g.items);
    expect(items.length).toBeLessThanOrEqual(18);
    expect(new Set(items.map((i: { url: string }) => i.url)).size).toBe(items.length);
    expect(
      saved.groups.find((g: { sourceId: string }) => g.sourceId === 'hltv').items.length,
    ).toBeGreaterThan(0);
    expect(
      saved.groups.find((g: { sourceId: string }) => g.sourceId === 'sky-football').items.length,
    ).toBeGreaterThan(0);
  });
  it('matches cached items by source identity and does not date failed feeds as refreshed', async () => {
    const kv = memoryKv(
      new Map([
        ['settings', JSON.stringify({ news: { sources: ['HLTV'], intervalHours: 3 } })],
        [
          NEWS_SNAPSHOT_KEY,
          JSON.stringify({
            generatedAt: '2026-10-04T07:00:00Z',
            groups: [
              {
                sourceId: 'sky-football',
                items: [
                  {
                    url: 'https://example.test/wrong',
                    title: 'Football',
                    publishedAt: '2026-10-04T08:00:00Z',
                  },
                ],
              },
              {
                sourceId: 'hltv',
                items: [
                  {
                    url: 'https://example.test/cs2',
                    title: 'Counter-Strike',
                    publishedAt: '2026-10-04T08:00:00Z',
                  },
                ],
              },
            ],
          }),
        ],
      ]),
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    expect(await refreshNewsSnapshot(workerEnv({ BRIEFING: kv }), now, fetcher)).toEqual({
      updated: false,
    });
    const saved = JSON.parse((await kv.get(NEWS_SNAPSHOT_KEY))!);
    expect(saved.generatedAt).toBe('2026-10-04T07:00:00Z');
    expect(
      saved.groups
        .flatMap((g: { items: { url: string }[] }) => g.items)
        .map((i: { url: string }) => i.url),
    ).toEqual(['https://example.test/cs2']);
  });
  it('honors source selection and a six-hour refresh interval without extra fetches', async () => {
    const kv = memoryKv(
      new Map([['settings', JSON.stringify({ news: { sources: ['HLTV'], intervalHours: 6 } })]]),
    );
    const env = workerEnv({ BRIEFING: kv });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(item('https://www.hltv.org/news/1', '2026-10-04T08:00:00Z')));
    await refreshNewsSnapshot(env, now, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('hltv');
    await refreshNewsSnapshot(env, now + 4 * 3600000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await kv.put('settings', JSON.stringify({ news: { sources: [], intervalHours: 6 } }));
    await refreshNewsSnapshot(env, now + 4 * 3600000 + 1, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse((await kv.get(NEWS_SNAPSHOT_KEY))!);
    expect(snapshot.groups.every((g: { items: unknown[] }) => g.items.length === 0)).toBe(true);
  });
  it('takes optional public HTTPS thumbnails and rejects credential-bearing images', () => {
    const xml = item('https://example.test/a', '2026-10-04T08:00:00Z').replace(
      '</item>',
      '<media:thumbnail url="https://ichef.bbci.co.uk/photo.jpg"/></item>',
    );
    expect(parseNewsFeed(xml, now)[0]?.image).toBe('https://ichef.bbci.co.uk/photo.jpg');
    expect(
      parseNewsFeed(xml.replace('https://ichef.bbci.co.uk', 'https://secret@evil.test'), now)[0]
        ?.image,
    ).toBeUndefined();
  });
  it('rejects undated, stale, future and unsafe links; deduplicates tracking URLs', () => {
    const valid = item(
      'https://example.test/a?utm_source=rss',
      '2026-10-04T08:00:00Z',
      'A &amp; B',
    );
    const xml =
      valid +
      item('https://example.test/a', '2026-10-04T08:00:00Z') +
      item('javascript:bad', '2026-10-04T08:00:00Z') +
      item('https://example.test/future', '2026-10-05T08:00:00Z') +
      item('https://example.test/old', '2026-10-01T08:00:00Z') +
      item('https://example.test/no-date', '');
    expect(parseNewsFeed(xml, now)).toEqual([
      { title: 'A & B', url: 'https://example.test/a', publishedAt: '2026-10-04T08:00:00.000Z' },
    ]);
  });
  it('cleans encoded excerpt markup and excludes quiz and iPlayer promotions', () => {
    const xml =
      `<item><title>Research result</title><link>https://www.bbc.co.uk/news/a?at_medium=RSS&amp;at_campaign=bbc</link><pubDate>2026-10-04T08:00:00Z</pubDate><description>&lt;p&gt;One&nbsp;finding &amp; another.&lt;/p&gt;</description></item>` +
      item('https://example.test/quiz', '2026-10-04T08:00:00Z', 'Football quiz today') +
      item('https://www.bbc.co.uk/iplayer/episode/a', '2026-10-04T08:00:00Z', 'Watch today');
    expect(parseNewsFeed(xml, now)).toEqual([
      {
        title: 'Research result',
        url: 'https://www.bbc.co.uk/news/a',
        publishedAt: '2026-10-04T08:00:00.000Z',
        excerpt: 'One finding & another.',
      },
    ]);
  });
  it('caches a 3-hour cycle; one failed source does not discard others', async () => {
    const kv = memoryKv(new Map());
    const env = workerEnv({ BRIEFING: kv });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).includes('hltv')
          ? new Response('', { status: 403 })
          : new Response(item('https://example.test/a', '2026-10-04T08:00:00Z')),
      );
    await refreshNewsSnapshot(env, now, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(6);
    const saved = JSON.parse((await kv.get(NEWS_SNAPSHOT_KEY)) as string);
    expect(saved.groups).toHaveLength(7);
    expect(saved.sources.filter((s: { ok: boolean }) => !s.ok)).toHaveLength(1);
    expect(saved.groups[0].items).toHaveLength(1);
    await refreshNewsSnapshot(env, now + 60000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
