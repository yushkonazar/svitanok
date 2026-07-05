import { describe, it, expect } from 'vitest';
import {
  parseRss,
  applyVote,
  applyWeeklyDecay,
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

describe('news — preferenceWeights (§6.1, Phase B)', () => {
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

// --- пайплайн (без LLM) ---
function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}

function makeCtx(over: { state?: StateStore; fetcher?: Ctx['fetcher'] } = {}): Ctx<AppConfig> {
  const noop = () => {};
  return {
    bus: createRunBus(),
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date('2026-07-01T08:00:00+03:00'),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: {
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
    llm: {} as Ctx['llm'],
    fetcher: over.fetcher ?? { fetch: async () => '' },
  };
}

const rss = `<rss><channel>
  <item><title>Новина А</title><link>https://feed.example.com/a</link></item>
  <item><title>Новина Б</title><link>https://feed.example.com/b</link></item>
  <item><title>Новина В</title><link>https://feed.example.com/c</link></item>
</channel></rss>`;

describe('news — пайплайн run (без LLM)', () => {
  it('бере топ-N, клікабельні заголовки у summaryHtml, зберігає shownNews', async () => {
    const state = memState();
    const ctx = makeCtx({ state, fetcher: { fetch: async () => rss } });
    const block = await newsModule.run(ctx);
    expect(block!.summaryHtml).toContain('<a href="https://feed.example.com/a">Новина А</a>');
    expect(block!.summaryHtml).toContain('<b>Тех</b>');
    expect(block!.summary).toContain('Новина А'); // плейн-фолбек без HTML
    expect(Object.keys(state.get('shownNews') as object)).toContain('https://feed.example.com/a');
  });

  it('perCategory=2 обмежує до 2 заголовків (третій не йде)', async () => {
    const ctx = makeCtx({ fetcher: { fetch: async () => rss } });
    const block = await newsModule.run(ctx);
    expect(block!.summaryHtml).toContain('Новина А');
    expect(block!.summaryHtml).toContain('Новина Б');
    expect(block!.summaryHtml).not.toContain('Новина В');
  });

  it('дедуп: показане в вікні пропускається', async () => {
    const state = memState({ shownNews: { 'https://feed.example.com/a': '2026-07-01' } });
    const ctx = makeCtx({ state, fetcher: { fetch: async () => rss } });
    const block = await newsModule.run(ctx);
    expect(block!.summaryHtml).not.toContain('Новина А');
    expect(block!.summaryHtml).toContain('Новина Б');
  });

  it('preferenceWeights: вага 2.0 збільшує квоту (третій заголовок проходить)', async () => {
    const state = memState({ preferenceWeights: { Тех: 2.0 } });
    const ctx = makeCtx({ state, fetcher: { fetch: async () => rss } });
    const block = await newsModule.run(ctx);
    expect(block!.summaryHtml).toContain('Новина В'); // квота round(2*2.0)=4
  });

  it('preferenceWeights: вага 0.5 зменшує квоту до 1', async () => {
    const state = memState({ preferenceWeights: { Тех: 0.5 } });
    const ctx = makeCtx({ state, fetcher: { fetch: async () => rss } });
    const block = await newsModule.run(ctx);
    expect(block!.summaryHtml).toContain('Новина А');
    expect(block!.summaryHtml).not.toContain('Новина Б'); // квота round(2*0.5)=1
  });

  it('порожні sources -> null', async () => {
    const ctx = makeCtx();
    (ctx.config.modules.news as { sources: object }).sources = {};
    expect(await newsModule.run(ctx)).toBeNull();
  });

  it('усі фіди впали -> null', async () => {
    const ctx = makeCtx({
      fetcher: {
        fetch: async () => {
          throw new Error('fail');
        },
      },
    });
    expect(await newsModule.run(ctx)).toBeNull();
  });
});
