import { describe, it, expect, vi } from 'vitest';
import {
  parseRss,
  parseNewsData,
  applyVote,
  applyWeeklyDecay,
  createNewsModule,
  WEIGHT_MIN,
  WEIGHT_MAX,
  DAILY_NEWS_LIMIT,
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
    expect(parseRss(xml)).toEqual([
      { title: 'Заголовок & теж', url: 'https://x.com/a' },
      { title: 'B & C', url: 'https://x.com/b' },
    ]);
  });
  it('Atom entry з link href', () => {
    const xml = `<feed><entry><title>Atom</title><link href="https://y.com/1"/></entry></feed>`;
    expect(parseRss(xml)).toEqual([{ title: 'Atom', url: 'https://y.com/1' }]);
  });
  it('відкидає небезпечну схему (javascript:), M2', () => {
    const xml = `<rss><channel>
      <item><title>Bad</title><link>javascript:alert(1)</link></item>
      <item><title>Good</title><link>https://x.com/a</link></item>
    </channel></rss>`;
    expect(parseRss(xml)).toEqual([{ title: 'Good', url: 'https://x.com/a' }]);
  });
});

describe('news — parseNewsData', () => {
  it('парсить results -> {title,url,why}; відкидає порожні/малформат', () => {
    expect(
      parseNewsData({ results: [{ title: 'T', link: 'https://x.com/a', description: 'd' }] }),
    ).toEqual([{ title: 'T', url: 'https://x.com/a', why: 'd' }]);
    expect(
      parseNewsData({ results: [{ title: '', link: 'https://x.com/a' }, { title: 'X' }] }),
    ).toEqual([]);
    expect(parseNewsData('нема')).toEqual([]);
  });
  it('відкидає небезпечну схему (javascript:), M2', () => {
    expect(parseNewsData({ results: [{ title: 'T', link: 'javascript:alert(1)' }] })).toEqual([]);
  });
});

describe('news — preferenceWeights', () => {
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

// --- пайплайн (NewsData) ---
function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}

function makeCtx(state: StateStore = memState()): Ctx<AppConfig> {
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
          perTopic: 2,
          dedupDays: 3,
          retentionDays: 7,
          topics: [{ scope: 'ua', topic: 'Тех', category: 'technology', language: 'uk' }],
        },
      },
    } as unknown as AppConfig,
    state,
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  };
}

const sample = [
  { title: 'Новина А', link: 'https://feed.example.com/a', description: 'опис А' },
  { title: 'Новина Б', link: 'https://feed.example.com/b' },
  { title: 'Новина В', link: 'https://feed.example.com/c' },
];
const resp = (items: unknown[]) =>
  new Response(JSON.stringify({ status: 'success', results: items }), { status: 200 });
const mod = (f: unknown) => createNewsModule({ fetchImpl: f as typeof fetch, apiKey: 'k' });

describe('news — пайплайн run (NewsData)', () => {
  it('топ-N, клікабельні заголовки, why з опису, scope/topic, зберігає shownNews', async () => {
    const state = memState();
    const block = await mod(vi.fn(async () => resp(sample))).run(makeCtx(state));
    expect(block!.summaryHtml).toContain('<a href="https://feed.example.com/a">Новина А</a>');
    expect(block!.summaryHtml).toContain('<b>Тех</b>');
    const g = (
      block!.data as { groups: { scope: string; topic: string; items: { why?: string }[] }[] }
    ).groups[0]!;
    expect(g.scope).toBe('ua');
    expect(g.topic).toBe('Тех');
    expect(g.items[0]!.why).toBe('опис А');
    expect(Object.keys(state.get('shownNews') as object)).toContain('https://feed.example.com/a');
  });

  it('perTopic=2 обмежує; третій -> more', async () => {
    const block = await mod(vi.fn(async () => resp(sample))).run(makeCtx());
    const g = (block!.data as { groups: { items: unknown[]; more: { title: string }[] }[] })
      .groups[0]!;
    expect(g.items).toHaveLength(2);
    expect(g.more.map((x) => x.title)).toContain('Новина В');
    expect(block!.summaryHtml).not.toContain('Новина В');
  });

  it('дедуп: показане в вікні пропускається', async () => {
    const state = memState({ shownNews: { 'https://feed.example.com/a': '2026-07-01' } });
    const block = await mod(vi.fn(async () => resp(sample))).run(makeCtx(state));
    expect(block!.summaryHtml).not.toContain('Новина А');
    expect(block!.summaryHtml).toContain('Новина Б');
  });

  it('вага 2.0 збільшує квоту (третій проходить); 0.5 зменшує до 1', async () => {
    const up = await mod(vi.fn(async () => resp(sample))).run(
      makeCtx(memState({ preferenceWeights: { Тех: 2.0 } })),
    );
    expect(up!.summaryHtml).toContain('Новина В');
    const down = await mod(vi.fn(async () => resp(sample))).run(
      makeCtx(memState({ preferenceWeights: { Тех: 0.5 } })),
    );
    expect(down!.summaryHtml).toContain('Новина А');
    expect(down!.summaryHtml).not.toContain('Новина Б');
  });

  it('немає apiKey -> null', async () => {
    const m = createNewsModule({ fetchImpl: (async () => resp(sample)) as typeof fetch });
    // без apiKey і без env NEWSDATA_API_KEY
    const prev = process.env.NEWSDATA_API_KEY;
    delete process.env.NEWSDATA_API_KEY;
    expect(await m.run(makeCtx())).toBeNull();
    if (prev) process.env.NEWSDATA_API_KEY = prev;
  });

  it('усі теми впали -> null', async () => {
    const block = await mod(
      vi.fn(async () => {
        throw new Error('fail');
      }),
    ).run(makeCtx());
    expect(block).toBeNull();
  });
});

describe('news — денний лічильник NewsData (SL4)', () => {
  it('інкрементує newsRequests за прогін (1 тема -> +1)', async () => {
    const state = memState();
    await mod(vi.fn(async () => resp(sample))).run(makeCtx(state));
    expect(state.get('newsRequests')).toEqual({ date: '2026-07-01', count: 1 });
  });

  it('скидається на нову добу', async () => {
    const state = memState({ newsRequests: { date: '2026-06-30', count: 150 } });
    await mod(vi.fn(async () => resp(sample))).run(makeCtx(state));
    expect(state.get('newsRequests')).toEqual({ date: '2026-07-01', count: 1 });
  });

  it('понад ліміт -> не фетчить, лічильник не росте, блок null', async () => {
    const state = memState({ newsRequests: { date: '2026-07-01', count: DAILY_NEWS_LIMIT } });
    const fetchSpy = vi.fn(async () => resp(sample));
    const block = await mod(fetchSpy).run(makeCtx(state));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(block).toBeNull();
    expect(state.get('newsRequests')).toEqual({ date: '2026-07-01', count: DAILY_NEWS_LIMIT });
  });

  it('лічильник персиститься, навіть коли нічого не взято (усе дедуплено) — кредит витрачено', async () => {
    const state = memState({
      shownNews: {
        'https://feed.example.com/a': '2026-07-01',
        'https://feed.example.com/b': '2026-07-01',
        'https://feed.example.com/c': '2026-07-01',
      },
    });
    const fetchSpy = vi.fn(async () => resp(sample));
    const block = await mod(fetchSpy).run(makeCtx(state));
    expect(block).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(state.get('newsRequests')).toEqual({ date: '2026-07-01', count: 1 });
  });
});
