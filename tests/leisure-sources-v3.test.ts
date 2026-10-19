import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  collectPodcastFeed,
  collectPlaneta,
  articleCandidate,
} from '../web/core/leisure/catalog.mjs';
import { leisureFeatures } from '../web/core/leisure/discovery.mjs';
import { leisureDiscoveryQueries } from '../web/core/leisure/discovery-queries.mjs';
import { DEFAULT_LEISURE_SETTINGS } from '../web/core/leisure/model.mjs';
const now = Date.parse('2026-10-19T06:00:00Z');
afterEach(() => vi.unstubAllGlobals());
describe('verified discovery metadata', () => {
  it('reads publisher RSS metadata with CDATA, duration and stable episode identity without requesting audio', async () => {
    const xml =
      '<?xml version="1.0"?><rss><channel><item><title><![CDATA[Зоряні війни &amp; книжки]]></title><guid>episode-1</guid><link>https://hromadske.radio/podcasts/book/episode</link><description><![CDATA[<p>Розмова про книгу.</p>]]></description><pubDate>Sat, 17 Oct 2026 15:23:07 +0300</pubDate><itunes:duration>00:24:12</itunes:duration><enclosure url="https://audio.example.com/file.mp3"/></item><item><title>Зовнішня підміна</title><link>https://unknown.example.com/tracker</link></item></channel></rss>';
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml)));
    vi.stubGlobal('fetch', fetch);
    const source = { name: 'Книжкова полиця', url: 'https://hromadske.radio/podcasts/book/feed' };
    const items = await collectPodcastFeed(source, now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Зоряні війни & книжки',
      category: 'podcast',
      medium: 'online',
      durationMinutes: 25,
      identityKey: 'episode:episode-1',
      publishedAt: '2026-10-17T12:23:07.000Z',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await collectPodcastFeed(source, now))[0]!.id).toBe(items[0]!.id);
  });
  it('accepts official genre tags while excluding country and marketing moods', async () => {
    const state = {
      data: [
        {
          movies: [
            {
              id: 1,
              slug: 'film',
              name: 'Фільм',
              durationInSec: 7200,
              categories: { nodes: [{ name: 'Голівудське' }] },
              cloudTags: ['Голівудське', 'Екшн', 'Трилер', 'Вражаюче'],
              offlineRental: { sessions: [], start: '2026-10-19', end: '2026-11-01' },
            },
          ],
        },
      ],
    };
    // The existing decoder accepts the published Nuxt payload representation.
    const payload = JSON.stringify(state);
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<script>window.__NUXT__=(function(a){return ' + payload + '}(null));</script>',
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const items = await collectPlaneta(now, { cinemas: ['forum-lviv'] });
    expect(items[0]?.genre).toContain('Екшн');
    expect(items[0]?.genre).toContain('Трилер');
    expect(items[0]?.genre).not.toContain('Голівудське');
    expect(items[0]?.genre).not.toContain('Вражаюче');
  });
  it('rotates bounded searches and respects disabled categories', () => {
    const a = leisureDiscoveryQueries(DEFAULT_LEISURE_SETTINGS, {}, now),
      b = leisureDiscoveryQueries(DEFAULT_LEISURE_SETTINGS, {}, now + 7 * 86400000);
    expect(a).toHaveLength(8);
    expect(a).not.toEqual(b);
    expect(a.filter((q) => q.category === 'place')).toHaveLength(3);
    expect(leisureFeatures({ category: 'food', placeType: 'italian_restaurant' })).toContain(
      'cuisine:italian',
    );
    expect(
      leisureDiscoveryQueries(
        DEFAULT_LEISURE_SETTINGS,
        { interests: [{ feature: 'cuisine:italian', score: 1 }] },
        now,
      ).some((q) => q.query.includes('італійські')),
    ).toBe(true);
    expect(
      leisureDiscoveryQueries(
        { ...DEFAULT_LEISURE_SETTINGS, categories: ['place'] },
        {},
        now,
      ).every((q) => q.category === 'place'),
    ).toBe(true);
  });
  it('classifies dated workshops and festivals from publisher articles', () => {
    for (const [title, category] of [
      ['Майстер-клас із кераміки', 'meetup'],
      ['Фестиваль культури', 'festival'],
    ])
      expect(
        articleCandidate(
          '<h1>' + title + '</h1><p>22 жовтня 2026</p>',
          'https://lviv.travel/ua/events/test',
          'Видавець',
        )?.category,
      ).toBe(category);
  });
});
