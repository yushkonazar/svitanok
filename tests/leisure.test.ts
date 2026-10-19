import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';
import { buildInitData } from './helpers/init-data.js';
import { loadStats } from '../web/kv-store.mjs';
import {
  leisureWeek,
  normalizeLeisureItem,
  normalizeLeisurePlan,
  selectLeisureEdition,
  DEFAULT_LEISURE_SETTINGS,
} from '../web/core/leisure/model.mjs';
import {
  executeLeisureCommand,
  inspectLeisureCommand,
  leisureRecord,
  publishLeisureEdition,
  readLeisureWorkspace,
  upsertLeisureItems,
} from '../web/core/leisure/store.mjs';
import { syncLeisurePlan, reconcileLeisureCalendar } from '../web/core/leisure/calendar.mjs';
import {
  eventCandidate,
  articleCandidate,
  sourceDateRange,
  collectPlaneta,
  collectNearby,
  collectSource,
  refreshLeisureCatalog,
  leisureCatalogTask,
} from '../web/core/leisure/catalog.mjs';
import { parseNuxtData } from '../web/core/leisure/nuxt-data.mjs';
import { handleLeisure } from '../web/api-leisure.mjs';
import { runLeisureQuery } from '../web/core/tools/leisure.mjs';

const google = vi.hoisted(() => ({
  read: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  inspect: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const maps = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../web/core/adapters/maps.mjs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  placesSearch: maps.search,
}));
vi.mock('../web/google.mjs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readCalendarRange: google.read,
  createCalendarEvent: google.create,
  getCalendarEvent: google.get,
  inspectCalendarEvent: google.inspect,
  updateCalendarEvent: google.update,
  deleteCalendarEvent: google.remove,
}));
const NOW = Date.parse('2026-10-12T05:00:00Z'); // Monday 08:00 Kyiv
async function item(over: Record<string, unknown> = {}) {
  return (await normalizeLeisureItem(
    {
      title: 'Виставка',
      category: 'exhibition',
      source: 'Музей',
      sourceUrl: 'https://lviv.travel/ua/events/test',
      address: 'Львів, 1',
      venue: 'Музей',
      startDate: '2026-10-12',
      endDate: '2026-11-08',
      ...over,
    },
    NOW,
  ))!;
}
function setup() {
  const d1 = d1FromSqlite(['0039_leisure.sql'], { atomicBatch: true });
  const db = {
    ...d1.stub,
    prepare: (sql: string) => {
      const p = d1.stub.prepare(sql);
      return { ...p, ...p.bind() };
    },
  };
  return {
    ...d1,
    env: workerEnv({ DB: db, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_OWNER_USER_ID: '42' }),
  };
}
const command = (
  op: string,
  payload: Record<string, unknown> = {},
  id?: string,
  commandId = crypto.randomUUID(),
) => ({ op, payload, id, commandId });
const planPayload = (id: string) => ({
  title: 'Наш вечір',
  stops: [{ itemId: id, startAt: '2026-10-15T15:00:00Z', endAt: '2026-10-15T16:00:00Z' }],
  calendar: true,
  revision: 0,
});
describe('read-only verification and fast mutation acknowledgements', () => {
  it('acknowledges a reaction without loading the catalog and verifies it without replaying a write', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const c = command('reaction', { verdict: 'later', reasonCode: 'not-now' }, i.id);
    const init = await buildInitData(42, 'test-token');
    const request = new Request('https://app.test/api/leisure', {
      method: 'POST',
      headers: {
        'X-Telegram-Init-Data': init,
        'X-Leisure-Format': '3',
        'content-type': 'application/json',
      },
      body: JSON.stringify(c),
    });
    const r = await handleLeisure(request, env);
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Request-Id')).toBeTruthy();
    expect(await r.json()).toEqual({
      ok: true,
      acknowledged: true,
      receipt: { message: 'Вибір збережено.', revision: 1 },
    });
    const count = db.prepare('SELECT COUNT(*) AS n FROM leisure_commands').get()!.n;
    const verified = await handleLeisure(
      new Request(`https://app.test/api/leisure?commandId=${c.commandId}`, {
        headers: { 'X-Telegram-Init-Data': init },
      }),
      env,
    );
    expect(await verified.json()).toMatchObject({
      ok: true,
      verification: { found: true, receipt: { message: 'Вибір збережено.', revision: 1 } },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM leisure_commands').get()!.n).toBe(count);
    expect(await inspectLeisureCommand(env, 'not-saved-command')).toEqual({ found: false });
    db.prepare('DELETE FROM leisure_commands WHERE id=?').run(c.commandId);
    expect(await inspectLeisureCommand(env, c.commandId)).toMatchObject({
      found: true,
      receipt: { id: `reaction-${i.id}` },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM leisure_commands').get()!.n).toBe(0);
    await expect(inspectLeisureCommand(env, 'bad')).rejects.toThrow('ідентифікатор');
    db.close();
  });
  it('returns an actionable, payload-free diagnostic for storage errors', async () => {
    const { env, db } = setup(),
      init = await buildInitData(42, 'test-token');
    const failed = workerEnv({
      ...env,
      DB: {
        ...env.DB!,
        prepare: () => {
          throw Error('D1_ERROR secret-personal-payload');
        },
      },
    });
    const response = await handleLeisure(
      new Request('https://app.test/api/leisure', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': init, 'content-type': 'application/json' },
        body: JSON.stringify(command('reaction', { verdict: 'later' }, 'event-id')),
      }),
      failed,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { diagnostic: Record<string, unknown> };
    expect(body.diagnostic).toMatchObject({
      area: 'leisure',
      phase: 'command',
      status: 503,
      code: 'storage-failure',
      operation: 'reaction',
    });
    expect(JSON.stringify(body)).not.toContain('secret-personal-payload');
    db.close();
  });
});
beforeEach(() => {
  maps.search.mockResolvedValue({
    source: 'api',
    places: [
      {
        place_id: 'venue-a',
        name: 'Кафе',
        address: 'Львів, 2',
        lat: 49.8,
        lon: 24,
        maps_uri: 'https://www.google.com/maps/?q=cafe',
      },
    ],
  });
  google.read.mockResolvedValue([]);
  google.create.mockResolvedValue({ ok: true, id: 'event-id' });
  google.get.mockResolvedValue(null);
  google.inspect.mockImplementation(async () => {
    const event = await google.get();
    return { state: event ? 'found' : 'missing', event };
  });
  google.update.mockResolvedValue({ ok: true });
  google.remove.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('verified leisure facts and selection', () => {
  it('uses Kyiv Monday across UTC and month boundaries', () => {
    expect(leisureWeek(Date.parse('2026-10-11T22:00:00Z'))).toBe('2026-10-12');
    expect(leisureWeek(Date.parse('2026-11-01T23:30:00Z'))).toBe('2026-11-02');
  });
  it('distinguishes unknown, zero catalogue price and explicitly free admission', async () => {
    expect((await item({ priceMin: 0 })).price.min).toBeNull();
    expect((await item({ priceMin: 0, free: true })).price.min).toBe(0);
    expect((await item({ priceMin: NaN })).price.min).toBeNull();
  });
  it('uses Google place identity per branch, and preserves it across renames', async () => {
    const a = await item({ placeId: 'branch-a', title: 'Old' }),
      b = await item({ placeId: 'branch-a', title: 'New' }),
      c = await item({ placeId: 'branch-b' });
    expect(a.venueId).toBe(b.venueId);
    expect(a.venueId).not.toBe(c.venueId);
  });
  it('rejects malformed dates and never plans overlapping stops', async () => {
    await expect(item({ startDate: '2026-02-30' })).rejects.toThrow('дату');
    expect(() =>
      normalizeLeisurePlan({
        ...planPayload('a'),
        stops: [...planPayload('a').stops, ...planPayload('b').stops],
      }),
    ).toThrow('перетинаються');
  });
  it('keeps previous, familiar and planned choices browseable while excluding unavailable facts', async () => {
    const candidates = await Promise.all(
      ['new', 'previous', 'visited', 'planned', 'sold', 'expired', 'future'].map((name) =>
        item({
          title: name,
          sourceUrl: `https://lviv.travel/${name}`,
          ...(name === 'sold'
            ? { status: 'sold-out' }
            : name === 'expired'
              ? { startDate: '2026-10-01', endDate: '2026-10-02' }
              : name === 'future'
                ? { startDate: '2026-10-25', endDate: '2026-10-25' }
                : {}),
        }),
      ),
    );
    const result = selectLeisureEdition(
      candidates,
      [
        { kind: 'visit', itemId: candidates[2]!.id },
        { kind: 'plan', status: 'planned', stops: [{ itemId: candidates[3]!.id }] },
      ],
      [candidates[1]!.id],
      DEFAULT_LEISURE_SETTINGS,
      NOW,
    );
    expect(new Set(result.ids)).toEqual(new Set(candidates.slice(0, 4).map((i) => i.id)));
    expect(result.futureIds).toEqual([candidates[6]!.id]);
  });
  it('does not interpret a missed outing as dislike, and deduplicates the same event across sources', async () => {
    const a = await item(),
      b = await item({ sourceUrl: 'https://concert.ua/uk/event/test' });
    const result = selectLeisureEdition(
      [a, b],
      [{ kind: 'plan', status: 'not-went', stops: [{ itemId: a.id }] }],
      [],
      DEFAULT_LEISURE_SETTINGS,
      NOW,
    );
    expect(result.ids).toHaveLength(1);
  });
  it('does not publish a date-only event as a midnight appointment or infer a publication date', async () => {
    const raw = eventCandidate(
      { '@type': 'Event', name: 'Концерт', startDate: '2026-10-15', offers: { price: 0 } },
      'Concert.ua',
      'https://concert.ua/test',
    );
    expect((await item(raw!)).startAt).toBeNull();
    expect(
      articleCandidate(
        '<h1>Виставка</h1><meta name="datePublished" content="2026-10-12">',
        'https://lviv.travel/test',
        'Lviv',
      ),
    ).toBeNull();
    expect(sourceDateRange('10/10/26 – 08/11/26')).toEqual({
      startDate: '2026-10-10',
      endDate: '2026-11-08',
    });
  });
});

describe('Nuxt literal reader', () => {
  it('reads aliases and literal assignments without executing scripts', () => {
    expect(
      parseNuxtData(
        '<script>window.__NUXT__=(function(a,b){b.id="c";return {data:[{ok:a,cinema:b}]}}(true,{}));</script>',
      ),
    ).toEqual({ data: [{ ok: true, cinema: { id: 'c' } }] });
  });
  it.each([
    'fetch("https://evil.test")',
    '({}).constructor("alert(1)")()',
    '{__proto__:{polluted:true}}',
    'a.prototype={};return {}',
  ])('rejects executable or unsafe input %s', (value) => {
    expect(parseNuxtData(`window.__NUXT__=(function(a){return ${value}}({}));`)).toBeNull();
  });
  it('returns unavailable for a changed serialization instead of guessing', () => {
    expect(parseNuxtData('window.__NUXT__={data:[]};')).toBeNull();
  });
});

describe('shared leisure ledger', () => {
  it('marks visited choices as familiar and permits planning a repeat without hiding the catalogue', async () => {
    const { env, db } = setup(),
      i = await item({ category: 'food', startDate: null, endDate: null });
    await publishLeisureEdition(env, [i], [], NOW);
    await executeLeisureCommand(env, command('visit', { visitedOn: null }, i.id), NOW);
    expect((await readLeisureWorkspace(env, NOW)).edition.ids).toContain(i.id);
    await upsertLeisureItems(env, [
      { ...i, checkedAt: new Date(NOW - 30 * 86400000).toISOString() },
    ]);
    const receipt = await executeLeisureCommand(env, command('plan', planPayload(i.id)), NOW);
    expect(await leisureRecord(env, receipt.id)).toMatchObject({ status: 'planned' });
    db.close();
  });
  it('preserves interests and disabled updates when clearing history, without removing other saved content', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    await executeLeisureCommand(
      env,
      command('settings', {
        enabled: false,
        categories: ['food'],
        cinemas: ['king-cross'],
        students: 1,
      }),
      NOW,
    );
    await executeLeisureCommand(env, command('save', { saved: true }, i.id), NOW);
    await executeLeisureCommand(
      env,
      command('visit', { rating: 'neutral', visitedOn: '2026-10-10' }, i.id),
      NOW,
    );
    await expect(executeLeisureCommand(env, command('clear', {}), NOW)).rejects.toThrow(
      'Підтвердь',
    );
    await executeLeisureCommand(env, command('clear', { confirmed: true }), NOW);
    const workspace = await readLeisureWorkspace(env, NOW);
    expect(workspace.saved).toEqual([]);
    expect(workspace.records).toEqual([]);
    expect(workspace.settings).toMatchObject({
      enabled: false,
      categories: ['food'],
      cinemas: ['king-cross'],
      students: 1,
    });
    await expect(refreshLeisureCatalog(env, NOW)).resolves.toMatchObject({
      message: 'Оновлення дозвілля вимкнено.',
    });
    db.close();
  });
  it('recovers a committed plan if its receipt disappears and rejects stale editing', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const c = command('plan', planPayload(i.id));
    const receipt = await executeLeisureCommand(env, c, NOW);
    db.prepare('DELETE FROM leisure_commands').run();
    expect((await executeLeisureCommand(env, c, NOW)).id).toBe(receipt.id);
    expect(google.create).toHaveBeenCalledTimes(1);
    await expect(
      executeLeisureCommand(
        env,
        command('plan', { ...planPayload(i.id), revision: 0 }, receipt.id),
        NOW,
      ),
    ).rejects.toThrow('змінився');
    await expect(
      executeLeisureCommand(env, command('plan', planPayload(i.id), 'missing-plan'), NOW),
    ).rejects.toThrow('не знайдено');
    db.close();
  });
  it('backs off calendar failures and does not resurrect a manually deleted event', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    google.create.mockResolvedValue({ ok: false });
    const receipt = await executeLeisureCommand(env, command('plan', planPayload(i.id)), NOW);
    await reconcileLeisureCalendar(env, NOW + 60000);
    expect(google.create).toHaveBeenCalledTimes(1);
    google.create.mockResolvedValue({ ok: true, id: 'cal' });
    await reconcileLeisureCalendar(env, NOW + 300001);
    expect((await leisureRecord(env, receipt.id)).calendarState).toBe('synced');
    const stored = await leisureRecord(env, receipt.id);
    db.prepare('UPDATE leisure_records SET data_json=? WHERE id=?').run(
      JSON.stringify({ ...stored, calendarState: 'pending' }),
      receipt.id,
    );
    google.inspect.mockResolvedValue({ state: 'missing', event: null });
    await syncLeisurePlan(env, receipt.id, NOW + 400000);
    expect((await leisureRecord(env, receipt.id)).calendarState).toBe('conflict');
    expect(google.create).toHaveBeenCalledTimes(2);
    await executeLeisureCommand(env, command('cancel', { revision: 1 }, receipt.id), NOW + 500000);
    expect((await leisureRecord(env, receipt.id)).calendarState).toBe('none');
    db.close();
  });
  it('updates an unchanged calendar event conditionally and detects a concurrent Google edit', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const receipt = await executeLeisureCommand(env, command('plan', planPayload(i.id)), NOW);
    const stored = await leisureRecord(env, receipt.id);
    google.inspect.mockResolvedValue({
      state: 'found',
      event: {
        title: stored.title,
        startMs: Date.parse(stored.startAt),
        endMs: Date.parse(stored.endAt),
        hasAttendees: false,
      },
      audit: stored.lastSynced,
      etag: 'etag-1',
    });
    const edit = { ...planPayload(i.id), title: 'Змінений вечір', revision: 1 };
    await executeLeisureCommand(env, command('plan', edit, receipt.id), NOW + 1000);
    expect(google.update).toHaveBeenCalledWith(env, expect.objectContaining({ etag: 'etag-1' }));
    expect((await leisureRecord(env, receipt.id)).calendarState).toBe('synced');
    const updated = await leisureRecord(env, receipt.id);
    google.inspect.mockResolvedValue({
      state: 'found',
      event: {
        title: updated.title,
        startMs: Date.parse(updated.startAt),
        endMs: Date.parse(updated.endAt),
        hasAttendees: false,
      },
      audit: updated.lastSynced,
      etag: 'etag-2',
    });
    google.update.mockResolvedValue({ ok: false, conflict: true });
    await executeLeisureCommand(
      env,
      command('plan', { ...edit, title: 'Ще один варіант', revision: 2 }, receipt.id),
      NOW + 2000,
    );
    expect((await leisureRecord(env, receipt.id)).calendarState).toBe('conflict');
    db.close();
  });
  it('rejects unavailable, stale and out-of-range offers before writing the plan', async () => {
    const { env, db } = setup();
    for (const over of [
      { status: 'cancelled' },
      { checkedAt: new Date(NOW - 9 * 86400000).toISOString() },
      { startDate: '2026-10-20', endDate: '2026-10-21' },
    ]) {
      const i = { ...(await item()), ...over };
      await upsertLeisureItems(env, [i]);
      await expect(
        executeLeisureCommand(env, command('plan', planPayload(i.id)), NOW),
      ).rejects.toThrow();
    }
    expect(google.create).not.toHaveBeenCalled();
    db.close();
  });
  it('returns controlled API errors for unsupported methods and malformed actions', async () => {
    const { env, db } = setup(),
      init = await buildInitData(42, 'test-token');
    expect(
      (await handleLeisure(new Request('https://app.test/api/leisure', { method: 'PUT' }), env))
        .status,
    ).toBe(405);
    const send = (body: string) =>
      handleLeisure(
        new Request('https://app.test/api/leisure', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': init },
          body,
        }),
        env,
      );
    expect((await send('{invalid')).status).toBe(400);
    expect((await send(JSON.stringify(command('unknown')))).status).toBe(400);
    expect((await send(JSON.stringify(command('save', { saved: true }, 'missing')))).status).toBe(
      404,
    );
    for (const payload of [
      { students: 3 },
      { categories: [] },
      { cinemas: ['unknown'] },
      { enabled: 'yes' },
    ])
      await expect(executeLeisureCommand(env, command('settings', payload), NOW)).rejects.toThrow();
    db.close();
  });
  it('lets the assistant inspect a plan and calendar before requesting approval, with no ledger or calendar writes', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const detail = await runLeisureQuery(env, { id: i.id }, NOW);
    expect(detail.result).toContain(i.title);
    const check = await runLeisureQuery(env, { plan_json: JSON.stringify(planPayload(i.id)) }, NOW);
    expect(check.result).toContain('"available":true');
    expect(db.prepare('SELECT COUNT(*) AS n FROM leisure_commands').get()!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM leisure_records').get()!.n).toBe(0);
    expect(google.create).not.toHaveBeenCalled();
    db.close();
  });
  it('acknowledges a saved change even when the following snapshot read fails', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const original = env.DB!;
    const failing = workerEnv({
      ...env,
      DB: {
        ...original,
        prepare: (sql: string) => {
          if (sql.includes('FROM leisure_editions ORDER')) throw new Error('snapshot-read');
          return original.prepare(sql);
        },
      },
    });
    const init = await buildInitData(42, 'test-token');
    const response = await handleLeisure(
      new Request('https://app.test/api/leisure', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Telegram-Init-Data': init },
        body: JSON.stringify(command('save', { saved: true }, i.id)),
      }),
      failing,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      acknowledged: true,
      receipt: { message: 'Збережено.' },
    });
    expect((await loadStats(env)).saved).toHaveLength(1);
    db.close();
  });
  it('records canonical saved items once and keeps them distinct from visits', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const c = command('save', { saved: true }, i.id);
    await executeLeisureCommand(env, c, NOW);
    await executeLeisureCommand(env, c, NOW);
    expect((await loadStats(env)).saved).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM leisure_records WHERE kind='visit'").get()!.n,
    ).toBe(0);
    expect((await readLeisureWorkspace(env, NOW)).saved).toEqual([i.id]);
    db.close();
  });
  it('supports an unknown past date, a repeated venue visit, and feedback editing without duplication', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const first = await executeLeisureCommand(
      env,
      command('visit', { visitedOn: null }, i.id),
      NOW,
    );
    await executeLeisureCommand(env, command('visit', { visitedOn: '2026-10-11' }, i.id), NOW);
    await executeLeisureCommand(
      env,
      command(
        'visit',
        { visitId: first.id, revision: 1, visitedOn: null, rating: 'liked', reason: 'Атмосфера' },
        i.id,
      ),
      NOW,
    );
    const records = (await readLeisureWorkspace(env, NOW)).records.filter(
      (r) => r.kind === 'visit',
    );
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.id === first.id)).toMatchObject({
      visitedOn: null,
      rating: 'liked',
      revision: 2,
    });
    await expect(
      executeLeisureCommand(env, command('visit', { visitId: first.id, revision: 1 }, i.id), NOW),
    ).rejects.toThrow('змінився');
    db.close();
  });
  it('rejects command ID reuse with different payloads and future visits', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const c = command('save', { saved: true }, i.id);
    await executeLeisureCommand(env, c, NOW);
    await expect(
      executeLeisureCommand(env, { ...c, payload: { saved: false } }, NOW),
    ).rejects.toThrow('іншої дії');
    await expect(
      executeLeisureCommand(env, command('visit', { visitedOn: '2026-10-13' }, i.id), NOW),
    ).rejects.toThrow('майбутньому');
    db.close();
  });
  it('requires explicit calendar conflict approval; a saved recommendation creates no calendar event', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    await executeLeisureCommand(env, command('save', { saved: true }, i.id), NOW);
    expect(google.create).not.toHaveBeenCalled();
    google.read.mockResolvedValue([
      {
        id: 'busy',
        title: 'Робота',
        startMs: Date.parse('2026-10-15T14:00:00Z'),
        endMs: Date.parse('2026-10-15T17:00:00Z'),
      },
    ]);
    await expect(
      executeLeisureCommand(env, command('plan', planPayload(i.id)), NOW),
    ).rejects.toThrow('накладка');
    expect(google.create).not.toHaveBeenCalled();
    const c = command('plan', { ...planPayload(i.id), conflictConfirmed: true });
    const result = await executeLeisureCommand(env, c, NOW);
    await executeLeisureCommand(env, c, NOW);
    expect(google.create).toHaveBeenCalledTimes(1);
    expect(await leisureRecord(env, result.id)).toMatchObject({ calendarState: 'synced' });
    db.close();
  });
  it('requires explicit fallback when the calendar cannot be read and never invents film sessions', async () => {
    const { env, db } = setup(),
      i = await item(),
      film = await item({
        source: 'Планета кіно',
        category: 'cinema',
        sourceUrl: 'https://planetakino.ua/movie/test/',
      });
    await upsertLeisureItems(env, [i, film]);
    google.read.mockResolvedValue(null);
    await expect(
      executeLeisureCommand(env, command('plan', planPayload(i.id)), NOW),
    ).rejects.toThrow('перевірити');
    await expect(
      executeLeisureCommand(
        env,
        command('plan', { ...planPayload(film.id), calendarUnavailableConfirmed: true }),
        NOW,
      ),
    ).rejects.toThrow('сеанс');
    const result = await executeLeisureCommand(
      env,
      command('plan', {
        ...planPayload(i.id),
        calendar: false,
        calendarUnavailableConfirmed: true,
      }),
      NOW,
    );
    expect(await leisureRecord(env, result.id)).toMatchObject({ calendarState: 'none' });
    expect(google.create).not.toHaveBeenCalled();
    db.close();
  });
  it('marks a missed outing separately and preserves manual calendar edits on cancellation', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const result = await executeLeisureCommand(env, command('plan', planPayload(i.id)), NOW);
    await executeLeisureCommand(
      env,
      command('outcome', { status: 'not-went', revision: 1 }, result.id),
      NOW,
    );
    expect(
      (await readLeisureWorkspace(env, NOW)).records.some(
        (r) => r.kind === 'visit' || r.kind === 'reaction',
      ),
    ).toBe(false);
    google.get.mockResolvedValue({
      title: 'Змінено в Google',
      hasAttendees: false,
      startMs: 0,
      endMs: 1,
    });
    await executeLeisureCommand(env, command('cancel', { revision: 2 }, result.id), NOW);
    expect(google.remove).not.toHaveBeenCalled();
    expect(await leisureRecord(env, result.id)).toMatchObject({
      status: 'cancelled',
      calendarState: 'conflict',
    });
    db.close();
  });
  it('recovers a lost Google create response using the deterministic event ID', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    google.create
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false, exists: true, id: 'existing' });
    const result = await executeLeisureCommand(env, command('plan', planPayload(i.id)), NOW);
    expect(await leisureRecord(env, result.id)).toMatchObject({ calendarState: 'error' });
    google.get.mockResolvedValue({
      title: 'Наш вечір',
      hasAttendees: false,
      startMs: Date.parse(planPayload(i.id).stops[0]!.startAt),
      endMs: Date.parse(planPayload(i.id).stops[0]!.endAt),
    });
    await syncLeisurePlan(env, result.id, NOW + 60000);
    expect(await leisureRecord(env, result.id)).toMatchObject({
      calendarState: 'synced',
      calendarId: 'existing',
    });
    expect(google.create.mock.calls[0]![1].id).toBe(google.create.mock.calls[1]![1].id);
    db.close();
  });
  it('keeps a useful edition and persists failure metadata rather than showing a fresh empty list', async () => {
    const { env, db } = setup(),
      i = await item();
    await publishLeisureEdition(env, [i], [], NOW);
    const source = {
      id: 'lviv',
      name: 'Lviv',
      url: 'https://lviv.travel/',
      status: 'unavailable',
      count: 0,
      checkedAt: new Date(NOW + 60000).toISOString(),
    };
    await publishLeisureEdition(env, [], [source], NOW + 60000);
    const workspace = await readLeisureWorkspace(env, NOW + 60000);
    expect(workspace.edition.ids).toEqual([i.id]);
    expect(workspace.edition.sources).toEqual([source]);
    db.close();
  });
  it('exports full history beyond the screen slice without silently deleting older records', async () => {
    const { env, db } = setup(),
      i = await item();
    await upsertLeisureItems(env, [i]);
    const st = db.prepare(
      'INSERT INTO leisure_records(id,kind,item_id,data_json,updated_at) VALUES (?,?,?,?,?)',
    );
    for (let n = 0; n < 251; n++)
      st.run(
        `v${n}`,
        'visit',
        i.id,
        JSON.stringify({
          id: `v${n}`,
          kind: 'visit',
          itemId: i.id,
          visitedOn: null,
          venueId: i.venueId,
        }),
        new Date(NOW).toISOString(),
      );
    expect((await readLeisureWorkspace(env, NOW)).records).toHaveLength(250);
    expect((await readLeisureWorkspace(env, NOW, true)).records).toHaveLength(251);
    db.close();
  });
  it('authorizes the owner and never masks an invalid session with demo data', async () => {
    const { env, db } = setup();
    const denied = await handleLeisure(new Request('https://app.test/api/leisure'), env);
    expect(denied.status).toBe(401);
    const init = await buildInitData(42, 'test-token');
    const ok = await handleLeisure(
      new Request('https://app.test/api/leisure', { headers: { 'X-Telegram-Init-Data': init } }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    const other = await buildInitData(43, 'test-token');
    expect(
      (
        await handleLeisure(
          new Request('https://app.test/api/leisure', {
            headers: { 'X-Telegram-Init-Data': other },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    db.close();
  });
});

describe('public source parsing', () => {
  it('verifies ticket availability on the leaf page and skips expired catalogue entries', async () => {
    const event = {
      '@type': 'Event',
      name: 'Тестовий концерт',
      url: 'https://concert.ua/uk/event/demo',
      startDate: '2026-10-15T18:00:00+03:00',
      endDate: '2026-10-15T20:00:00+03:00',
      location: { name: 'Зал', address: { addressLocality: 'Львів', streetAddress: 'Тестова, 1' } },
      offers: { price: 300, availability: 'https://schema.org/InStock' },
    };
    const json = (value: unknown) =>
      `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            url.includes('/catalog/')
              ? json([
                  event,
                  event,
                  { ...event, url: 'https://concert.ua/old', startDate: '2026-10-01' },
                ])
              : `<h1>Концерт</h1><p>SOLD OUT</p>${json(event)}`,
          ),
      ),
    );
    const result = await collectSource(
      { id: 'concert', name: 'Concert.ua', url: 'https://concert.ua/uk/catalog/lviv' },
      NOW,
      DEFAULT_LEISURE_SETTINGS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: 'sold-out',
      price: { min: 300 },
      address: 'Львів, Тестова, 1',
    });
  });
  it('parses explicit exhibition dates, admission and student notes from an official article', async () => {
    const html =
      '<h1>Виставка</h1>10/10/26 – 08/11/26 Вхід безкоштовний. Потрібна попередня реєстрація. Для студентів 150 грн. Львів, вул. Тестова, 1.';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            url.includes('wp-json')
              ? JSON.stringify([{ link: 'https://www.lvivart.center/events/current/' }])
              : html,
          ),
      ),
    );
    const result = await collectSource(
      {
        id: 'art',
        name: 'Мистецький центр',
        url: 'https://www.lvivart.center/wp-json/wp/v2/events',
      },
      NOW,
      DEFAULT_LEISURE_SETTINGS,
    );
    expect(result[0]).toMatchObject({
      category: 'exhibition',
      registration: true,
      startDate: '2026-10-10',
      endDate: '2026-11-08',
      price: { min: 0 },
    });
    expect(result[0]!.studentNote).toContain('студентів');
  });
  it('finds event dates beyond large style blocks and never displays script content as the event description', () => {
    const raw = articleCandidate(
      `<style>${'x'.repeat(25000)}</style><h1>Виставка</h1><p>15 жовтня 2026</p><script>not visible</script><p>Квиток: 200 грн</p>`,
      'https://lviv.travel/ua/events/show',
      'Lviv.travel',
    );
    expect(raw).toMatchObject({ startDate: '2026-10-15', priceMin: 200 });
  });
  it('contains failed and disallowed redirects without reading an unapproved host', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      collectSource(
        { id: 'jam', name: 'Jam', url: 'https://jamfactory.ua/events/' },
        NOW,
        DEFAULT_LEISURE_SETTINGS,
      ),
    ).rejects.toThrow('source-not-allowed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(new Response('x', { headers: { 'content-length': '2000001' } }));
    await expect(
      collectSource(
        { id: 'jam', name: 'Jam', url: 'https://jamfactory.ua/events/' },
        NOW,
        DEFAULT_LEISURE_SETTINGS,
      ),
    ).rejects.toThrow('source-too-large');
  });
  it('publishes a partial package, deduplicates multiple Places searches and prevents immediate repeated refreshes', async () => {
    const { env, db } = setup();
    const withMaps = workerEnv({ ...env, MAPS_API_KEY: 'test-maps' });
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await refreshLeisureCatalog(withMaps, NOW);
    expect(receipt.message).toBe('Добірку оновлено.');
    expect(maps.search).toHaveBeenCalledTimes(8);
    const workspace = await readLeisureWorkspace(withMaps, NOW);
    expect(workspace.edition.ids).toHaveLength(1);
    expect(workspace.edition.sources.find((s: { id: string }) => s.id === 'places')).toMatchObject({
      status: 'ok',
      count: 1,
    });
    const calls = fetchMock.mock.calls.length;
    await refreshLeisureCatalog(withMaps, NOW + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    maps.search.mockResolvedValue({ source: 'cache', places: [] });
    await refreshLeisureCatalog(withMaps, NOW + 300001);
    expect(
      (await readLeisureWorkspace(withMaps, NOW)).edition.sources.find(
        (s: { id: string }) => s.id === 'places',
      ),
    ).toMatchObject({ status: 'unavailable' });
    db.close();
  });
  it('hands scheduled collection to independent catalogue invocations without making scheduler HTTP requests', async () => {
    const { env, db } = setup();
    const request = vi.fn(async () => ({ message: 'queued' }));
    const configured = workerEnv({ ...env, LEISURE_CATALOG: { getByName: () => ({ request }) } });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await leisureCatalogTask(configured, NOW - 3600000);
    expect(request).toHaveBeenCalledWith('full', NOW - 3600000);
    expect(fetcher).not.toHaveBeenCalled();
    db.close();
  });
  it('keeps Forum and King Cross sessions separate and leaves prices unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const king = url.includes('king-cross'),
          date = new URL(url).searchParams.get('date');
        const start = `${date}T15:00:00.000Z`;
        return new Response(
          `window.__NUXT__=(function(a){return {data:[{movies:[{id:"movie",name:"Фільм",slug:"film",durationInSec:"7200",categories:{genres:[{name:"Пригоди"}]},countries:["UA"],offlineRental:{sessions:[{id:${JSON.stringify(`${king ? 'king' : 'forum'}-${date}`)},startSessionAt:${JSON.stringify(start)},dimensionType:"2D"}]}}]}]}}(null));`,
        );
      }),
    );
    const movies = await collectPlaneta(NOW, { cinemas: ['forum-lviv', 'king-cross'] });
    expect(movies).toHaveLength(1);
    expect(movies[0]!.sessions).toHaveLength(14);
    expect(new Set(movies[0]!.sessions.map((s: { cinemaSlug: string }) => s.cinemaSlug))).toEqual(
      new Set(['forum-lviv', 'king-cross-leopolis']),
    );
    expect(movies[0]!.price.min).toBeNull();
    expect(movies[0]!.genre).toBe('Пригоди');
    expect(movies[0]!.sessions[0]!.url).toContain('/movie/film/?cinema=forum-lviv');
  });
  it('rejects aggregate programme pages masquerading as individual events', () => {
    expect(
      eventCandidate(
        { '@type': 'Event', name: 'Філармонія. Афіша концертів', startDate: '2026-10-12' },
        'Lviv.travel',
        'https://lviv.travel/ua/events/programme',
      ),
    ).toBeNull();
  });
  it('extracts nearby places only from the approved official source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            url.includes('around-lviv')
              ? '<a href="/ua/places/attractions/castle">Замок</a><a href="https://evil.test/ua/places/attractions/trap">Trap</a>'
              : '<h1>Замок</h1><a href="https://maps.google.com/?q=castle">с. Тестове</a>',
          ),
      ),
    );
    const result = await collectNearby(
      {
        name: 'Lviv.travel · поблизу',
        url: 'https://lviv.travel/ua/around-lviv/place-attractions',
      },
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      category: 'trip',
      address: 'с. Тестове',
      price: { min: null },
    });
  });
});
