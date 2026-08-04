import { describe, it, expect, vi } from 'vitest';
import {
  parseRss,
  parseNewsData,
  applyVote,
  applyUrlVote,
  applyWeeklyDecay,
  createNewsModule,
  curlFetch,
  buildNewsUrl,
  WEIGHT_MIN,
  WEIGHT_MAX,
  DAILY_NEWS_LIMIT,
} from '../src/modules/news.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('news — buildNewsUrl (category / q)', () => {
  const key = 'K';
  const p = (url: string) => new URL(url).searchParams;

  it('класична тема: category + language (+country)', () => {
    const q = p(
      buildNewsUrl(key, {
        scope: 'ua',
        topic: 'Головне',
        category: 'top',
        country: 'ua',
        language: 'uk',
      }),
    );
    expect(q.get('category')).toBe('top');
    expect(q.get('language')).toBe('uk');
    expect(q.get('country')).toBe('ua');
    expect(q.get('q')).toBeNull(); // без пошуку — параметра просто немає
  });

  it('тема-пошук БЕЗ категорії (оборона): ставиться q, category відсутній', () => {
    // NewsData не має категорії «війна/оборона» — тому пошук за словами.
    const q = p(
      buildNewsUrl(key, {
        scope: 'ua',
        topic: 'Оборона',
        q: 'війна OR оборона OR фронт',
        country: 'ua',
        language: 'uk',
      }),
    );
    expect(q.get('q')).toBe('війна OR оборона OR фронт');
    expect(q.get('category')).toBeNull();
    expect(q.get('country')).toBe('ua');
  });

  it('світова тема без country — параметр не ставиться', () => {
    const q = p(
      buildNewsUrl(key, { scope: 'world', topic: 'Наука', category: 'science', language: 'en' }),
    );
    expect(q.get('country')).toBeNull();
    expect(q.get('language')).toBe('en');
  });
});

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

  it('publishedAt з <pubDate> (RSS2.0) -> ISO', () => {
    const xml = `<rss><channel>
      <item><title>A</title><link>https://x.com/a</link><pubDate>Mon, 27 Jul 2026 10:00:00 GMT</pubDate></item>
    </channel></rss>`;
    expect(parseRss(xml)[0]!.publishedAt).toBe('2026-07-27T10:00:00.000Z');
  });

  it('publishedAt з Atom <updated> -> ISO', () => {
    const xml = `<feed><entry><title>A</title><link href="https://y.com/1"/><updated>2026-07-27T12:30:00Z</updated></entry></feed>`;
    expect(parseRss(xml)[0]!.publishedAt).toBe('2026-07-27T12:30:00.000Z');
  });

  it('без дати чи непарсибельна дата -> publishedAt відсутній', () => {
    const xml = `<rss><channel>
      <item><title>A</title><link>https://x.com/a</link></item>
      <item><title>B</title><link>https://x.com/b</link><pubDate>не дата</pubDate></item>
    </channel></rss>`;
    expect(parseRss(xml)).toEqual([
      { title: 'A', url: 'https://x.com/a' },
      { title: 'B', url: 'https://x.com/b' },
    ]);
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

  it('CDATA-артефакт у description знімається (той самий stripCdata/decodeXml, що parseRss)', () => {
    // NewsData інколи віддає description НЕОБРОБЛЕНИМ від оригінальної RSS-
    // стрічки видавця — сирий XML-фрагмент просвічував у why як є.
    expect(
      parseNewsData({
        results: [
          {
            title: 'T',
            link: 'https://x.com/a',
            description: '<![CDATA[Текст із &amp; сутністю]]>',
          },
        ],
      }),
    ).toEqual([{ title: 'T', url: 'https://x.com/a', why: 'Текст із & сутністю' }]);
  });

  it('publishedAt з NewsData "YYYY-MM-DD HH:mm:ss" (без таймзони) -> ISO з UTC-корекцією', () => {
    expect(
      parseNewsData({
        results: [{ title: 'T', link: 'https://x.com/a', pubDate: '2026-07-27 14:30:00' }],
      }),
    ).toEqual([{ title: 'T', url: 'https://x.com/a', publishedAt: '2026-07-27T14:30:00.000Z' }]);
  });

  it('без pubDate -> publishedAt відсутній', () => {
    expect(parseNewsData({ results: [{ title: 'T', link: 'https://x.com/a' }] })).toEqual([
      { title: 'T', url: 'https://x.com/a' },
    ]);
  });
});

// ⚠️ Тести нижче ганяють dir:'down', хоч UI його вже НЕ створює (фідбек
// власника, п.5: ❤️ замість 👍/👎). Це не мертвий код: у KV лежать старі
// дизлайки, і applyVote/applyUrlVote мусять уміти їх прочитати й відкотити.
// Межа така: СТВОРИТИ дизлайк не можна (web/worker.js: 400 на будь-що, крім
// 'up'), ЗРОЗУМІТИ збережений — обовʼязково.

describe('news — preferenceWeights', () => {
  it('👍 +0.15, легасі-👎 -0.15, межі [0.5, 2.0]', () => {
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

describe('news — applyUrlVote: чесний облік голосів per-url (C3)', () => {
  it('перший голос — зсуває вагу і памʼятає url із реальним delta', () => {
    const r = applyUrlVote({}, {}, 'https://x/a', 'Спорт', 'up');
    expect(r.weights.Спорт).toBeCloseTo(1.15);
    expect(r.votedUrls['https://x/a']).toMatchObject({ dir: 'up', category: 'Спорт' });
    expect(r.votedUrls['https://x/a']?.delta).toBeCloseTo(0.15);
    expect(r.newDir).toBe('up');
    expect(r.prevDir).toBeNull();
  });

  it('повторний ТОЙ САМИЙ голос — знімає (toggle-off), вага повертається', () => {
    const first = applyUrlVote({}, {}, 'https://x/a', 'Спорт', 'up');
    const second = applyUrlVote(first.weights, first.votedUrls, 'https://x/a', 'Спорт', 'up');
    expect(second.weights.Спорт).toBeCloseTo(1.0); // +0.15 відкочено
    expect(second.votedUrls['https://x/a']).toBeUndefined();
    expect(second.newDir).toBeNull();
    expect(second.prevDir).toBe('up');
  });

  it('спам того самого 👍 НЕ розганяє вагу без стелі (головна мета C3)', () => {
    let w = {};
    let vu = {};
    for (let i = 0; i < 5; i++) {
      const r = applyUrlVote(w, vu, 'https://x/a', 'Наука', 'up');
      w = r.weights;
      vu = r.votedUrls;
    }
    expect((w as Record<string, number>).Наука).toBeCloseTo(1.15);
  });

  it('зміна голосу up -> down: відкат up, застосування down', () => {
    const up = applyUrlVote({}, {}, 'https://x/a', 'Кіно', 'up'); // 1.15
    const down = applyUrlVote(up.weights, up.votedUrls, 'https://x/a', 'Кіно', 'down');
    expect(down.weights.Кіно).toBeCloseTo(0.85); // 1.15 -0.15(відкат) -0.15(down) = 0.85
    expect(down.votedUrls['https://x/a']).toMatchObject({ dir: 'down', category: 'Кіно' });
    expect(down.prevDir).toBe('up');
    expect(down.prevCategory).toBe('Кіно');
    expect(down.newDir).toBe('down');
  });

  it('різні url тієї ж теми — кожен рахується (це не дедуп теми, а дедуп url)', () => {
    const a = applyUrlVote({}, {}, 'https://x/a', 'Тех', 'up');
    const b = applyUrlVote(a.weights, a.votedUrls, 'https://x/b', 'Тех', 'up');
    expect(b.weights.Тех).toBeCloseTo(1.3); // два різні url = +0.30
  });

  // ── Регресії з ревʼю C ───────────────────────────────────────────────────
  it('на межі clamp голос не дрейфує в ПРОТИЛЕЖНИЙ бік (ревʼю C)', () => {
    // Вага на дні 0.5. down — no-op (clamp). Toggle-off раніше додавав +0.15 ->
    // 0.65 (dislike ставав boost). Тепер відкат = записаний delta (0) -> лишається 0.5.
    const down = applyUrlVote({ Тех: 0.5 }, {}, 'https://x/a', 'Тех', 'down');
    expect(down.weights.Тех).toBeCloseTo(0.5);
    expect(down.votedUrls['https://x/a']?.delta).toBeCloseTo(0); // no-op зафіксовано
    const off = applyUrlVote(down.weights, down.votedUrls, 'https://x/a', 'Тех', 'down');
    expect(off.weights.Тех).toBeCloseTo(0.5); // НЕ 0.65
    // Стеля — дзеркально.
    const up = applyUrlVote({ Тех: 2.0 }, {}, 'https://x/b', 'Тех', 'up');
    const upOff = applyUrlVote(up.weights, up.votedUrls, 'https://x/b', 'Тех', 'up');
    expect(upOff.weights.Тех).toBeCloseTo(2.0); // НЕ 1.85
  });

  it('той самий url під ІНШОЮ темою — prevCategory показує стару тему (ревʼю C)', () => {
    // Голос по url під «Наука», потім той самий url приходить під «Тех».
    const first = applyUrlVote({}, {}, 'https://x/a', 'Наука', 'up');
    const second = applyUrlVote(first.weights, first.votedUrls, 'https://x/a', 'Тех', 'up');
    // prev.dir(up)===clicked(up) -> toggle off; вага «Наука» відкочується, «Тех» не чіпається.
    expect(second.weights.Наука).toBeCloseTo(1.0);
    expect(second.weights.Тех ?? 1.0).toBeCloseTo(1.0);
    expect(second.prevCategory).toBe('Наука');
    expect(second.newDir).toBeNull();
  });
});

describe('news — ❤️ поверх легасі-дизлайків (фідбек власника, п.5)', () => {
  it('лайк раніше дизлайкнутої новини відкочує мінус і ставить плюс', () => {
    // Так виглядає прод-KV після переходу на ❤️: голос створений старим UI.
    const legacy = applyUrlVote({}, {}, 'https://x/a', 'Кіно', 'down');
    expect(legacy.weights.Кіно).toBeCloseTo(0.85);

    // Власник тисне ❤️ — єдиний напрямок, який лишився.
    const heart = applyUrlVote(legacy.weights, legacy.votedUrls, 'https://x/a', 'Кіно', 'up');
    // 0.85 +0.15(відкат старого) +0.15(лайк) = 1.15. Тобто рівно як у новини,
    // яку ніколи не чіпали й одразу лайкнули.
    expect(heart.weights.Кіно).toBeCloseTo(1.15);
    expect(heart.prevDir).toBe('down');
    expect(heart.votedUrls['https://x/a']).toMatchObject({ dir: 'up', category: 'Кіно' });
  });

  it('легасі-дизлайк на дні клампа: лайк не перестрибує через відкат «номіналу»', () => {
    // delta старого голосу = 0 (вага вже була на дні) -> відкочувати нічого.
    const legacy = applyUrlVote({ Тех: 0.5 }, {}, 'https://x/a', 'Тех', 'down');
    expect(legacy.votedUrls['https://x/a']?.delta).toBeCloseTo(0);
    const heart = applyUrlVote(legacy.weights, legacy.votedUrls, 'https://x/a', 'Тех', 'up');
    expect(heart.weights.Тех).toBeCloseTo(0.65); // 0.5 + 0(відкат) + 0.15, а не 0.80
  });

  it('повторне ❤️ знімає лайк — і НЕ воскрешає старий дизлайк', () => {
    const legacy = applyUrlVote({}, {}, 'https://x/a', 'Кіно', 'down');
    const heart = applyUrlVote(legacy.weights, legacy.votedUrls, 'https://x/a', 'Кіно', 'up');
    const off = applyUrlVote(heart.weights, heart.votedUrls, 'https://x/a', 'Кіно', 'up');
    expect(off.weights.Кіно).toBeCloseTo(1.0); // нейтрально, а не назад у 0.85
    expect(off.votedUrls['https://x/a']).toBeUndefined();
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

function makeCtx(
  state: StateStore = memState(),
  opts: { sunday?: boolean; topics?: unknown[] } = {},
): Ctx<AppConfig> {
  const noop = () => {};
  return {
    bus: createRunBus(),
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date('2026-07-01T08:00:00+03:00'),
      // Доти було зашито false — тобто недільна гілка (decay ваг) не тестувалась
      // ЖОДНОГО разу, і саме в ній жив баг із повторним decay на force-ранах.
      isSunday: () => opts.sunday === true,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: {
      modules: {
        news: {
          enabled: true,
          perTopic: 2,
          dedupDays: 3,
          retentionDays: 7,
          topics: opts.topics ?? [
            { scope: 'ua', topic: 'Тех', category: 'technology', language: 'uk' },
          ],
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

describe('news — джерело rss (HN / GitHub Releases)', () => {
  const RSS_TOPIC = [
    {
      scope: 'world',
      topic: 'Hacker News',
      source: 'rss',
      url: 'https://hnrss.org/frontpage',
      language: 'en',
    },
  ];
  const feed = `<rss><channel>
      <item><title>HN one</title><link>https://news.example.com/1</link></item>
      <item><title>HN two</title><link>https://news.example.com/2</link></item>
    </channel></rss>`;
  const rssResp = () => new Response(feed, { status: 200 });

  it('парсить стрічку й НЕ витрачає кредит NewsData', async () => {
    const state = memState();
    const fetchSpy = vi.fn(async (_u: unknown) => rssResp());
    const block = await mod(fetchSpy).run(makeCtx(state, { topics: RSS_TOPIC }));
    const g = (block!.data as { groups: { topic: string; items: { title: string }[] }[] })
      .groups[0]!;
    expect(g.topic).toBe('Hacker News');
    expect(g.items.map((i) => i.title)).toEqual(['HN one', 'HN two']);
    // Ключове: лічильник кредитів НЕ рухався — стрічка коштує нуль. (Сам лічильник
    // персиститься завжди, тож перевіряємо саме count, а не його відсутність.)
    expect(state.get('newsRequests')).toEqual({ date: '2026-07-01', count: 0 });
    // Фетчили саме URL стрічки, а не newsdata.io.
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://hnrss.org/frontpage');
  });

  it('працює навіть коли денний ліміт NewsData вичерпано', async () => {
    const state = memState({ newsRequests: { date: '2026-07-01', count: DAILY_NEWS_LIMIT } });
    const block = await mod(vi.fn(async () => rssResp())).run(
      makeCtx(state, { topics: RSS_TOPIC }),
    );
    expect(block).not.toBeNull();
  });

  it('без NEWSDATA_API_KEY модуль не мовчить — віддає стрічки', async () => {
    const m = createNewsModule({ fetchImpl: (async () => rssResp()) as typeof fetch });
    const block = await m.run(makeCtx(memState(), { topics: RSS_TOPIC }));
    expect(block).not.toBeNull();
  });

  it('кастомні headers доходять до фетч-виклику (HLTV — потрібен конкретний User-Agent)', async () => {
    const topics = [
      {
        scope: 'world',
        topic: 'Кіберспорт',
        source: 'rss',
        url: 'https://hltv.org/rss/news',
        language: 'en',
        headers: { 'User-Agent': 'Mozilla/5.0 (real browser)' },
      },
    ];
    const fetchSpy = vi.fn(async (_u: unknown, _init?: unknown) => rssResp());
    await mod(fetchSpy).run(makeCtx(memState(), { topics }));
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
      headers: { 'User-Agent': 'Mozilla/5.0 (real browser)' },
    });
  });

  it('newsdata-темі headers ігноруються (лише rss їх розуміє)', async () => {
    const topics = [
      { scope: 'ua', topic: 'Тех', category: 'technology', language: 'uk', headers: { X: 'y' } },
    ];
    const fetchSpy = vi.fn(async (_u: unknown, _init?: unknown) => resp(sample));
    await mod(fetchSpy).run(makeCtx(memState(), { topics }));
    expect(
      (fetchSpy.mock.calls[0]![1] as { headers?: unknown } | undefined)?.headers,
    ).toBeUndefined();
  });

  const HLTV_TOPIC = [
    {
      scope: 'world',
      topic: 'Кіберспорт',
      source: 'rss',
      url: 'https://hltv.org/rss/news',
      language: 'en',
      headers: { 'User-Agent': 'Mozilla/5.0 (real browser)' },
    },
  ];

  it('403 на rss -> curl-фолбек, і якщо curl ok -> бере його body', async () => {
    const fetchSpy = vi.fn(async () => new Response('blocked', { status: 403 }));
    const curlSpy: typeof curlFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => feed,
      json: async () => {
        throw new Error('n/a');
      },
    }));
    const m = createNewsModule({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      curlFetchImpl: curlSpy,
      apiKey: 'k',
    });
    const block = await m.run(makeCtx(memState(), { topics: HLTV_TOPIC }));
    const g = (block!.data as { groups: { topic: string; items: { title: string }[] }[] })
      .groups[0]!;
    expect(g.items.map((i) => i.title)).toEqual(['HN one', 'HN two']);
    expect(curlSpy).toHaveBeenCalledWith(
      'https://hltv.org/rss/news',
      { 'User-Agent': 'Mozilla/5.0 (real browser)' },
      expect.any(Number),
    );
  });

  it('403 на rss, curl теж не рятує -> тема graceful пропускається (не валить весь ран)', async () => {
    const fetchSpy = vi.fn(async () => new Response('blocked', { status: 403 }));
    const curlSpy: typeof curlFetch = vi.fn(async () => {
      throw new Error('curl exit 7: could not connect');
    });
    const m = createNewsModule({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      curlFetchImpl: curlSpy,
      apiKey: 'k',
    });
    const block = await m.run(makeCtx(memState(), { topics: HLTV_TOPIC }));
    expect(block).toBeNull(); // єдина тема впала -> нема що показати, той самий graceful-шлях
  });

  it('не-403 помилка (rss) -> curl НЕ пробуємо', async () => {
    const fetchSpy = vi.fn(async () => new Response('boom', { status: 500 }));
    const curlSpy: typeof curlFetch = vi.fn();
    const m = createNewsModule({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      curlFetchImpl: curlSpy,
      apiKey: 'k',
    });
    await m.run(makeCtx(memState(), { topics: HLTV_TOPIC }));
    expect(curlSpy).not.toHaveBeenCalled();
  });

  it('403 у newsdata-темі (не rss) -> curl НЕ пробуємо', async () => {
    const fetchSpy = vi.fn(async () => new Response('blocked', { status: 403 }));
    const curlSpy: typeof curlFetch = vi.fn();
    const m = createNewsModule({
      fetchImpl: fetchSpy as unknown as typeof fetch,
      curlFetchImpl: curlSpy,
      apiKey: 'k',
    });
    await m.run(
      makeCtx(memState(), {
        topics: [{ scope: 'ua', topic: 'Тех', category: 'technology', language: 'uk' }],
      }),
    );
    expect(curlSpy).not.toHaveBeenCalled();
  });
});

describe('news — includePattern/excludePattern (фільтр шуму монорепо-стрічок)', () => {
  const feed = `<rss><channel>
      <item><title>v5.4.10</title><link>https://github.com/vitejs/vite/releases/tag/v5.4.10</link></item>
      <item><title>plugin-legacy@8.2.2</title><link>https://github.com/vitejs/vite/releases/tag/plugin-legacy@8.2.2</link></item>
    </channel></rss>`;

  it('includePattern лишає лише title, що матчить', async () => {
    const topics = [
      {
        scope: 'world',
        topic: 'Релізи',
        source: 'rss',
        url: 'https://x',
        language: 'en',
        includePattern: '^v?\\d+\\.\\d+\\.\\d+$',
      },
    ];
    const block = await mod(vi.fn(async () => new Response(feed, { status: 200 }))).run(
      makeCtx(memState(), { topics }),
    );
    const g = (block!.data as { groups: { items: { title: string }[] }[] }).groups[0]!;
    expect(g.items.map((i) => i.title)).toEqual(['v5.4.10']);
  });

  it('excludePattern викидає title, що матчить (напр. beta/rc)', async () => {
    const betaFeed = `<rss><channel>
      <item><title>REL_19_0</title><link>https://x/1</link></item>
      <item><title>REL_19_BETA2</title><link>https://x/2</link></item>
    </channel></rss>`;
    const topics = [
      {
        scope: 'world',
        topic: 'Релізи',
        source: 'rss',
        url: 'https://x',
        language: 'en',
        excludePattern: '(beta|rc|alpha)',
      },
    ];
    const block = await mod(vi.fn(async () => new Response(betaFeed, { status: 200 }))).run(
      makeCtx(memState(), { topics }),
    );
    const g = (block!.data as { groups: { items: { title: string }[] }[] }).groups[0]!;
    expect(g.items.map((i) => i.title)).toEqual(['REL_19_0']);
  });
});

describe('news — merge груп за (scope, topic) (кілька джерел -> одна тема)', () => {
  it('newsdata-рядок + rss-рядок з однаковою (scope,topic) -> ОДИН Group з обʼєднаними items', async () => {
    const topics = [
      { scope: 'world', topic: 'Наука', category: 'science', language: 'en' },
      {
        scope: 'world',
        topic: 'Наука',
        source: 'rss',
        url: 'https://bbc.example/science',
        language: 'en',
      },
    ];
    const fetchSpy = vi.fn(async (u: unknown) => {
      const url = String(u);
      if (url.includes('bbc.example')) {
        return new Response(
          `<rss><channel><item><title>BBC Science</title><link>https://bbc.example/1</link></item></channel></rss>`,
          { status: 200 },
        );
      }
      return resp([{ title: 'NewsData Science', link: 'https://newsdata.example/1' }]);
    });
    const block = await mod(fetchSpy).run(makeCtx(memState(), { topics }));
    const groups = (
      block!.data as { groups: { scope: string; topic: string; items: { title: string }[] }[] }
    ).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe('world');
    expect(groups[0]!.topic).toBe('Наука');
    expect(groups[0]!.items.map((i) => i.title).sort()).toEqual(
      ['BBC Science', 'NewsData Science'].sort(),
    );
  });

  it('різні теми лишаються окремими групами (немає надмірного мерджу)', async () => {
    const topics = [
      { scope: 'ua', topic: 'Політика', category: 'politics', country: 'ua', language: 'uk' },
      { scope: 'ua', topic: 'Економіка', category: 'business', country: 'ua', language: 'uk' },
    ];
    // Різні URL на тему — інакше однакові URL зі спільного фікстура-сампла
    // законно з'їв би crossтемний дедуп (runSeen), і тест перевіряв би не те.
    const fetchSpy = vi.fn(async (u: unknown) => {
      const isPolitics = String(u).includes('category=politics');
      return resp([
        {
          title: isPolitics ? 'Новина політики' : 'Новина економіки',
          link: isPolitics
            ? 'https://feed.example.com/politics'
            : 'https://feed.example.com/business',
        },
      ]);
    });
    const block = await mod(fetchSpy).run(makeCtx(memState(), { topics }));
    const groups = (block!.data as { groups: { topic: string }[] }).groups;
    expect(groups.map((g) => g.topic).sort()).toEqual(['Економіка', 'Політика']);
  });

  it('айтеми злитої групи відсортовані за publishedAt — найновіші перші, не порядок фетчу', async () => {
    const topics = [
      {
        scope: 'world',
        topic: 'Релізи',
        source: 'rss',
        url: 'https://repo-a.example/releases.atom',
        language: 'en',
      },
      {
        scope: 'world',
        topic: 'Релізи',
        source: 'rss',
        url: 'https://repo-b.example/releases.atom',
        language: 'en',
      },
    ];
    // Перший рядок конфіга (repo-a) віддає СТАРІШУ дату, ніж другий (repo-b) —
    // без сортування repo-a лишився б items[0] лише через порядок фетчу.
    const fetchSpy = vi.fn(async (u: unknown) => {
      const isA = String(u).includes('repo-a');
      return new Response(
        `<feed><entry><title>${isA ? 'Стара' : 'Свіжа'}</title><link href="https://x.example/${isA ? 'old' : 'new'}"/><updated>${isA ? '2026-01-01T00:00:00Z' : '2026-07-20T00:00:00Z'}</updated></entry></feed>`,
        { status: 200 },
      );
    });
    const block = await mod(fetchSpy).run(makeCtx(memState(), { topics }));
    const groups = (block!.data as { groups: { items: { title: string }[] }[] }).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.title)).toEqual(['Свіжа', 'Стара']);
  });
});

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

describe('news — недільний decay ваг: рівно раз на добу', () => {
  const run = (state: Parameters<typeof makeCtx>[0], sunday: boolean) =>
    mod(vi.fn(async () => resp(sample))).run(makeCtx(state, { sunday }));

  it('у неділю decay застосовується — і ставить мітку дня', async () => {
    const state = memState({ preferenceWeights: { Тех: 0.5 } });
    await run(state, true);
    expect((state.get('preferenceWeights') as Record<string, number>).Тех).toBeCloseTo(0.55);
    expect(state.get('lastDecayDate')).toBe('2026-07-01');
  });

  it('ТРИ force-рани в ту саму неділю -> decay РІВНО один раз', async () => {
    // Регресія. isSunday() — чиста функція годинника, без памʼяті, тож кожен ран
    // декаїв наново: 0.5 → 0.55 → 0.595 → 0.6355. А workflow_dispatch із force
    // саме для повторних ранів і існує — тобто вподобання розмивались утричі
    // швидше, ніж «раз на тиждень» за задумом.
    const state = memState({ preferenceWeights: { Тех: 0.5 } });
    await run(state, true);
    await run(state, true);
    await run(state, true);
    expect((state.get('preferenceWeights') as Record<string, number>).Тех).toBeCloseTo(0.55);
  });

  it('не в неділю decay не чіпає ваги й не ставить мітку', async () => {
    const state = memState({ preferenceWeights: { Тех: 0.5 } });
    await run(state, false);
    expect((state.get('preferenceWeights') as Record<string, number>).Тех).toBeCloseTo(0.5);
    expect(state.get('lastDecayDate')).toBeUndefined();
  });

  it('наступної неділі мітка інша -> decay знову застосується', async () => {
    // Мітка не має «замкнути» decay назавжди.
    const state = memState({ preferenceWeights: { Тех: 0.5 }, lastDecayDate: '2026-06-24' });
    await run(state, true);
    expect((state.get('preferenceWeights') as Record<string, number>).Тех).toBeCloseTo(0.55);
    expect(state.get('lastDecayDate')).toBe('2026-07-01');
  });
});
