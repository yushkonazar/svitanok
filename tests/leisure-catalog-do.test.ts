import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { LeisureCatalogDO } from '../web/core/leisure/catalog-do.mjs';
import { normalizeLeisureItem } from '../web/core/leisure/model.mjs';
import {
  readLeisureWorkspace,
  publishLeisureEdition,
  executeLeisureCommand,
} from '../web/core/leisure/store.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
const mocks = vi.hoisted(() => ({ collect: vi.fn(), places: vi.fn(), check: vi.fn() }));
vi.mock('../web/core/leisure/catalog.mjs', async (original) => ({
  ...(await original<object>()),
  collectSource: mocks.collect,
  checkLeisureSource: mocks.check,
}));
vi.mock('../web/core/adapters/maps.mjs', async (original) => ({
  ...(await original<object>()),
  placesSearch: mocks.places,
}));
const now = Date.parse('2026-10-12T05:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.collect.mockReset();
  mocks.check.mockReset();
  mocks.places.mockReset();
  mocks.collect.mockResolvedValue([]);
  mocks.places.mockResolvedValue({ source: 'api', places: [] });
});
afterEach(() => vi.useRealTimers());
function setup() {
  const d1 = d1FromSqlite(['0039_leisure.sql'], { atomicBatch: true });
  const DB = {
    ...d1.stub,
    prepare: (sql: string) => {
      const s = d1.stub.prepare(sql);
      return { ...s, ...s.bind() };
    },
  };
  const env = workerEnv({ DB });
  const storage = new Map<
      string,
      {
        active: boolean;
        index: number;
        tasks: { id: string; query?: string; offset: number }[];
        sources: Record<string, unknown>[];
      }
    >(),
    alarms: number[] = [];
  const collector = new LeisureCatalogDO(
    {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (
          key: string,
          value: {
            active: boolean;
            index: number;
            tasks: { id: string; query?: string; offset: number }[];
            sources: Record<string, unknown>[];
          },
        ) => {
          storage.set(key, structuredClone(value));
        },
        setAlarm: async (at: number) => {
          alarms.push(at);
        },
      },
    } as never,
    env,
  );
  return { ...d1, env, collector, storage, alarms };
}
async function example() {
  return (await normalizeLeisureItem(
    {
      title: 'Подія',
      category: 'show',
      sourceUrl: 'https://concert.ua/uk/event/test',
      startDate: '2026-10-12',
      endDate: '2026-10-18',
    },
    now,
  ))!;
}
describe('isolated resumable catalogue batches', () => {
  it('rechecks a saved event separately from cinema and stores explicit cancellation', async () => {
    const { collector, storage, env, db } = setup();
    const item = await example();
    await publishLeisureEdition(env, [item], [], now);
    await executeLeisureCommand(
      env,
      { op: 'save', id: item.id, payload: { saved: true }, commandId: 'saved-event-001' },
      now,
    );
    await collector.request('daily', now);
    expect(storage.get('job')!.tasks).toHaveLength(2);
    await collector.alarm();
    mocks.check.mockResolvedValue({
      item: { ...item, status: 'cancelled', checkedAt: new Date(now).toISOString() },
      verified: true,
    });
    await collector.alarm();
    expect(mocks.check).toHaveBeenCalledWith(item, now);
    expect(
      (await readLeisureWorkspace(env, now, true)).items.find((i) => i.id === item.id)?.status,
    ).toBe('cancelled');
    db.close();
  });
  it('deduplicates simultaneous refresh requests and does no source fetch during the HTTP request', async () => {
    const { collector, db, alarms } = setup();
    const messages = await Promise.all([
      collector.request('full', now),
      collector.request('full', now),
    ]);
    expect(messages[0].message).toContain('запущено');
    expect(messages[1].message).toContain('уже');
    expect(alarms).toHaveLength(1);
    expect(mocks.collect).not.toHaveBeenCalled();
    db.close();
  });
  it('collects one source page per alarm and resumes its cursor without losing candidates', async () => {
    const { collector, storage, env, db } = setup();
    await collector.request();
    const j = storage.get('job')!;
    j.tasks = [{ id: 'concert', offset: 0 }];
    storage.set('job', j);
    const a = await example();
    mocks.collect
      .mockResolvedValueOnce(Object.assign([a], { nextOffset: 10 }))
      .mockResolvedValueOnce(Object.assign([], { nextOffset: null }));
    await collector.alarm();
    expect(mocks.collect).toHaveBeenCalledTimes(1);
    expect(storage.get('job')!.tasks[0]!.offset).toBe(10);
    expect(storage.get('job')!.index).toBe(0);
    await collector.alarm();
    expect(storage.get('job')!.index).toBe(1);
    await collector.alarm();
    expect(storage.get('job')!.active).toBe(false);
    expect((await readLeisureWorkspace(env, now)).edition.ids).toEqual([a.id]);
    db.close();
  });
  it('does not publish a prepared weekly package before 08:00 Kyiv', async () => {
    const { collector, storage, alarms, env, db } = setup();
    vi.setSystemTime(now - 3600000);
    await collector.request('full', now - 3600000);
    const job = storage.get('job')!;
    job.tasks = [{ id: 'concert', offset: 0 }];
    storage.set('job', job);
    mocks.collect.mockResolvedValue([await example()]);
    await collector.alarm();
    await collector.alarm();
    expect((await readLeisureWorkspace(env, now - 3600000)).edition).toBeNull();
    expect(alarms.at(-1)).toBe(now);
    vi.setSystemTime(now);
    await collector.alarm();
    expect((await readLeisureWorkspace(env, now)).edition).not.toBeNull();
    db.close();
  });
  it('retains a useful previous edition and reports a failed source without fabricating entries', async () => {
    const { collector, storage, env, db } = setup();
    const a = await example();
    await publishLeisureEdition(env, [a], [], now);
    await collector.request();
    const job = storage.get('job')!;
    job.tasks = [{ id: 'concert', offset: 0 }];
    storage.set('job', job);
    mocks.collect.mockRejectedValue(new Error('network'));
    await collector.alarm();
    await collector.alarm();
    const data = await readLeisureWorkspace(env, now);
    expect(data.edition.ids).toEqual([a.id]);
    expect(data.edition.sources[0].status).toBe('unavailable');
    expect(data.refresh.active).toBe(false);
    db.close();
  });
  it('stops a queued batch when the owner turns updates off', async () => {
    const { collector, env, storage, db } = setup();
    await collector.request();
    await executeLeisureCommand(
      env,
      { op: 'settings', payload: { enabled: false }, commandId: crypto.randomUUID() },
      now,
    );
    await collector.alarm();
    expect(storage.get('job')!.active).toBe(false);
    expect(mocks.collect).not.toHaveBeenCalled();
    db.close();
  });
  it('does not repeatedly retry a daily cinema failure every scheduler tick', async () => {
    const { collector, storage, db } = setup();
    await collector.request('daily');
    await collector.alarm();
    await collector.alarm();
    expect((await collector.request('daily', now + 30 * 60000)).message).toContain('пізніше');
    expect(storage.get('job')!.active).toBe(false);
    db.close();
  });
  it('isolates one places direction and adds no fabricated prices', async () => {
    const { collector, storage, env, db } = setup();
    await collector.request();
    const job = storage.get('job')!;
    job.tasks = [{ id: 'places-0', query: 'кафе Львів', offset: 0 }];
    storage.set('job', job);
    mocks.places.mockResolvedValue({
      source: 'api',
      places: [
        {
          place_id: 'cafe',
          name: 'Кафе',
          address: 'Львів, 1',
          maps_uri: 'https://maps.google.com/?q=cafe',
          place_type: 'cafe',
        },
      ],
    });
    await collector.alarm();
    expect(mocks.places).toHaveBeenCalledTimes(1);
    await collector.alarm();
    const data = await readLeisureWorkspace(env, now);
    expect(data.items[0]).toMatchObject({ placeType: 'cafe', price: { min: null } });
    db.close();
  });
});
