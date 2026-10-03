import { describe, it, expect, vi, afterEach } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import {
  normalizedTripLeg,
  runTripWorkspace,
  undoTripWorkspace,
  itineraryWarnings,
  commonTripPattern,
  tripWorkspaceView,
} from '../web/core/tools/trip-workspace.mjs';
import { tripInstant, tripLocalParts, tripSlot } from '../web/core/trips/time.mjs';
import * as maps from '../web/core/adapters/maps.mjs';
import { tripLocalSchedule } from '../web/core/trips/support.mjs';
import { tripMonitorTask, tripWeatherWarnings } from '../web/core/trips/monitor.mjs';
import { tripExpenseSummary, runTripExpense } from '../web/core/tools/trip-expenses.mjs';

const NOW = Date.parse('2026-10-03T08:00:00Z');
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CTX = { chatId: 777, threadId: 'dm' };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('travel edge cases and recovery', () => {
  it('restores itinerary versions while retaining impressions and unrelated expenses', async () => {
    const { call, read, env } = setup();
    await call('leg', leg);
    await call('leg', { ...leg, title: 'Другий варіант' });
    await call('place', { title: 'Парк', category: 'nature', note: 'після музею' });
    await call('restore_revision', { revision: 1 });
    expect(read().travel.legs[0].title).toBe(leg.title);
    expect(read().travel.places).toHaveLength(1);
    await call('remove_leg', { id: leg.id });
    expect(read().travel.legs).toHaveLength(0);
    await expect(call('remove_leg', { id: leg.id })).rejects.toThrow('відсутній');
    await expect(call('restore_revision', { revision: 999 })).rejects.toThrow('недоступна');
    await expect(call('place', { status: 'nonsense' })).rejects.toThrow('стан');
    await expect(call('place', {})).rejects.toThrow('Назви');
    await expect(call('review', { date: '2026-11-01', note: 'пізніше' })).rejects.toThrow('поза');
    await expect(call('review', { date: 'bad', note: 'текст' })).rejects.toThrow('день');
    await expect(call('monitor', { enabled: 'yes' })).rejects.toThrow('Підтвердь');
    await expect(
      call('monitor', { enabled: true, consent: true, interval_hours: 1 }),
    ).rejects.toThrow('Інтервал');
    await expect(call('bad', {})).rejects.toThrow('Невідома');
    await expect(
      runTripWorkspace(workerEnv({ DB: undefined }), { trip_id: ID, op: 'get' }, NOW, CTX),
    ).rejects.toThrow('недоступне');
    await expect(runTripWorkspace(env, { trip_id: ID, op: 'get' }, NOW, {})).rejects.toThrow('чат');
    expect(tripWorkspaceView('[]')).toMatchObject({ unavailable: true });
    expect(tripWorkspaceView(null)).toMatchObject({ revision: 0, history: [] });
    expect(tripSlot('2026-10-25', '02:30', 'Europe/Vienna')).toBeNull();
    expect(() => tripInstant('not a time', 'Europe/Vienna')).toThrow('форматі');
    expect(() => normalizedTripLeg({ ...leg, mode: 'teleport' })).toThrow('транспорт');
    expect(() => normalizedTripLeg({ ...leg, title: '' })).toThrow('Назви');
    expect(() => normalizedTripLeg({ ...leg, id: 'x' })).toThrow('запис');
  });
  it('bounds the ledger and journals, and fails closed on failed compare-and-swap', async () => {
    const { db, call, env } = setup();
    db.prepare('UPDATE trips SET cost_json=?').run(
      JSON.stringify({
        travel: { legs: Array.from({ length: 80 }, (_, i) => ({ id: `leg-${i}` })) },
      }),
    );
    await expect(call('leg', leg)).rejects.toThrow('80 етапів');
    db.prepare('UPDATE trips SET cost_json=?').run(
      JSON.stringify({
        travel: { places: Array.from({ length: 120 }, (_, i) => ({ id: `place-${i}` })) },
      }),
    );
    await expect(call('place', { title: 'Ще один' })).rejects.toThrow('120 місць');
    db.prepare('UPDATE trips SET cost_json=?').run('{}');
    const result = await call('place', { id: 'place-undo', title: 'Парк' });
    db.exec(
      'CREATE TRIGGER reject_travel BEFORE UPDATE OF cost_json ON trips BEGIN SELECT RAISE(IGNORE); END;',
    );
    await expect(call('place', { title: 'Ще один' })).rejects.toThrow('паралельно');
    await expect(undoTripWorkspace(env, result.prev)).rejects.toThrow('безпечно');
    await undoTripWorkspace(env, { trip_id: 'missing', facet: 'places', after: [] });
    await expect(undoTripWorkspace(workerEnv({ DB: undefined }), result.prev)).rejects.toThrow(
      'недоступне',
    );
  });
  it('requires consent and enough scoped completed history before deriving a reusable pattern', async () => {
    const { call, db } = setup();
    for (let i = 0; i < 3; i++) {
      const id = `history-${i}`;
      db.prepare(
        "INSERT INTO chains(id,kind,state_json,status,created_at,updated_at) VALUES (?,'trip',?,'done','x','x')",
      ).run(
        id,
        JSON.stringify({
          chat_id: 777,
          mode: 'car',
          purpose: 'дозвілля',
          preferences: { food_preference: 'місцеве' },
        }),
      );
      db.prepare(
        "INSERT INTO trips(id,workflow_id,status,date_from) VALUES (?,?,'done','2026-01-01')",
      ).run(id, id);
    }
    expect((await call('learn', { consent: true })).result).toMatchObject({
      pattern: { samples: 3, answers: { mode: 'car', food_preference: 'місцеве' } },
    });
  });
  it('rejects invalid bank data and restores a link without duplicating entries', async () => {
    const { call, db, env, read } = setup();
    await expect(call('link_transaction', {})).rejects.toThrow('операцію');
    await expect(call('unlink_transaction', { transaction_id: 'missing' })).rejects.toThrow(
      'не прив',
    );
    await expect(call('link_transaction', { transaction_id: 'missing' })).rejects.toThrow('немає');
    db.prepare(
      "INSERT INTO transactions(id,at,amount,currency) VALUES ('income','x',100,'UAH'),('expense','x',-100,'UAH')",
    ).run();
    await expect(call('link_transaction', { transaction_id: 'income' })).rejects.toThrow('немає');
    await expect(
      call('link_transaction', { transaction_id: 'expense', entry_id: 'missing' }),
    ).rejects.toThrow('Ручний');
    const linked = await call('link_transaction', { transaction_id: 'expense' });
    await undoTripWorkspace(env, linked.prev);
    expect(read().entries).toEqual([]);
  });
});

describe('monitor provider degradation and quotas', () => {
  it('checks a named car leg and distinguishes route estimates from live transport status', async () => {
    const { call, env } = setup();
    await call('leg', {
      ...leg,
      mode: 'car',
      start: '2026-10-03T12:00',
      end: '2026-10-03T13:00',
      start_zone: 'Europe/Vienna',
    });
    await call('monitor', { enabled: true, consent: true, weather: false, road: true });
    const route = vi.fn(async () => ({
      duration_min: 120,
      distance_m: 10000,
      duration_s: 7200,
      mode: 'car',
      traffic: true,
    }));
    expect(await tripMonitorTask(env, NOW, { route })).toEqual({ checked: 1, sent: 1 });
    expect(route).toHaveBeenCalledOnce();
    const second = setup();
    await second.call('leg', {
      ...leg,
      start: '2026-10-03T12:00',
      end: '2026-10-03T13:00',
      start_zone: 'Europe/Vienna',
      source_url: 'https://example.com/train',
    });
    await second.call('monitor', { enabled: true, consent: true, weather: false, service: true });
    expect(await tripMonitorTask(second.env, NOW)).toEqual({ checked: 1, sent: 1 });
    const msg = second.db.prepare('SELECT payload_json FROM outbox').get() as {
      payload_json: string;
    };
    expect(msg.payload_json).toContain('live-статусу');
  });
  it('enforces the daily alert cap and stops checks when disabled during a request', async () => {
    const { call, env, read, db } = setup();
    await call('monitor', { enabled: true, consent: true });
    for (let i = 0; i < 3; i++) {
      const result = await tripMonitorTask(env, NOW + i * 6 * 3600000, {
        weather: async () => [`Погода ${i}`],
      });
      expect(result.sent).toBe(i < 2 ? 1 : 0);
    }
    expect(read().travel.monitor_tick.alerts).toBe(2);
    const costs = read();
    costs.travel.monitor_tick = { day: '2026-10-03', checks: 4 };
    db.prepare('UPDATE trips SET cost_json=?').run(JSON.stringify(costs));
    expect(await tripMonitorTask(env, NOW, { weather: async () => ['зайве'] })).toEqual({
      checked: 0,
      sent: 0,
    });
    expect(await tripMonitorTask(workerEnv({ DB: undefined }), NOW)).toEqual({
      checked: 0,
      sent: 0,
    });
    costs.travel.monitor_tick = {};
    db.prepare('UPDATE trips SET cost_json=?').run(JSON.stringify(costs));
    expect(
      await tripMonitorTask(env, NOW, {
        weather: async () => {
          await call('monitor', { enabled: false });
          return ['недоречне'];
        },
      }),
    ).toEqual({ checked: 1, sent: 0 });
  });
  it('uses shared weather quota and never reports provider failure as a travel incident', async () => {
    vi.spyOn(maps, 'geocodeAddress').mockResolvedValue({ found: true, lat: 48, lon: 16 } as never);
    const { call, env, db, read } = setup();
    await call('monitor', { enabled: true, consent: true });
    env.WEATHER_API_KEY = 'test-weather-key';
    const quota = vi.fn(async () => ({ ok: true }));
    env.WEATHER_QUOTA = { getByName: () => ({ consume: quota }) } as never;
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ daily: [{ dt: NOW / 1000, wind_gust: 25 }] })),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await tripMonitorTask(env, NOW)).toEqual({ checked: 1, sent: 1 });
    expect(quota).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    const reset = () => {
      const costs = read();
      delete costs.travel.monitor_tick;
      db.prepare('UPDATE trips SET cost_json=?').run(JSON.stringify(costs));
    };
    reset();
    quota.mockResolvedValue({ ok: false });
    expect(await tripMonitorTask(env, NOW)).toEqual({ checked: 1, sent: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
    reset();
    quota.mockResolvedValue({ ok: true });
    fetcher.mockResolvedValue(new Response('provider failure', { status: 500 }));
    expect(await tripMonitorTask(env, NOW)).toEqual({ checked: 1, sent: 0 });
    reset();
    delete env.WEATHER_API_KEY;
    expect(await tripMonitorTask(env, NOW)).toEqual({ checked: 1, sent: 0 });
    expect(tripWeatherWarnings({}, NOW, 'Europe/Vienna')).toEqual([]);
  });
});
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0004_ideas_travel.sql',
    '0005_finance.sql',
  ]);
  const env = workerEnv({ DB: d1.stub });
  d1.db
    .prepare(
      "INSERT INTO chains(id,kind,state_json,status,created_at,updated_at) VALUES (?,'trip',?,'running','x','x')",
    )
    .run(
      ID,
      JSON.stringify({ chat_id: 777, mode: 'train', preferences: { timezone: 'Europe/Vienna' } }),
    );
  d1.db
    .prepare(
      "INSERT INTO trips(id,workflow_id,to_text,date_from,date_to,status) VALUES (?,?,'Відень','2026-10-03','2026-10-05','active')",
    )
    .run(ID, ID);
  const call = (op: string, data: Record<string, unknown> = {}, expected_revision?: number) =>
    runTripWorkspace(env, { trip_id: ID, op, data, expected_revision }, NOW, CTX);
  const read = () =>
    JSON.parse(
      (d1.db.prepare('SELECT cost_json FROM trips WHERE id=?').get(ID) as { cost_json: string })
        .cost_json ?? '{}',
    );
  return { ...d1, env, call, read };
}
const leg = {
  id: 'travel-0001',
  kind: 'travel',
  mode: 'train',
  title: 'Потяг до Відня',
  start: '2026-10-04T09:00',
  end: '2026-10-04T12:00',
  start_zone: 'Europe/Kyiv',
  end_zone: 'Europe/Vienna',
  from: 'Львів',
  to: 'Відень',
};

describe('trip local time and itinerary', () => {
  it('computes actual elapsed time across zones and DST', () => {
    expect(normalizedTripLeg(leg).end_ms - normalizedTripLeg(leg).start_ms).toBe(4 * 3600000);
    expect(
      tripLocalParts(tripInstant('2026-10-04T09:00', 'Europe/Vienna'), 'Europe/Vienna').clock,
    ).toBe('09:00');
    expect(() => tripInstant('2026-03-29T02:30', 'Europe/Vienna')).toThrow('повторюється');
    expect(() => tripInstant('2026-10-25T02:30', 'Europe/Vienna')).toThrow('повторюється');
    expect(() => tripInstant('2026-02-30T09:00', 'Europe/Vienna')).toThrow('дати');
    expect(() => tripInstant('2026-10-04T09:00', 'Not/AZone')).toThrow('пояс');
    expect(() => normalizedTripLeg({ ...leg, end: '2026-10-04T07:00' })).toThrow('після');
  });
  it('warns about short transfers and conflicts without inventing a booking', () => {
    const first = normalizedTripLeg(leg);
    const second = normalizedTripLeg({
      ...leg,
      id: 'travel-0002',
      start: '2026-10-04T12:15',
      end: '2026-10-04T13:00',
      start_zone: 'Europe/Vienna',
      transfer_minutes: 30,
    });
    expect(itineraryWarnings([first, second]).join(' ')).toContain('Замалий запас');
    expect(itineraryWarnings([first, { ...second, start_ms: first.start_ms }]).join(' ')).toContain(
      'Накладення',
    );
    expect(
      itineraryWarnings([first, { ...second, start_ms: first.start_ms, parallel: true }]).join(' '),
    ).not.toContain('Накладення');
    expect(first.booked).toBe(false);
    expect(() => normalizedTripLeg({ ...leg, source_url: 'http://example.com' })).toThrow('HTTPS');
    expect(() => normalizedTripLeg({ ...leg, transfer_minutes: -1 })).toThrow('хвилинах');
    const points = tripLocalSchedule(
      {
        date_from: '2026-10-04',
        date_to: '2026-10-04',
        preferences: { timezone: 'Europe/Vienna' },
      },
      NOW,
    );
    expect(points.map((p) => new Date(p.at).toISOString())).toEqual([
      '2026-10-04T07:00:00.000Z',
      '2026-10-04T18:30:00.000Z',
    ]);
    expect(tripLocalSchedule({ date_from: '2026-10-04', date_to: null }, NOW)).toEqual([]);
  });
  it('versions edits, rejects stale revisions and preserves concurrent expenses on undo', async () => {
    const { call, read, env } = setup();
    const a = await call('leg', leg, 0);
    expect(a.result).toMatchObject({ revision: 1 });
    await expect(call('remove_leg', { id: leg.id }, 0)).rejects.toThrow('змінився');
    await runTripExpense(env, { trip_id: ID, amount: 250, entry_id: 'manual-0001' }, NOW, CTX);
    await undoTripWorkspace(env, a.prev);
    expect(read().entries).toHaveLength(1);
    expect(read().travel.legs).toBeNull();
    const b = await call('leg', leg);
    await call('leg', { ...leg, title: 'Змінений потяг' });
    await expect(undoTripWorkspace(env, b.prev)).rejects.toThrow('не перезапише');
    await expect(
      runTripWorkspace(env, { trip_id: ID, op: 'get' }, NOW, { chatId: 999 }),
    ).rejects.toThrow('іншому чату');
    await expect(call('monitor', { enabled: true })).rejects.toThrow('згода');
  });
});

describe('trip journals and explicit learning', () => {
  it('updates a place rather than duplicating it, and stores daily impressions', async () => {
    const { call, read } = setup();
    await call('place', {
      id: 'place-0001',
      title: 'Музей',
      status: 'saved',
      url: 'https://example.com',
    });
    await call('place', { id: 'place-0001', status: 'visited' });
    await call('review', { date: '2026-10-03', note: 'Музей сподобався', unfinished: 'Парк' });
    await call('review', { date: '2026-10-03', note: 'Музей і парк' });
    expect(read().travel.places).toHaveLength(1);
    expect(read().travel.places[0].status).toBe('visited');
    expect(read().travel.reviews).toHaveLength(1);
    await expect(call('review', { date: '2026-10-03' })).rejects.toThrow('враження');
  });
  it('does not derive habits from one trip or a split preference', async () => {
    expect(commonTripPattern([{ mode: 'car' }])).toBeNull();
    expect(commonTripPattern([{ mode: 'car' }, { mode: 'car' }, { mode: 'train' }])).toBeNull();
    expect(commonTripPattern([{ mode: 'car' }, { mode: 'car' }, { mode: 'car' }])?.answers).toEqual(
      { mode: 'car' },
    );
    const { call } = setup();
    await expect(call('learn', { consent: true })).rejects.toThrow('трьох');
    await expect(call('learn', {})).rejects.toThrow('згодою');
  });
});

describe('bank reconciliation', () => {
  it('links a manual expense without double counting; unlink preserves it', async () => {
    const { call, env, db, read } = setup();
    db.prepare(
      "INSERT INTO transactions(id,at,amount,currency,description) VALUES ('tx1','x',-25000,'UAH','Обід')",
    ).run();
    await runTripExpense(env, { trip_id: ID, amount: 250, entry_id: 'manual-0001' }, NOW, CTX);
    await expect(call('link_transaction', { transaction_id: 'tx1' })).rejects.toThrow('ручна');
    const linked = await call('link_transaction', {
      transaction_id: 'tx1',
      entry_id: 'manual-0001',
    });
    expect(tripExpenseSummary(JSON.stringify(read())).totals_minor_by_currency).toEqual({
      UAH: 25000,
    });
    expect((await call('link_transaction', { transaction_id: 'tx1' })).result).toMatchObject({
      already_recorded: true,
    });
    await call('unlink_transaction', { transaction_id: 'tx1' });
    expect(read().entries).toHaveLength(1);
    await expect(undoTripWorkspace(env, linked.prev)).rejects.toThrow('змінено');
  });
  it('rejects another trip claiming the same transaction and does not mutate bank data', async () => {
    const { call, db, read } = setup();
    db.prepare(
      "INSERT INTO transactions(id,at,amount,currency) VALUES ('tx2','x',-500,'EUR')",
    ).run();
    await call('link_transaction', { transaction_id: 'tx2' });
    expect(read().entries[0].minor).toBe(500);
    db.prepare("INSERT INTO trips(id,cost_json,status) VALUES ('other',?,'done')").run(
      JSON.stringify({ entries: [{ id: 'some-0001', transaction_id: 'tx3' }] }),
    );
    db.prepare(
      "INSERT INTO transactions(id,at,amount,currency) VALUES ('tx3','x',-200,'EUR')",
    ).run();
    await expect(call('link_transaction', { transaction_id: 'tx3' })).rejects.toThrow('іншій');
    expect(db.prepare("SELECT amount FROM transactions WHERE id='tx2'").get()).toEqual({
      amount: -500,
    });
    await call('unlink_transaction', { transaction_id: 'tx2' });
    expect(read().entries).toHaveLength(0);
  });
});

describe('bounded opt-in monitoring', () => {
  it('deduplicates alerts, respects quiet hours and queues atomically', async () => {
    const { env, db, call, read } = setup();
    let requests = 0;
    const deps = {
      weather: async () => {
        requests++;
        return ['Сильний вітер'];
      },
    };
    expect(await tripMonitorTask(env, NOW, deps)).toEqual({ checked: 0, sent: 0 });
    await call('monitor', { enabled: true, consent: true, timezone: 'Europe/Vienna' });
    expect(await tripMonitorTask(env, NOW, deps)).toEqual({ checked: 1, sent: 1 });
    expect(await tripMonitorTask(env, NOW + 1000, deps)).toEqual({ checked: 0, sent: 0 });
    expect(await tripMonitorTask(env, NOW + 6 * 3600000, deps)).toEqual({ checked: 1, sent: 0 });
    expect(requests).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
    expect(await tripMonitorTask(env, Date.parse('2026-10-03T22:00:00Z'), deps)).toEqual({
      checked: 0,
      sent: 0,
    });
    expect(read().travel.monitor_tick.alerts).toBe(1);
    await call('monitor', { enabled: false });
    expect(await tripMonitorTask(env, NOW + 24 * 3600000, deps)).toEqual({ checked: 0, sent: 0 });
  });
  it('cancellation during network calls prevents delivery', async () => {
    const { env, db, call } = setup();
    await call('monitor', { enabled: true, consent: true });
    const deps = {
      weather: async () => {
        db.prepare("UPDATE trips SET status='cancelled'").run();
        return ['Дощ'];
      },
    };
    expect(await tripMonitorTask(env, NOW, deps)).toEqual({ checked: 1, sent: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  });
  it('uses source thresholds and ignores expired warnings', () => {
    const data = {
      alerts: [
        { start: NOW / 1000 - 100, end: NOW / 1000 - 1, event: 'old' },
        { start: NOW / 1000, end: NOW / 1000 + 100, event: 'Storm', sender_name: 'Service' },
      ],
      daily: [{ dt: NOW / 1000, wind_gust: 20, rain: 25, temp: { max: 40 } }],
    };
    const warnings = tripWeatherWarnings(data, NOW, 'Europe/Vienna');
    expect(warnings).toHaveLength(4);
    expect(warnings.join(' ')).not.toContain('old');
  });
});
