import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sourceEvidence,
  prepareContent,
  validatePreparedBatch,
  contentResponse,
  calendarContent,
  type ContentBatch,
} from '../src/core/content-preparation.js';
import {
  CONTENT_AUTHORS,
  CONTENT_TOPICS,
  contentSourceAllowed,
  contentExcluded,
  contentRepeats,
  diverseContent,
  publicContent,
} from '../web/core/brief/daily-content.mjs';
import { publishedContent, handleDailyContent } from '../web/api-daily-content.mjs';
import { nextContentMonth, main as prepareMonthly } from '../scripts/prepare-daily-content.mts';
import { preparedDailyContent } from '../src/core/daily-content.js';
import { memState } from './helpers/state.js';
import { buildInitData } from './helpers/init-data.js';
import { workerEnv } from './helpers/env.js';
import type { Ctx } from '../src/core/types.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function candidates() {
  const common = (i: number) => ({
    id: `2026-11-item-${i}`,
    semanticKey: `distinct-idea-${i}`,
    topic: Object.keys(CONTENT_TOPICS)[i % 7]!,
    title: `Відкриття номер ${i}`,
    context: 'Перевірений контекст, який пояснює конкретну думку.',
    sourceName: 'NASA',
    sourceUrl: `https://www.nasa.gov/source-${i}`,
    evidence: `Source passage provides detailed verified claim number ${i}.`,
  });
  return {
    facts: Array.from({ length: 38 }, (_, i) => ({
      ...common(i),
      fact: Array.from({ length: 12 }, (_, k) => `відомість${i}слово${k}`).join(' '),
    })),
    quotes: Array.from({ length: 38 }, (_, index) => {
      const i = index + 100,
        authors = Object.keys(CONTENT_AUTHORS);
      return {
        ...common(i),
        sourceUrl: `https://classics.mit.edu/source-${i}`,
        author: index % 4 < 3 ? authors[index % 3]! : authors[3 + (index % 6)]!,
        text: Array.from({ length: 12 }, (_, k) => `думка${i}слово${k}`).join(' '),
        reference: `Книга ${index}`,
        translation: 'Український переклад' as const,
      };
    }),
  };
}
function batch(): ContentBatch {
  const c = candidates();
  return {
    version: 1,
    month: '2026-11',
    generatedAt: '2026-10-28T07:00:00Z',
    facts: c.facts.map((n) => ({ ...n, verifiedAt: '2026-10-28' })),
    quotes: c.quotes.map((n) => ({ ...n, verifiedAt: '2026-10-28' })),
  } as ContentBatch;
}
describe('monthly editorial preparation', () => {
  it('validates whole calendar months, diversity, Stoic foundation and non-Russian content', () => {
    expect(() => validatePreparedBatch(batch())).not.toThrow();
    const short = { ...batch(), month: '2026-10', facts: batch().facts.slice(0, 30) };
    expect(() => validatePreparedBatch(short)).toThrow('whole month');
    const bad = batch();
    bad.quotes[0]!.author = 'Лев Толстой';
    expect(() => validatePreparedBatch(bad)).toThrow();
    const linked = batch();
    linked.facts[0]!.context = 'Досягнення радянської науки.';
    expect(() => validatePreparedBatch(linked)).toThrow('Excluded');
  });
  it('prevents renamed IDs, repeated book passages and closely paraphrased facts', () => {
    expect(
      contentRepeats(
        { id: 'a', semanticKey: 'octopus-three-hearts', fact: 'one' },
        { id: 'b', semanticKey: 'Octopus three hearts', fact: 'two' },
      ),
    ).toBe(true);
    expect(
      contentRepeats(
        { author: 'Сенека', reference: 'Лист 1', text: 'a' },
        { author: 'Сенека', reference: 'Лист 1', text: 'b' },
      ),
    ).toBe(true);
    expect(
      contentRepeats(
        { fact: 'У восьминога існує три окремих серця для циркуляції крові' },
        { fact: 'Восьминога існує три окремих серця для циркуляції крові' },
      ),
    ).toBe(true);
    expect(contentExcluded({ author: 'Достоєвський' })).toBe(true);
    expect(contentExcluded({ fact: 'Russia-related discovery' })).toBe(true);
  });
  it('moves excess quotes from one author into reserve while preserving a full balanced calendar', () => {
    const quotes = batch().quotes;
    quotes.forEach((n, i) => {
      n.author = i < 20 ? 'Марк Аврелій' : i < 30 ? 'Епіктет' : 'Генрі Девід Торо';
    });
    const ordered = calendarContent(quotes, 'quote', '2026-10', {});
    expect(ordered).toHaveLength(38);
    expect(
      ordered.slice(0, 31).filter((n) => n.author === 'Марк Аврелій').length,
    ).toBeLessThanOrEqual(13);
    expect(
      ordered.slice(0, 31).filter((n) => CONTENT_AUTHORS[n.author as keyof typeof CONTENT_AUTHORS])
        .length,
    ).toBeGreaterThanOrEqual(19);
  });
  it('does not allow SSRF URLs or redirects outside reviewed primary source domains', async () => {
    for (const url of [
      'http://www.nasa.gov/a',
      'https://nasa.gov.evil.test/a',
      'https://x@nasa.gov/a',
      'https://nasa.gov:4430/a',
      'https://127.0.0.1/a',
      'https://ru.wikisource.org/a',
    ])
      expect(contentSourceAllowed(url)).toBe(false);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
      );
    await expect(sourceEvidence('https://www.nasa.gov/a', fetchFn)).rejects.toThrow('allowlist');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized source bodies and HTML navigation cannot masquerade as evidence', async () => {
    const large = vi
      .fn()
      .mockResolvedValue(
        new Response('x'.repeat(800001), { headers: { 'content-type': 'text/html' } }),
      );
    await expect(sourceEvidence('https://www.nasa.gov/a', large)).rejects.toThrow('large');
    const source = vi.fn().mockResolvedValue(
      new Response('<nav>fabricated evidence</nav><p>Source &amp; truth</p>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(await sourceEvidence('https://www.nasa.gov/a', source)).toBe('Source & truth');
  });
  it('uses one candidate call and one independent review; unverified candidates cannot enter the queue', async () => {
    const c = candidates();
    const respond = vi
      .fn()
      .mockResolvedValueOnce(c)
      .mockResolvedValueOnce({
        approved: [...c.facts, ...c.quotes].map((n) => n.id),
        rejected: [],
      });
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const n = [...c.facts, ...c.quotes].find((item) => item.sourceUrl === String(url))!;
      return new Response(n.evidence, { headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;
    const ready = await prepareContent({
      month: '2026-11',
      apiKey: 'test',
      model: 'test',
      previous: [],
      preferences: { topics: Object.keys(CONTENT_TOPICS) },
      now: '2026-10-28T07:00:00Z',
      respond,
      fetchFn,
    });
    expect(ready.facts).toHaveLength(38);
    expect(ready.quotes).toHaveLength(38);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]![0].prompt).toContain('actual fetched passages');
    const absent = vi.fn().mockResolvedValue(
      new Response('The actual page does not substantiate the proposed evidence.', {
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const dishonest = vi
      .fn()
      .mockResolvedValueOnce(c)
      .mockResolvedValueOnce({
        approved: [...c.facts, ...c.quotes].map((n) => n.id),
        rejected: [],
      });
    await expect(
      prepareContent({
        month: '2026-11',
        apiKey: 'test',
        model: 'test',
        previous: [],
        preferences: {},
        now: '2026-10-28T07:00:00Z',
        respond: dishonest,
        fetchFn: absent,
      }),
    ).rejects.toThrow();
  });
  it('rejects invalid peers and resumes a saved candidate packet without repeating the paid search', async () => {
    const c = candidates();
    const saved = {
      ...c,
      quotes: [...c.quotes, { ...c.quotes[0], id: 'invalid-peer', evidence: 'short' }],
    };
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const respond = vi
      .fn()
      .mockResolvedValue({ approved: [...c.facts, ...c.quotes].map((n) => n.id), rejected: [] });
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const n = [...c.facts, ...c.quotes].find((item) => item.sourceUrl === String(url))!;
      return new Response(n.evidence, { headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;
    const ready = await prepareContent({
      month: '2026-11',
      apiKey: 'test',
      model: 'test',
      previous: [],
      preferences: {},
      now: '2026-10-28T07:00:00Z',
      candidates: saved,
      checkpoint,
      respond,
      fetchFn,
    });
    expect(ready.quotes).toHaveLength(38);
    expect(ready.quotes.some((n) => n.id === 'invalid-peer')).toBe(false);
    expect(checkpoint).toHaveBeenCalledWith(saved);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]![0].search).toBeUndefined();
  });
  it('repairs a saved partial packet from fetched sources once, then independently reviews it', async () => {
    const c = candidates();
    const partial = { facts: c.facts.slice(0, 31), quotes: c.quotes.slice(0, 28) };
    const repair = {
      facts: c.facts.slice(0, 12).map((n, i) => ({
        ...n,
        id: `repair-fact-${i}`,
        semanticKey: `repair-discovery-${i}`,
        fact: Array.from({ length: 12 }, (_, k) => `доповнення${i}відомість${k}`).join(' '),
        evidence: `Additional original factual passage number ${i}.`,
      })),
      quotes: c.quotes.slice(0, 12).map((n, i) => ({
        ...n,
        id: `repair-quote-${i}`,
        semanticKey: `repair-thought-${i}`,
        reference: `Книга доповнення ${i}`,
        text: Array.from({ length: 12 }, (_, k) => `доповнення${i}думка${k}`).join(' '),
        evidence: `Additional original philosophical passage number ${i}.`,
      })),
    };
    const all = [...partial.facts, ...partial.quotes, ...repair.facts, ...repair.quotes];
    const fetchFn = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          all
            .filter((n) => n.sourceUrl === String(url))
            .map((n) => n.evidence)
            .join(' '),
          { headers: { 'content-type': 'text/plain' } },
        ),
    ) as unknown as typeof fetch;
    const respond = vi
      .fn()
      .mockResolvedValueOnce(repair)
      .mockResolvedValueOnce({ approved: all.map((n) => n.id), rejected: [] });
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const input = {
      month: '2026-10',
      apiKey: 'test',
      model: 'test',
      previous: [],
      preferences: {},
      now: '2026-10-10T07:00:00Z',
      candidates: partial,
      respond,
      fetchFn,
      checkpoint,
    };
    const ready = await prepareContent(input);
    expect(ready.facts).toHaveLength(42);
    expect(ready.quotes).toHaveLength(40);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls.every((call) => !call[0].search)).toBe(true);
    const saved = checkpoint.mock.calls.at(-1)![0];
    expect(saved.repaired).toBe(true);
    const review = vi.fn().mockResolvedValue({ approved: all.map((n) => n.id), rejected: [] });
    await prepareContent({ ...input, candidates: saved, respond: review });
    expect(review).toHaveBeenCalledTimes(1);
  });
  it('bounds provider tools/tokens and does not publish incomplete model responses', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete' })));
    await expect(
      contentResponse({
        apiKey: 'not-real',
        model: 'test',
        prompt: 'test',
        schema: (await import('../web/core/brief/daily-content.mjs')).candidatesSchema,
        search: true,
        fetchFn,
      }),
    ).rejects.toThrow('incomplete');
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.max_tool_calls).toBe(8);
    expect(body.max_output_tokens).toBe(24000);
    expect(body.store).toBe(false);
    expect(JSON.stringify(body.text.format.schema)).not.toContain('"format":"uri"');
    expect(JSON.stringify(body.text.format.schema)).not.toContain('minLength');
    expect(JSON.stringify(body.text.format.schema)).not.toContain('maxLength');
    expect(body.text.format.schema.properties.facts.items.properties.sourceUrl.type).toBe('string');
  });
  it('targets the next month including December and Kyiv date boundaries; preferences change order, never existing slots', () => {
    expect(nextContentMonth(new Date('2026-12-31T23:00:00Z'))).toBe('2027-02');
    expect(nextContentMonth(new Date('2026-10-28T07:00:00Z'))).toBe('2026-11');
    const state = memState(),
      prepared = batch();
    const ctx = {
      clock: { todayKey: () => '2026-11-02' },
      state,
      bus: { get: () => prepared },
    } as unknown as Ctx;
    const item = preparedDailyContent(ctx, 'fact');
    expect(item?.id).toBe(prepared.facts[1]!.id);
    expect(item).not.toHaveProperty('evidence');
    expect(preparedDailyContent(ctx, 'fact')).toEqual(item);
    expect(state.get<unknown[]>('dailyContentHistory:facts')).toHaveLength(1);
    expect(diverseContent(prepared.facts, { topics: ['nature'] })).toHaveLength(38);
    expect(publicContent(prepared.facts[0]!)).not.toHaveProperty('semanticKey');
  });
  it('starts a mid-month bootstrap on its actual first unpublished day and resumes the exact review without paying again', async () => {
    const c = candidates();
    const partial = { facts: c.facts.slice(0, 25), quotes: c.quotes.slice(0, 25) };
    const fetchFn = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          [...partial.facts, ...partial.quotes].find((n) => n.sourceUrl === String(url))
            ?.evidence ?? '',
          { headers: { 'content-type': 'text/plain' } },
        ),
    ) as unknown as typeof fetch;
    const respond = vi.fn().mockResolvedValue({
      approved: [...partial.facts, ...partial.quotes].map((n) => n.id),
      rejected: [],
    });
    const reviewCheckpoint = vi.fn().mockResolvedValue(undefined);
    const input = {
      month: '2026-10',
      startDay: 11,
      apiKey: 'test',
      model: 'test',
      previous: [],
      preferences: {},
      now: '2026-10-10T07:00:00Z',
      candidates: partial,
      respond,
      fetchFn,
      reviewCheckpoint,
    };
    const ready = await prepareContent(input);
    expect(ready.startDay).toBe(11);
    const state = memState();
    const ctx = {
      clock: { todayKey: () => '2026-10-10' },
      state,
      bus: { get: () => ready },
    } as unknown as Ctx;
    expect(preparedDailyContent(ctx, 'fact')).toBeNull();
    ctx.clock.todayKey = () => '2026-10-11';
    expect(preparedDailyContent(ctx, 'fact')?.id).toBe(ready.facts[0]!.id);
    ctx.clock.todayKey = () => '2026-10-31';
    expect(preparedDailyContent(ctx, 'fact')?.id).toBe(ready.facts[20]!.id);
    const noProvider = vi.fn().mockRejectedValue(new Error('must not pay again'));
    await prepareContent({
      ...input,
      respond: noProvider,
      reviewed: reviewCheckpoint.mock.calls[0]![0],
    });
    expect(noProvider).not.toHaveBeenCalled();
    await expect(
      prepareContent({
        ...input,
        respond: noProvider,
        reviewed: { signature: 'wrong', review: { approved: [], rejected: [] } },
      }),
    ).rejects.toThrow('must not pay again');
  });
  it('repeated scheduler runs and paid attempt exhaustion make no provider calls; resumes a verified staging write without regeneration', async () => {
    for (const key of ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'KV_NAMESPACE_ID', 'OPENAI_API_KEY'])
      vi.stubEnv(key, 'test');
    vi.stubEnv('CONTENT_MONTH', '2026-11');
    const values = new Map<string, unknown>([['dailyContent:batch:2026-11', batch()]]);
    const f = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      expect(String(url)).not.toContain('api.openai.com');
      const key = decodeURIComponent(String(url).split('/values/')[1] ?? '');
      if (options?.method === 'PUT') {
        values.set(key, JSON.parse(String(options.body)));
        return new Response('{}');
      }
      return values.has(key)
        ? new Response(JSON.stringify(values.get(key)))
        : new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', f);
    await prepareMonthly();
    expect(f).toHaveBeenCalledTimes(1);
    values.delete('dailyContent:batch:2026-11');
    values.set('dailyContent:status:2026-11', { attempts: 3 });
    await expect(prepareMonthly()).rejects.toThrow('attempt cap');
    values.set('dailyContent:staging:2026-11', batch());
    await prepareMonthly();
    expect(values.get('dailyContent:batch:2026-11')).toEqual(batch());
    expect(values.get('dailyContent:ledger')).toHaveLength(76);
  });
  it('storage read failure cannot be mistaken for an empty ledger and never overwrites it', async () => {
    for (const key of ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'KV_NAMESPACE_ID', 'OPENAI_API_KEY'])
      vi.stubEnv(key, 'test');
    vi.stubEnv('CONTENT_MONTH', '2026-11');
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', f);
    await expect(prepareMonthly()).rejects.toThrow('storage read');
    expect(f.mock.calls.every((call) => call[1]?.method !== 'PUT')).toBe(true);
  });
});
describe('published archive and feedback boundary', () => {
  function brief(date: string) {
    return {
      generatedAt: `${date}T05:00:00Z`,
      blocks: [
        { id: 'fact', data: batch().facts[0] },
        { id: 'stoic', data: batch().quotes[0] },
      ],
    };
  }
  it('ignores malformed dates and excluded content, strips editorial-only evidence', () => {
    expect(publishedContent({ blocks: [], generatedAt: 'bad' })).toBeNull();
    expect(publishedContent(brief('2026-10-10'))?.fact).not.toHaveProperty('evidence');
    const b = brief('2026-10-10');
    b.blocks[1]!.data = {
      ...b.blocks[1]!.data,
      author: 'Лев Толстой',
    } as (typeof b.blocks)[1]['data'];
    expect(publishedContent(b)?.quote).toBeNull();
  });
  it('only owner can read, only primary owner can react; archive never returns future queue entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T09:00:00Z'));
    const values = new Map<string, unknown>([
      ['latest', brief('2026-10-10')],
      ['briefing:2026-10-09', brief('2026-10-09')],
      ['briefing:2026-10-11', brief('2026-10-11')],
      ['dailyContent:batch:2026-11', batch()],
    ]);
    const put = vi.fn(async (key: string, value: string) => {
      values.set(key, JSON.parse(value));
    });
    const env = workerEnv({
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_OWNER_USER_ID: '42',
      BRIEFING: {
        get: async (key: string) => values.get(key) ?? null,
        put,
        list: async () => ({
          keys: [...values.keys()]
            .filter((n) => n.startsWith('briefing:'))
            .map((name) => ({ name })),
        }),
      },
    });
    expect(
      (await handleDailyContent(new Request('https://svitanok.test/api/daily-content'), env))
        .status,
    ).toBe(401);
    const headers = {
      'X-Telegram-Init-Data': await buildInitData(42, 'test-token'),
      'Content-Type': 'application/json',
    };
    const archive = await handleDailyContent(
      new Request('https://svitanok.test/api/daily-content?archive=1', { headers }),
      env,
    );
    expect(
      ((await archive.json()) as { items: Array<{ date: string }> }).items.map((n) => n.date),
    ).toEqual(['2026-10-09']);
    expect(archive.headers.get('cache-control')).toContain('no-store');
    const invalid = {
      type: 'feedback',
      kind: 'fact',
      id: 'unpublished',
      date: '2026-11-01',
      signal: 'like',
    };
    expect(
      (
        await handleDailyContent(
          new Request('https://svitanok.test/api/daily-content', {
            method: 'POST',
            headers,
            body: JSON.stringify(invalid),
          }),
          env,
        )
      ).status,
    ).toBe(400);
    const valid = { ...invalid, id: batch().facts[0]!.id, date: '2026-10-10' };
    expect(
      (
        await handleDailyContent(
          new Request('https://svitanok.test/api/daily-content', {
            method: 'POST',
            headers,
            body: JSON.stringify(valid),
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
