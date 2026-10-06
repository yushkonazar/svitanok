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
    expect(fetcher).toHaveBeenCalledTimes(6);
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
