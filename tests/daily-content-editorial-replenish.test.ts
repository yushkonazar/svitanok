import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareContent,
  type Candidate,
  type ContentBatch,
} from '../src/core/content-preparation.js';
import { main as prepareMonthly } from '../scripts/prepare-daily-content.mts';
import {
  CONTENT_AUTHORS,
  CONTENT_TOPICS,
  contentIdentity,
} from '../web/core/brief/daily-content.mjs';
import oldFacts from '../src/data/verified-facts.json' with { type: 'json' };
import oldQuotes from '../src/data/verified-stoic.json' with { type: 'json' };
import { octoberFacts, octoberQuotes } from '../src/data/content-october.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function items(offset: number, factCount: number, quoteCount: number) {
  const common = (id: number, quote: boolean) => ({
    id: `2026-11-editorial-${id}`,
    semanticKey: `unique-editorial-idea-${id}`,
    topic: Object.keys(CONTENT_TOPICS)[id % 7]!,
    title: `Перевірене відкриття ${id}`,
    context: 'Конкретний підтверджений контекст для цієї думки.',
    sourceName: quote ? 'MIT Classics' : 'NASA',
    sourceUrl: `https://${quote ? 'classics.mit.edu' : 'www.nasa.gov'}/editorial-${id}`,
    evidence: `Original independent source passage number ${id}.`,
  });
  return {
    facts: Array.from({ length: factCount }, (_, i) => ({
      ...common(offset + i, false),
      fact: Array.from({ length: 12 }, (_, k) => `відкриття${offset + i}значення${k}`).join(' '),
    })),
    quotes: Array.from({ length: quoteCount }, (_, i) => ({
      ...common(offset + 100 + i, true),
      author: Object.keys(CONTENT_AUTHORS)[i % 4 < 3 ? i % 3 : 3 + (i % 6)]!,
      reference: `Самостійний уривок ${offset + i}`,
      text: Array.from({ length: 12 }, (_, k) => `думка${offset + i}сутність${k}`).join(' '),
      translation: 'Український переклад' as const,
    })),
  };
}
const initial = () => items(0, 37, 35);
const flatten = (c: ReturnType<typeof items>) => [...c.facts, ...c.quotes] as Candidate[];
function sourceFetch(all: Candidate[]) {
  return vi.fn(async (url: string | URL | Request) => {
    const n = all.find((n) => n.sourceUrl === String(url));
    return n
      ? new Response(n.evidence, { headers: { 'content-type': 'text/plain' } })
      : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}
type ReviewCheckpoint = {
  signature: string;
  review: { approved: string[]; rejected: { id: string; reason: string }[] };
};
async function cachedReview(previous: Candidate[] = [], facts = 14, quotes = 3, startDay = 1) {
  const c = initial(),
    kept = [...c.facts.slice(0, facts), ...c.quotes.slice(0, quotes)].map((n) => n.id);
  let saved: ReviewCheckpoint | undefined;
  await expect(
    prepareContent({
      month: '2026-11',
      now: '2026-10-31T07:00:00Z',
      startDay,
      apiKey: 'synthetic',
      model: 'synthetic',
      preferences: {},
      previous,
      candidates: c,
      fetchFn: sourceFetch(flatten(c)),
      canReplenish: () => false,
      respond: vi.fn().mockResolvedValue({
        approved: kept,
        rejected: flatten(c)
          .filter((n) => !kept.includes(n.id))
          .map((n) => ({ id: n.id, reason: 'Потрібна інша, нова підтверджена думка.' })),
      }),
      reviewCheckpoint: async (value) => {
        saved = value as ReviewCheckpoint;
      },
    }),
  ).rejects.toThrow('Insufficient verified content');
  return saved!;
}
async function fixture() {
  const c = initial(),
    extra = items(1000, 20, 31),
    reviewed = await cachedReview();
  const snapshots: unknown[] = [],
    reviews: ReviewCheckpoint[] = [];
  const input = {
    month: '2026-11',
    now: '2026-10-31T07:00:00Z',
    apiKey: 'synthetic',
    model: 'synthetic',
    previous: [] as Candidate[],
    preferences: {},
    candidates: c,
    reviewed,
    fetchFn: sourceFetch([...flatten(c), ...flatten(extra)]),
    checkpoint: async (value: unknown) => {
      snapshots.push(value);
    },
    reviewCheckpoint: async (value: unknown) => {
      reviews.push(value as ReviewCheckpoint);
    },
  };
  return { c, extra, input, snapshots, reviews };
}
const approvedExtra = (extra: ReturnType<typeof items>) => ({
  approved: flatten(extra).map((n) => n.id),
  rejected: [],
});

describe('replenishment after independent editorial verification', () => {
  it('requests only quotes when the previously observed 33/28 result is short', async () => {
    const s = await fixture(),
      extra = items(1000, 0, 6);
    const respond = vi
      .fn()
      .mockResolvedValueOnce(extra)
      .mockResolvedValueOnce(approvedExtra(extra));
    const result = await prepareContent({
      ...s.input,
      reviewed: await cachedReview([], 33, 28),
      respond,
    });
    expect(result.facts).toHaveLength(33);
    expect(result.quotes).toHaveLength(34);
    expect(respond.mock.calls[0]![0].prompt).toContain('exactly 0 new facts and 6 new quotations');
    expect(respond).toHaveBeenCalledTimes(2);
  });
  it('fills the actual 14/3 shortfall, keeps approvals and reviews only new candidates', async () => {
    const s = await fixture();
    const respond = vi
      .fn()
      .mockResolvedValueOnce(s.extra)
      .mockResolvedValueOnce({
        ...approvedExtra(s.extra),
        // A new review cannot retract an unchanged, already approved peer.
        rejected: [{ id: s.c.facts[0]!.id, reason: 'Чужий ідентифікатор.' }],
      });
    const result = await prepareContent({ ...s.input, respond });
    expect(result.facts).toHaveLength(34);
    expect(result.quotes).toHaveLength(34);
    expect(result.facts.map((n) => n.id)).toEqual(
      expect.arrayContaining(s.c.facts.slice(0, 14).map((n) => n.id)),
    );
    expect(result.quotes.map((n) => n.id)).toEqual(
      expect.arrayContaining(s.c.quotes.slice(0, 3).map((n) => n.id)),
    );
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[0]![0]).toMatchObject({ search: true });
    expect(respond.mock.calls[0]![0].schema.parse(s.extra)).toEqual(s.extra);
    expect(respond.mock.calls[0]![0].prompt).toContain(
      'exactly 20 new facts and 31 new quotations',
    );
    const pending = JSON.parse(
      respond.mock.calls[1]![0].prompt.split('Candidates with actual fetched passages: ')[1].split(
        '. Return approved',
      )[0],
    );
    expect(pending).toHaveLength(51);
    expect(
      pending.every(
        (n: { item: Candidate }) => !s.input.reviewed.review.approved.includes(n.item.id),
      ),
    ).toBe(true);
    expect(
      result.facts.some((n) => s.input.reviewed.review.rejected.some((r) => r.id === n.id)),
    ).toBe(false);
  });
  it('resumes a saved generation after review failure without another search', async () => {
    const s = await fixture();
    const respond = vi
      .fn()
      .mockResolvedValueOnce(s.extra)
      .mockRejectedValueOnce(new Error('synthetic review timeout'));
    await expect(prepareContent({ ...s.input, respond })).rejects.toThrow(
      'synthetic review timeout',
    );
    const packet = s.snapshots.at(-1);
    expect(packet).toHaveProperty('editorialRepair.signature');
    const review = vi.fn().mockResolvedValue(approvedExtra(s.extra));
    expect(
      (await prepareContent({ ...s.input, candidates: packet, respond: review })).quotes,
    ).toHaveLength(34);
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0].search).toBeUndefined();
    const noProvider = vi.fn().mockRejectedValue(new Error('must reuse saved review'));
    await prepareContent({
      ...s.input,
      candidates: packet,
      reviewed: s.reviews.at(-1),
      respond: noProvider,
    });
    expect(noProvider).not.toHaveBeenCalled();
  });
  it('bounds the attempt across reruns and never publishes an insufficient second review', async () => {
    const s = await fixture();
    const respond = vi
      .fn()
      .mockResolvedValueOnce(s.extra)
      .mockResolvedValueOnce({
        approved: [],
        rejected: flatten(s.extra).map((n) => ({ id: n.id, reason: 'Не підтверджено.' })),
      });
    await expect(prepareContent({ ...s.input, respond })).rejects.toThrow(
      'Insufficient verified content',
    );
    expect(respond).toHaveBeenCalledTimes(2);
    const noProvider = vi.fn().mockRejectedValue(new Error('must not repeat replenishment'));
    await expect(
      prepareContent({
        ...s.input,
        candidates: s.snapshots.at(-1),
        reviewed: s.reviews.at(-1),
        respond: noProvider,
      }),
    ).rejects.toThrow('Insufficient verified content');
    expect(noProvider).not.toHaveBeenCalled();
  });
  it('does not trust a base approval after the retained claim changes', async () => {
    const s = await fixture();
    await expect(
      prepareContent({
        ...s.input,
        respond: vi.fn().mockResolvedValueOnce(s.extra).mockRejectedValueOnce(new Error('pause')),
      }),
    ).rejects.toThrow('pause');
    const packet = structuredClone(s.snapshots.at(-1)) as { facts: Candidate[] };
    packet.facts[0]!.context = 'Змінене твердження, яке ще не перевіряли.';
    const review = vi.fn().mockResolvedValue(approvedExtra(s.extra));
    await expect(
      prepareContent({ ...s.input, candidates: packet, respond: review }),
    ).rejects.toThrow('Insufficient verified content');
    const pending = JSON.parse(
      review.mock.calls[0]![0].prompt.split('Candidates with actual fetched passages: ')[1].split(
        '. Return approved',
      )[0],
    );
    expect(pending.some((n: { item: Candidate }) => n.item.id === packet.facts[0]!.id)).toBe(true);
  });
});

function legacy(previous: Candidate[]) {
  return [
    ...[...oldFacts, ...octoberFacts].map((n) => ({ ...n, id: contentIdentity(n, 'fact') })),
    ...[...oldQuotes, ...octoberQuotes].map((n) => ({ ...n, id: contentIdentity(n, 'quote') })),
    ...previous,
  ] as Candidate[];
}
function monthlyStorage(values: Map<string, unknown>, responses: unknown[], sources: Candidate[]) {
  const calls: Record<string, unknown>[] = [];
  let unavailable = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('api.openai.com')) {
        calls.push(JSON.parse(String(init?.body)));
        const next = responses.shift();
        if (!next) throw new Error('unexpected paid call');
        return Response.json({
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(next) }] }],
        });
      }
      if (path.includes('/keys?')) return Response.json({ result: [] });
      if (path.includes('api.cloudflare.com')) {
        const key = decodeURIComponent(path.split('/values/')[1]!);
        if (init?.method === 'PUT') {
          values.set(key, JSON.parse(String(init.body)));
          return Response.json({});
        }
        return values.has(key) ? Response.json(values.get(key)) : new Response('', { status: 404 });
      }
      const item = sources.find((n) => n.sourceUrl === path);
      return item && !(unavailable && Number(item.id.split('-').at(-1)) >= 1000)
        ? new Response(item.evidence, { headers: { 'content-type': 'text/plain' } })
        : new Response('', { status: 503 });
    }),
  );
  return {
    calls,
    unavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}
function monthlyEnvironment(date = '2026-10-31T07:00:00Z') {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(date));
  for (const name of ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'KV_NAMESPACE_ID', 'OPENAI_API_KEY'])
    vi.stubEnv(name, 'synthetic');
  vi.stubEnv('CONTENT_MONTH', '2026-11');
}
describe('monthly checkpoints and cumulative budget', () => {
  it('uses only the remaining two calls and preserves the previous ledger and other month', async () => {
    monthlyEnvironment();
    const c = initial(),
      extra = items(1000, 20, 31),
      oldLedger = flatten(items(9000, 1, 0));
    const values = new Map<string, unknown>([
      ['dailyContent:ledger', oldLedger],
      ['dailyContent:batch:2026-10', { old: 'preserved' }],
      ['dailyContent:candidates:2026-11', c],
      ['dailyContent:review:2026-11', await cachedReview(legacy(oldLedger))],
      ['dailyContent:status:2026-11', { attempts: 8, paidCalls: 4, searchCalls: 1 }],
    ]);
    const store = monthlyStorage(
      values,
      [extra, approvedExtra(extra)],
      [...flatten(c), ...flatten(extra)],
    );
    await prepareMonthly();
    expect(store.calls).toHaveLength(2);
    expect(values.get('dailyContent:status:2026-11')).toMatchObject({
      state: 'ready',
      paidCalls: 6,
      searchCalls: 2,
      facts: 34,
      quotes: 34,
    });
    expect(values.get('dailyContent:ledger')).toEqual(expect.arrayContaining(oldLedger));
    expect(values.get('dailyContent:batch:2026-10')).toEqual({ old: 'preserved' });
  });
  it.each([
    { paidCalls: 5, searchCalls: 1 },
    { paidCalls: 4, searchCalls: 3 },
  ])('does not start a pair of calls beyond the remaining budget %j', async (budget) => {
    monthlyEnvironment();
    const c = initial();
    const values = new Map<string, unknown>([
      ['dailyContent:ledger', []],
      ['dailyContent:candidates:2026-11', c],
      ['dailyContent:review:2026-11', await cachedReview(legacy([]))],
      ['dailyContent:status:2026-11', { attempts: 8, ...budget }],
    ]);
    const store = monthlyStorage(values, [], flatten(c));
    await expect(prepareMonthly()).rejects.toThrow('Insufficient verified content');
    expect(store.calls).toHaveLength(0);
    expect(values.get('dailyContent:status:2026-11')).toMatchObject({
      state: 'reserve',
      ...budget,
    });
    expect(values.has('dailyContent:batch:2026-11')).toBe(false);
    expect(values.get('dailyContent:ledger')).toEqual([]);
  });
  it('resumes a short remaining-month packet after sources recover, without replacing its paid generation', async () => {
    monthlyEnvironment('2026-11-25T07:00:00Z');
    const c = initial(),
      extra = items(1000, 6, 8);
    const values = new Map<string, unknown>([
      ['dailyContent:ledger', []],
      ['dailyContent:candidates:2026-11', c],
      ['dailyContent:review:2026-11', await cachedReview(legacy([]), 3, 1, 26)],
      ['dailyContent:status:2026-11', { attempts: 8, paidCalls: 4, searchCalls: 1 }],
    ]);
    const store = monthlyStorage(
      values,
      [extra, approvedExtra(extra)],
      [...flatten(c), ...flatten(extra)],
    );
    store.unavailable(true);
    await expect(prepareMonthly()).rejects.toThrow('Insufficient fetched source evidence');
    expect(store.calls).toHaveLength(1);
    expect(values.get('dailyContent:candidates:2026-11')).toHaveProperty('editorialRepair');
    expect(values.get('dailyContent:status:2026-11')).toMatchObject({
      state: 'reserve',
      paidCalls: 5,
    });
    store.unavailable(false);
    await prepareMonthly();
    expect(store.calls).toHaveLength(2);
    const ready = values.get('dailyContent:batch:2026-11') as ContentBatch;
    expect(ready).toMatchObject({ startDay: 26 });
    expect(ready.facts.length).toBeLessThan(30);
    expect(values.get('dailyContent:status:2026-11')).toMatchObject({
      state: 'ready',
      paidCalls: 6,
      searchCalls: 2,
      calendarDays: 5,
    });
  });
});
