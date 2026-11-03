import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewsRefreshDO } from '../web/core/brief/news-refresh-do.mjs';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';
const now = Date.parse('2026-10-06T12:00:00Z');
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const kv = new Map<string, string>();
  const storage = new Map<string, unknown>();
  const env = workerEnv({ BRIEFING: memoryKv(kv) });
  const news = new NewsRefreshDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
      },
    } as never,
    env,
  );
  return { news, env, storage, kv };
}
describe('atomic news refresh and feedback', () => {
  it('persists explicit reader choices, accepts known stale versions and rejects invented stories', async () => {
    const { news, storage } = setup();
    storage.set('snapshot', {
      groups: [
        {
          scope: 'ua',
          topic: 'Україна',
          items: [
            {
              storyId: 'event',
              contentVersion: 'v2',
              url: 'https://example.test/current',
              title: 'Поточний матеріал',
            },
          ],
        },
      ],
    });
    storage.set('recentStories', {
      event: {
        item: { storyId: 'event', url: 'https://example.test/old', title: 'Попередній матеріал' },
        versions: ['v1', 'v2'],
        at: Date.now(),
      },
    });
    const [follow, read] = await Promise.all([
      news.storyAction('event', 'follow', undefined),
      news.storyAction('event', 'read', 'v1'),
    ]);
    expect(follow.ok).toBe(true);
    expect(read.ok).toBe(true);
    expect(await news.getReader()).toMatchObject({
      following: { event: { topic: 'Україна' } },
      readVersions: { event: ['v1'] },
    });
    expect(await news.storyAction('event', 'read', 'invented')).toMatchObject({ ok: false });
    expect(await news.storyAction('__proto__', 'follow', undefined)).toMatchObject({ ok: false });
    expect(await news.storyAction('missing', 'follow', undefined)).toMatchObject({ ok: false });
    storage.set('snapshot', { groups: [] });
    storage.delete('recentStories');
    expect(await news.storyAction('event', 'unfollow', undefined)).toMatchObject({ ok: true });
    expect((await news.getReader()).following).toEqual({});
  });
  it('marks old saved URLs read without fetching them or allowing arbitrary follows', async () => {
    const { news } = setup(),
      url = 'https://example.test/saved-years-ago';
    expect(await news.storyAction(url, 'read', url)).toMatchObject({ ok: true });
    expect((await news.getReader()).readVersions[url]).toEqual([url]);
    expect(await news.storyAction(url, 'follow', undefined)).toMatchObject({ ok: false });
    expect(await news.storyAction('javascript:bad', 'read', 'javascript:bad')).toMatchObject({
      ok: false,
    });
  });
  it('serializes simultaneous refreshes so only one batch reaches external sources', async () => {
    const { news } = setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (url) =>
          new Response(
            `<item><title>News from ${String(url)}</title><link>https://example.test/${encodeURIComponent(String(url))}</link><pubDate>Tue, 06 Oct 2026 11:00:00 GMT</pubDate></item>`,
          ),
      );
    vi.stubGlobal('fetch', fetcher);
    const results = await Promise.all([news.refresh(now, true), news.refresh(now, true)]);
    expect(results[0]).toMatchObject({ updated: true });
    expect(results[1]).toMatchObject({ skipped: 'cooldown' });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it('retains canonical snapshots despite a stale KV mirror and toggles explicit feedback', async () => {
    const { news, storage, kv } = setup();
    const snapshot = {
      groups: [
        { topic: 'Головне', items: [{ title: 'Подія', url: 'https://www.bbc.com/news/a' }] },
      ],
    };
    storage.set('snapshot', snapshot);
    kv.set('miniAppNewsSnapshot', '{}');
    expect(await news.getSnapshot()).toEqual(snapshot);
    expect(await news.feedback('https://www.bbc.com/news/a', 'like')).toMatchObject({
      ok: true,
      feedback: { 'https://www.bbc.com/news/a': 'like' },
    });
    expect(await news.feedback('https://www.bbc.com/news/a', 'less')).toMatchObject({
      ok: true,
      feedback: { 'https://www.bbc.com/news/a': 'less' },
    });
    expect(await news.feedback('https://unknown.test/a', 'like')).toMatchObject({ ok: false });
    storage.set('snapshot', { groups: [] });
    storage.set('recentArticles', {
      'https://www.bbc.com/news/a': { topic: 'Головне', at: Date.now() },
    });
    expect(await news.feedback('https://www.bbc.com/news/a', 'clear')).toMatchObject({
      ok: true,
      feedback: { 'https://www.bbc.com/news/a': 'clear' },
    });
  });
});
