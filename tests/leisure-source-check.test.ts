import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkLeisureSource } from '../web/core/leisure/catalog.mjs';
import { normalizeLeisureItem } from '../web/core/leisure/model.mjs';
import {
  executeLeisureCommand,
  upsertLeisureItems,
  readLeisureWorkspace,
  publishLeisureEdition,
} from '../web/core/leisure/store.mjs';
import { runLeisureQuery } from '../web/core/tools/leisure.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
const now = Date.parse('2026-10-12T10:00:00Z');
const event = async () =>
  (await normalizeLeisureItem(
    {
      title: 'Наш концерт',
      category: 'concert',
      source: 'Concert.ua',
      sourceUrl: 'https://concert.ua/uk/event/test',
      startDate: '2026-10-14',
      startAt: '2026-10-14T18:00:00+03:00',
    },
    now,
  ))!;
const html = (name = 'Наш концерт', status = 'EventCancelled') =>
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'Event', name, startDate: '2026-10-14T19:00:00+03:00', eventStatus: `https://schema.org/${status}`, location: { name: 'Місце', address: 'Львів' } })}</script>`;
afterEach(() => vi.unstubAllGlobals());
describe('selected source verification', () => {
  it('updates explicit cancellation and changed time only for the exact event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html())),
    );
    const item = await event();
    const result = await checkLeisureSource(item, now + 1000);
    expect(result.verified).toBe(true);
    expect(result.item).toMatchObject({
      id: item.id,
      status: 'cancelled',
      startAt: '2026-10-14T16:00:00.000Z',
    });
  });
  it('does not copy an unrelated event cancellation or infer status from generic text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html('Інший концерт') + '<p>Усі квитки продано</p>')),
    );
    const item = await event();
    const result = await checkLeisureSource(item, now + 1000);
    expect(result).toEqual({ item, verified: false });
  });
  it('refuses unapproved hosts without making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      checkLeisureSource({ ...(await event()), sourceUrl: 'https://unknown.example/event' }, now),
    ).rejects.toThrow('source-not-allowed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps a failed source check from manufacturing a fresh event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    await expect(checkLeisureSource(await event(), now)).rejects.toThrow('source-http-503');
  });
  it('preserves venue identity but replaces refreshed place metadata', async () => {
    const d1 = d1FromSqlite(['0039_leisure.sql'], { atomicBatch: true });
    const DB = {
      ...d1.stub,
      prepare: (sql: string) => {
        const s = d1.stub.prepare(sql);
        return { ...s, ...s.bind() };
      },
    };
    const env = workerEnv({ DB });
    const item = (await normalizeLeisureItem(
      {
        title: 'Кафе',
        category: 'food',
        placeId: 'ChIJtest123456',
        sourceUrl: 'https://maps.google.com/',
      },
      now,
    ))!;
    await upsertLeisureItems(env, [
      { ...item, placeDetails: { hours: ['old'] }, siteUrl: 'https://old.example/' },
    ]);
    await upsertLeisureItems(env, [
      { ...item, placeDetails: { hours: ['new'] }, siteUrl: 'https://new.example/' },
    ]);
    const data = await readLeisureWorkspace(env, now, true);
    expect(data.items[0]).toMatchObject({
      id: item.id,
      placeDetails: { hours: ['new'] },
      siteUrl: 'https://new.example/',
    });
    d1.db.close();
  });
  it('prevents calendar planning after the selected source confirms cancellation', async () => {
    const d1 = d1FromSqlite(['0039_leisure.sql'], { atomicBatch: true });
    const DB = {
      ...d1.stub,
      prepare: (sql: string) => {
        const s = d1.stub.prepare(sql);
        return { ...s, ...s.bind() };
      },
    };
    const env = workerEnv({ DB });
    const item = await event();
    await upsertLeisureItems(env, [item]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html())),
    );
    await executeLeisureCommand(
      env,
      { op: 'source-check', id: item.id, commandId: 'source-check-001', payload: {} },
      now,
    );
    await expect(
      executeLeisureCommand(
        env,
        {
          op: 'calendar-check',
          commandId: 'check-plan-001',
          payload: {
            title: 'Вечір',
            calendar: true,
            stops: [
              { itemId: item.id, startAt: '2026-10-14T16:00:00Z', endAt: '2026-10-14T18:00:00Z' },
            ],
          },
        },
        now,
      ),
    ).rejects.toThrow('недоступний');
    d1.db.close();
  });
  it('gives the assistant all ranked choices through category pagination', async () => {
    const d1 = d1FromSqlite(['0039_leisure.sql'], { atomicBatch: true });
    const DB = {
      ...d1.stub,
      prepare: (sql: string) => {
        const s = d1.stub.prepare(sql);
        return { ...s, ...s.bind() };
      },
    };
    const env = workerEnv({ DB });
    const base = await event();
    const items = Array.from({ length: 25 }, (_, i) => ({
      ...base,
      id: `item-${i}`,
      title: `Подія ${i}`,
      sourceUrl: `https://concert.ua/${i}`,
    }));
    await publishLeisureEdition(env, items, [], now);
    const result = await runLeisureQuery(env, { category: 'concert', offset: 18, limit: 4 }, now);
    expect(result.result).toContain('"total":25');
    expect(result.result).toContain('"nextOffset":22');
    expect(result.result.match(/"sessionCount"/g) || []).toHaveLength(4);
    d1.db.close();
  });
});
