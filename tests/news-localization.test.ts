import { describe, it, expect, vi, beforeEach } from 'vitest';
import { localizeNewsGroups, translateNewsBatch } from '../web/core/brief/news-localization.mjs';
import { workerEnv } from './helpers/env.js';
let env = workerEnv();
beforeEach(() => {
  env = workerEnv();
});
const groups = () => [
  {
    items: [
      {
        title: 'New telescope launched',
        url: 'https://example.test/a',
        excerpt: 'The observatory launched on Monday.',
      },
    ],
    topic: 'Наука',
  },
];
const translator = () =>
  vi.fn(async (_env: Env, options: { prompt: string }) => {
    const input = JSON.parse(options.prompt) as { id: string }[];
    return {
      ok: true,
      structured: {
        items: input.map((i) => ({
          id: i.id,
          title: 'Запущено новий телескоп',
          summary: 'Обсерваторію запустили в понеділок.',
        })),
      },
    };
  });
describe('bounded Ukrainian RSS localization', () => {
  it('counts native Ukrainian as ready and retains translations beyond the preceding snapshot', async () => {
    const translate = translator();
    const foreign = groups();
    await localizeNewsGroups(env, foreign, null, translate);
    const mixed = [
      ...groups(),
      {
        scope: 'ua',
        topic: 'Україна',
        items: [{ title: 'Нова подія в Україні', url: 'https://www.pravda.com.ua/news/a' }],
      },
    ];
    expect(await localizeNewsGroups(env, mixed, { groups: [] }, translate)).toMatchObject({
      native: 1,
      translated: 1,
      pending: 0,
      total: 2,
    });
    expect(translate).toHaveBeenCalledTimes(1);
  });
  it('uses the existing Google API for a single text batch without leaking its key in a URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            translations: [
              { translatedText: 'Запущено новий телескоп' },
              { translatedText: 'Обсерваторію запустили в понеділок.' },
            ],
          },
        }),
      ),
    );
    const result = await translateNewsBatch(
      workerEnv({ GOOGLE_TRANSLATE_API_KEY: 'test-key' }),
      {
        prompt: JSON.stringify([
          {
            id: 'one',
            title: 'New telescope launched',
            excerpt: 'The observatory launched on Monday.',
          },
        ]),
      },
      fetcher,
    );
    expect(result).toMatchObject({
      ok: true,
      provider: 'google-translation',
      structured: { items: [{ id: 'one', title: 'Запущено новий телескоп' }] },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('test-key');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      target: 'uk',
      format: 'text',
      q: ['New telescope launched', 'The observatory launched on Monday.'],
    });
  });
  it('reports a failed translator while retaining original evidence', async () => {
    const input = groups();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }));
    const result = await localizeNewsGroups(
      workerEnv({ GOOGLE_TRANSLATE_API_KEY: 'test-key' }),
      input,
      null,
      (e, o) => translateNewsBatch(e, o, fetcher),
    );
    expect(result).toMatchObject({
      translated: 0,
      native: 0,
      pending: 1,
      error: 'translation-http-403',
    });
    expect(input[0]?.items[0]?.title).toBe('New telescope launched');
  });
  it('keeps native Ukrainian articles without paying for a translation request', async () => {
    const translate = translator();
    const feed = [
      {
        scope: 'ua',
        topic: 'Україна',
        items: [
          {
            title: 'Нові дослідження в Україні',
            excerpt: 'Результати дослідження оприлюднили сьогодні.',
            url: 'https://www.pravda.com.ua/news/example/',
          },
        ],
      },
    ];
    await localizeNewsGroups(env, feed, null, translate);
    expect(translate).not.toHaveBeenCalled();
    expect(feed[0]?.items[0]?.title).toBe('Нові дослідження в Україні');
    expect(feed[0]?.items[0]).toHaveProperty('why', 'Результати дослідження оприлюднили сьогодні.');
  });
  it('translates once, retains source evidence, reuses unchanged items, and invalidates edited source text', async () => {
    const translate = translator(),
      first = groups();
    expect(await localizeNewsGroups(env, first, null, translate)).toMatchObject({
      translated: 1,
      total: 1,
    });
    expect(first[0]?.items[0]).toMatchObject({
      title: 'Запущено новий телескоп',
      originalTitle: 'New telescope launched',
      why: 'Обсерваторію запустили в понеділок.',
    });
    await localizeNewsGroups(env, groups(), { groups: first }, translate);
    expect(translate).toHaveBeenCalledTimes(1);
    const amended = groups();
    amended[0]!.items[0]!.excerpt = 'Launch postponed.';
    await localizeNewsGroups(env, amended, { groups: first }, translate);
    expect(translate).toHaveBeenCalledTimes(2);
  });
  it('deduplicates articles across feeds and bounds the whole cycle to eighteen articles', async () => {
    const translate = translator();
    const feed = [
      ...groups(),
      ...groups(),
      {
        items: Array.from({ length: 25 }, (_, i) => ({
          title: 'News ' + i,
          url: 'https://example.test/' + i,
        })),
        topic: 'Новини',
      },
    ];
    const result = await localizeNewsGroups(env, feed, null, translate);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(translate.mock.calls[0]![1].prompt)).toHaveLength(18);
    expect(result.translated).toBe(19); // same translated article appears in two source groups
    expect(result.total).toBe(27);
  });
  it('ignores invented ids and summaries without source excerpts; failures preserve original articles', async () => {
    const feed = groups();
    delete (feed[0]!.items[0] as { excerpt?: string }).excerpt;
    const translate = translator();
    await localizeNewsGroups(env, feed, null, translate);
    expect(feed[0]?.items[0]).not.toHaveProperty('why');
    const invalid = vi.fn(async () => ({
      ok: true,
      structured: { items: [{ id: 'invented', title: 'Вигадка', summary: 'Факт' }] },
    }));
    const original = groups();
    expect(await localizeNewsGroups(env, original, null, invalid)).toMatchObject({
      translated: 0,
      total: 1,
    });
    expect(original[0]?.items[0]?.title).toBe('New telescope launched');
    expect(
      await localizeNewsGroups(env, groups(), null, async () => {
        throw new Error('offline');
      }),
    ).toMatchObject({ translated: 0, total: 1 });
  });
  it('rejects markup, non-Ukrainian and overlong outputs without dropping source articles', async () => {
    const invalid = async (_env: Env, options: { prompt: string }) => ({
      ok: true,
      structured: {
        items: [
          {
            id: JSON.parse(options.prompt)[0].id,
            title: '<script>погано</script>',
            summary: 'ignored',
          },
        ],
      },
    });
    expect(await localizeNewsGroups(env, groups(), null, invalid)).toMatchObject({
      translated: 0,
      total: 1,
    });
  });
});
