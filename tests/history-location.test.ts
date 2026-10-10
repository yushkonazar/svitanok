import { describe, it, expect, vi } from 'vitest';
import { enrichHistoricLocations } from '../src/modules/history-location.js';
import { parseEvents, createOnThisDayModule } from '../src/modules/onthisday.js';
import { memState } from './helpers/state.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

const now = Date.parse('2026-10-10T12:00:00Z');
const claim = (value: unknown, rank = 'normal') => ({
  rank,
  mainsnak: { snaktype: 'value', datavalue: { value } },
});
const point = (
  latitude = 35.689444,
  longitude = 139.691667,
  globe = 'http://www.wikidata.org/entity/Q2',
) => claim({ latitude, longitude, globe });
const event = {
  year: 1964,
  text: 'у Токіо почалися XVIII Олімпійські ігри.',
  pages: [
    { title: 'Токіо', wikibase_item: 'Q1490' },
    { title: 'Літні_Олімпійські_ігри_1964', wikibase_item: 'Q8420' },
  ],
};
const entity = (id: string, label: string, claims: Record<string, unknown>) => ({
  id,
  labels: { uk: { value: label } },
  claims,
});
const fixtures = () => ({
  Q1490: entity('Q1490', 'Токіо', { P625: [point()] }),
  Q8420: entity('Q8420', 'Літні Олімпійські ігри 1964', {
    P276: [claim({ id: 'Q1490' }, 'preferred'), claim({ id: 'Q330033' })],
    P580: [claim({ time: '+1964-10-10T00:00:00Z' })],
  }),
});
function options(entities: Record<string, unknown>) {
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe('https://www.wikidata.org/w/api.php');
    return new Response(
      JSON.stringify({
        entities: Object.fromEntries(
          (u.searchParams.get('ids') ?? '')
            .split('|')
            .map((id) => [id, entities[id] ?? { id, missing: '' }]),
        ),
      }),
    );
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    state: memState(),
    log: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    signal: new AbortController().signal,
    now,
  };
}
describe('historical event locations', () => {
  it('resolves Tokyo from the actual Olympics relationship, honoring preferred rank and caching metadata', async () => {
    const raw = { events: [event] },
      o = options(fixtures());
    const result = await enrichHistoricLocations(parseEvents(raw), raw, o);
    expect(result[0]?.location).toEqual({
      lat: 35.689444,
      lon: 139.691667,
      label: 'Токіо',
      sourceUrl: 'https://www.wikidata.org/wiki/Q1490',
      kind: 'event_place',
    });
    expect(result[0]?.url).toBe(
      'https://uk.wikipedia.org/wiki/%D0%9B%D1%96%D1%82%D0%BD%D1%96_%D0%9E%D0%BB%D1%96%D0%BC%D0%BF%D1%96%D0%B9%D1%81%D1%8C%D0%BA%D1%96_%D1%96%D0%B3%D1%80%D0%B8_1964',
    );
    expect(o.fetchImpl).toHaveBeenCalledTimes(1);
    await enrichHistoricLocations(parseEvents(raw), raw, o);
    expect(o.fetchImpl).toHaveBeenCalledTimes(1);
    await enrichHistoricLocations(parseEvents(raw), raw, { ...o, now: now + 31 * 86400000 });
    expect(o.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('fetches a linked venue not included among feed pages in one bounded second batch', async () => {
    const raw = { events: [{ ...event, pages: [event.pages[1]] }] },
      o = options(fixtures());
    expect((await enrichHistoricLocations(parseEvents(raw), raw, o))[0]?.location?.kind).toBe(
      'event_place',
    );
    expect(o.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('does not invent a unique event venue from conflicting explicit venues', async () => {
    const data = fixtures();
    data.Q8420.claims.P276 = [claim({ id: 'Q1490' }), claim({ id: 'Q330033' })];
    const raw = { events: [event] },
      o = options(data);
    expect((await enrichHistoricLocations(parseEvents(raw), raw, o))[0]?.location).toBeUndefined();
  });
  it('labels a single linked article coordinate as associated, not an exact venue; ignores mismatched event dates', async () => {
    const data = fixtures();
    data.Q8420.claims.P580 = [claim({ time: '+2000-10-10T00:00:00Z' })];
    const raw = { events: [event] },
      o = options(data);
    expect((await enrichHistoricLocations(parseEvents(raw), raw, o))[0]?.location?.kind).toBe(
      'associated_article',
    );
  });
  it('rejects non-Earth, deprecated, out-of-range and ambiguous coordinates while allowing zero', async () => {
    for (const coordinates of [
      [point(0, 0, 'http://www.wikidata.org/entity/Q405')],
      [{ ...point(), rank: 'deprecated' }],
      [point(91, 0)],
      [point(), point(40, 20)],
    ]) {
      const data = fixtures();
      data.Q1490.claims.P625 = coordinates;
      const raw = { events: [event] };
      expect(
        (await enrichHistoricLocations(parseEvents(raw), raw, options(data)))[0]?.location,
      ).toBeUndefined();
    }
    const data = fixtures();
    data.Q1490.claims.P625 = [point(0, 0)];
    const raw = { events: [event] };
    expect(
      (await enrichHistoricLocations(parseEvents(raw), raw, options(data)))[0]?.location,
    ).toMatchObject({ lat: 0, lon: 0 });
  });
  it('does not follow arbitrary page URLs or malformed entity IDs', async () => {
    const raw = {
      events: [
        {
          ...event,
          pages: [
            {
              title: 'Місце',
              wikibase_item: 'https://internal.test',
              content_urls: { desktop: { page: 'https://internal.test' } },
            },
          ],
        },
      ],
    };
    const o = options({});
    expect((await enrichHistoricLocations(parseEvents(raw), raw, o))[0]?.location).toBeUndefined();
    expect(o.fetchImpl).not.toHaveBeenCalled();
  });
  it('preserves descriptions and existing coordinates during metadata failure and retries without negative caching', async () => {
    const raw = { events: [event] },
      o = options(fixtures());
    const fail = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    const result = await enrichHistoricLocations(parseEvents(raw), raw, { ...o, fetchImpl: fail });
    expect(result[0]?.text).toBe(event.text);
    expect(o.state.get('onthisdayLocations:v1')).toBeUndefined();
    expect((await enrichHistoricLocations(result, raw, o))[0]?.location?.label).toBe('Токіо');
  });
  it('caches confirmed missing entities for one day', async () => {
    const raw = { events: [{ ...event, pages: [event.pages[0]] }] },
      o = options({});
    await enrichHistoricLocations(parseEvents(raw), raw, o);
    await enrichHistoricLocations(parseEvents(raw), raw, o);
    expect(o.fetchImpl).toHaveBeenCalledTimes(1);
    await enrichHistoricLocations(parseEvents(raw), raw, { ...o, now: now + 86400001 });
    expect(o.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('bounds retained metadata and rejects oversized responses without dropping the event', async () => {
    const raw = { events: [event] },
      o = options(fixtures());
    o.state.set(
      'onthisdayLocations:v1',
      Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          `Q${i + 10000}`,
          { fetchedAt: now - 100, entity: null },
        ]),
      ),
    );
    await enrichHistoricLocations(parseEvents(raw), raw, o);
    expect(
      Object.keys(o.state.get<Record<string, unknown>>('onthisdayLocations:v1')!),
    ).toHaveLength(250);
    const oversized = vi.fn().mockResolvedValue(new Response('x'.repeat(6000001)));
    const fresh = options(fixtures());
    expect(
      (await enrichHistoricLocations(parseEvents(raw), raw, { ...fresh, fetchImpl: oversized }))[0]
        ?.text,
    ).toBe(event.text);
    expect(fresh.state.get('onthisdayLocations:v1')).toBeUndefined();
  });
  it('includes the venue through the complete production module, not just its resolver', async () => {
    const o = options(fixtures());
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('/feed/onthisday/')
        ? new Response(JSON.stringify({ events: [event] }))
        : o.fetchImpl(url, init),
    );
    const ctx = {
      state: o.state,
      log: o.log,
      clock: { todayKey: () => '2026-10-10', now: () => new Date(now) },
    } as unknown as Ctx<AppConfig>;
    const block = await createOnThisDayModule({ fetchImpl: fetchImpl as typeof fetch }).run(ctx);
    expect(block?.data).toMatchObject({
      events: [{ year: 1964, location: { label: 'Токіо', kind: 'event_place' } }],
    });
  });
  it('recovers a failed large metadata batch with two smaller requests in the same deadline', async () => {
    const raw = {
      events: [0, 1].map((i) => ({
        year: 1900 + i,
        text: `Подія ${i}`,
        pages: Array.from({ length: 10 }, (_, n) => ({
          title: `Місце ${i}-${n}`,
          wikibase_item: `Q${1000 + i * 10 + n}`,
        })),
      })),
    };
    const o = options({});
    const sizes: number[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const ids = new URL(String(url)).searchParams.get('ids')!.split('|');
      sizes.push(ids.length);
      if (ids.length > 10) return new Response('{}', { status: 503 });
      return o.fetchImpl(url);
    });
    const result = await enrichHistoricLocations(parseEvents(raw), raw, {
      ...o,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(sizes).toEqual([20, 10, 10]);
    expect(result).toHaveLength(2);
  });
});
