import { describe, it, expect, vi } from 'vitest';
import {
  parseRss,
  extractJson,
  validateItems,
  applyVote,
  applyWeeklyDecay,
  buildNewsPrompt,
  newsModule,
  WEIGHT_MIN,
  WEIGHT_MAX,
} from '../src/modules/news.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('news — parseRss', () => {
  it('RSS 2.0 item з CDATA та сутностями', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Заголовок & теж]]></title><link>https://x.com/a</link></item>
      <item><title>B &amp; C</title><link>https://x.com/b</link></item>
    </channel></rss>`;
    const items = parseRss(xml);
    expect(items).toEqual([
      { title: 'Заголовок & теж', url: 'https://x.com/a' },
      { title: 'B & C', url: 'https://x.com/b' },
    ]);
  });

  it('Atom entry з link href', () => {
    const xml = `<feed><entry><title>Atom</title><link href="https://y.com/1"/></entry></feed>`;
    expect(parseRss(xml)).toEqual([{ title: 'Atom', url: 'https://y.com/1' }]);
  });
});

describe('news — preferenceWeights (§6.1)', () => {
  it('👍 +0.15, 👎 -0.15, межі [0.5, 2.0]', () => {
    expect(applyVote({}, 'Спорт', 'up').Спорт).toBeCloseTo(1.15);
    expect(applyVote({}, 'Спорт', 'down').Спорт).toBeCloseTo(0.85);
    expect(applyVote({ A: 2.0 }, 'A', 'up').A).toBe(WEIGHT_MAX);
    expect(applyVote({ A: 0.5 }, 'A', 'down').A).toBe(WEIGHT_MIN);
  });

  it('тижневий decay тягне до 1.0', () => {
    expect(applyWeeklyDecay({ A: 2.0 }).A).toBeCloseTo(1.9);
    expect(applyWeeklyDecay({ A: 0.5 }).A).toBeCloseTo(0.55);
  });
});

describe('news — extractJson', () => {
  it('витягує JSON з прози навколо', () => {
    const out = extractJson('Ось результат: {"items":[]} — готово');
    expect(out).toEqual({ items: [] });
  });
  it('кидає, якщо JSON немає', () => {
    expect(() => extractJson('нема тут')).toThrow();
  });
});

describe('news — validateItems (existence, §6 п.4)', () => {
  const fetched = ['https://x.com/a?id=1'];

  it('відкидає неіснуючий URL (галюцинація)', () => {
    const raw = {
      items: [{ title: 'T', url: 'https://x.com/HALLUCINATED', category: 'C', why: '' }],
    };
    expect(validateItems(raw, fetched)).toHaveLength(0);
  });

  it('приймає, коли канонізація ОБОХ боків збігається (трекінг/регістр)', () => {
    const raw = {
      items: [
        { title: 'T', url: 'HTTPS://X.com/a?id=1&utm_source=tg', category: 'C', why: 'бо важливо' },
      ],
    };
    expect(validateItems(raw, fetched)).toHaveLength(1);
  });

  it('кидає на невалідному JSON', () => {
    expect(() => validateItems({ nope: 1 }, fetched)).toThrow();
  });
});

// --- пайплайн ---
function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}

function makeCtx(
  over: { state?: StateStore; llm?: Ctx['llm']; fetcher?: Ctx['fetcher'] } = {},
): Ctx<AppConfig> {
  const noop = () => {};
  return {
    bus: createRunBus(),
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date(),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: {
      llm: { timeoutMs: 1000 },
      modules: {
        news: {
          enabled: true,
          categories: ['Тех'],
          perCategory: 2,
          dedupDays: 3,
          retentionDays: 7,
          sources: { Тех: ['https://feed.example.com/rss'] },
        },
      },
    } as unknown as AppConfig,
    state: over.state ?? memState(),
    llm: over.llm ?? { complete: async () => '{"items":[]}' },
    fetcher: over.fetcher ?? { fetch: async () => '' },
  };
}

describe('news — пайплайн run', () => {
  const rss = `<rss><channel>
    <item><title>Новина А</title><link>https://feed.example.com/a</link></item>
    <item><title>Новина Б</title><link>https://feed.example.com/b</link></item>
  </channel></rss>`;

  it('фетчить, курує, повертає Block і зберігає shownNews', async () => {
    const llm = {
      complete: vi.fn(async () =>
        JSON.stringify({
          items: [
            {
              title: 'Новина А',
              url: 'https://feed.example.com/a',
              category: 'Тех',
              why: 'важливо',
            },
          ],
        }),
      ),
    };
    const state = memState();
    const ctx = makeCtx({ state, llm, fetcher: { fetch: async () => rss } });
    const block = await newsModule.run(ctx);
    expect(block!.summary).toContain('Новина А');
    expect(block!.buttons?.[0]?.action).toBe('news:more:Тех');
    expect(Object.keys(state.get('shownNews') as object)).toContain('https://feed.example.com/a');
  });

  it('дедуп: вже показане в вікні не йде в кандидати', async () => {
    const state = memState({ shownNews: { 'https://feed.example.com/a': '2026-07-01' } });
    const seen: string[] = [];
    const llm = {
      complete: vi.fn(async (p: string) => {
        seen.push(p);
        return '{"items":[]}';
      }),
    };
    const ctx = makeCtx({ state, llm, fetcher: { fetch: async () => rss } });
    await newsModule.run(ctx);
    expect(seen[0]).not.toContain('/a'); // А відсіяно дедупом
    expect(seen[0]).toContain('/b');
  });

  it('порожні sources -> null', async () => {
    const ctx = makeCtx();
    (ctx.config.modules.news as { sources: object }).sources = {};
    expect(await newsModule.run(ctx)).toBeNull();
  });
});

describe('news — buildNewsPrompt', () => {
  it('містить категорії та кандидатів', () => {
    const p = buildNewsPrompt([{ title: 'T', url: 'https://x/1', category: 'Тех' }], ['Тех'], 2, {
      Тех: 1.5,
    });
    expect(p).toContain('Тех');
    expect(p).toContain('https://x/1');
    expect(p).toContain('1.5');
  });
});
