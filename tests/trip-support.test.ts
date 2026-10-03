import { describe, it, expect } from 'vitest';
import {
  tripDaySchedule,
  tripSupportButtons,
  packingItems,
  outdoorChecklist,
} from '../web/core/trips/support.mjs';
import {
  runTripExpense,
  undoTripExpense,
  tripExpenseSummary,
} from '../web/core/tools/trip-expenses.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const now = Date.parse('2026-10-03T08:00:00Z');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup() {
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql', '0004_ideas_travel.sql']);
  const env = workerEnv({ DB: d1.stub });
  d1.db
    .prepare(
      "INSERT INTO chains (id,kind,state_json,status,created_at,updated_at) VALUES (?, 'trip', ?, 'running','x','x')",
    )
    .run(id, JSON.stringify({ chat_id: 777, thread_id: 'dm' }));
  d1.db.prepare("INSERT INTO trips (id,workflow_id,status) VALUES (?,?,'active')").run(id, id);
  return { env, db: d1.db };
}
describe('trip support cycle', () => {
  it('skips past mornings, names return day and bounds a long trip', () => {
    const points = tripDaySchedule({ date_from: '2026-10-01', date_to: '2026-10-05' }, now);
    expect(points.map((p) => p.day)).toEqual(['2026-10-04', '2026-10-05']);
    expect(points.at(-1)?.returnDay).toBe(true);
    expect(tripDaySchedule({ date_from: '2026-10-04', date_to: '2027-01-01' }, now)).toHaveLength(
      30,
    );
    expect(tripDaySchedule({ date_from: '2026-10-04', date_to: null }, now)).toEqual([]);
  });
  it('builds category navigation within Telegram callback limits', () => {
    const buttons = tripSupportButtons(id).flat();
    expect(buttons).toHaveLength(9);
    expect(buttons.every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
    expect(tripSupportButtons('invalid')).toEqual([]);
  });
  it('packing follows the real transport; hiking does not inherit car maintenance', () => {
    expect(packingItems({ mode: 'plane' }).join(' ')).toContain('багаж');
    expect(packingItems({ mode: 'hike' }).join(' ')).toContain('Офлайн');
    expect(packingItems({ mode: 'car', country: 'Польща' }).join(' ')).toContain('вʼїзду');
    expect(
      outdoorChecklist('outdoor')
        ?.t1.map((i) => i.text)
        .join(' '),
    ).not.toContain('Заправ');
    expect(outdoorChecklist('ua-car')).toBeNull();
  });
});
describe('explicit trip expense ledger', () => {
  it('does not overwrite storage when the compare-and-swap loses every retry', async () => {
    const { env, db } = setup();
    const initial = JSON.stringify({
      entries: [{ id: 'saved-0001', minor: 100, currency: 'UAH' }],
    });
    db.prepare('UPDATE trips SET cost_json=?').run(initial);
    db.exec(
      'CREATE TRIGGER lose_cost_update BEFORE UPDATE OF cost_json ON trips BEGIN SELECT RAISE(IGNORE); END;',
    );
    await expect(
      runTripExpense(env, { trip_id: id, amount: 250 }, now, { chatId: 777 }),
    ).rejects.toThrow('паралельно');
    await expect(undoTripExpense(env, { trip_id: id, entry_id: 'saved-0001' })).rejects.toThrow(
      'безпечно',
    );
    expect(
      (db.prepare('SELECT cost_json FROM trips').get() as { cost_json: string }).cost_json,
    ).toBe(initial);
  });
  it('requires a trusted chat and validates currency, category, id and stored data', async () => {
    const { env, db } = setup();
    const args = { trip_id: id, amount: 250 };
    await expect(runTripExpense(env, args, now, {})).rejects.toThrow('чат');
    await expect(
      undoTripExpense(workerEnv({ DB: undefined }), { trip_id: id, entry_id: 'missing-001' }),
    ).rejects.toThrow('недоступне');
    for (const patch of [
      { amount: NaN },
      { amount: 0.001 },
      { amount: 100000001 },
      { currency: 'x' },
      { category: 'bogus' },
      { entry_id: 'bad' },
    ]) {
      await expect(
        runTripExpense(env, { ...args, ...patch }, now, { chatId: 777 }),
      ).rejects.toThrow();
    }
    db.prepare('UPDATE trips SET cost_json=?').run('[]');
    await expect(runTripExpense(env, args, now, { chatId: 777 })).rejects.toThrow('пошкоджений');
    db.prepare('UPDATE trips SET cost_json=?').run(
      JSON.stringify({ entries: Array.from({ length: 200 }, (_, i) => ({ id: `entry-${i}` })) }),
    );
    await expect(runTripExpense(env, args, now, { chatId: 777 })).rejects.toThrow('200 витрат');
    await undoTripExpense(env, { trip_id: 'missing', entry_id: 'missing-001' });
    expect(tripExpenseSummary(null).totals_minor_by_currency).toEqual({});
    expect(
      tripExpenseSummary(
        JSON.stringify({
          entries: [{}, null, { minor: -1, currency: 'USD' }, { minor: 1, currency: 'bad' }],
        }),
      ).entries,
    ).toEqual([]);
  });
  it('records named expenses, deduplicates retries and keeps currencies separate', async () => {
    const { env, db } = setup();
    const args = {
      trip_id: id,
      amount: 250,
      currency: 'UAH',
      category: 'food',
      note: 'Обід',
      entry_id: 'lunch-0001',
    };
    await runTripExpense(env, args, now, { chatId: 777, threadId: 'dm' });
    const retry = await runTripExpense(env, args, now + 1, { chatId: 777 });
    expect(retry.result.already_recorded).toBe(true);
    await runTripExpense(
      env,
      { ...args, amount: 10, currency: 'EUR', entry_id: 'lunch-0002' },
      now,
      { chatId: 777 },
    );
    const row = db.prepare('SELECT cost_json FROM trips WHERE id=?').get(id) as {
      cost_json: string;
    };
    expect(tripExpenseSummary(row.cost_json).totals_minor_by_currency).toEqual({
      UAH: 25000,
      EUR: 1000,
    });
    expect(tripExpenseSummary(row.cost_json).complete).toBe(false);
    await expect(
      runTripExpense(env, { ...args, amount: 251 }, now, { chatId: 777 }),
    ).rejects.toThrow('іншу витрату');
  });
  it('refuses foreign chats, invalid amounts and cancelled trips', async () => {
    const { env, db } = setup();
    const args = { trip_id: id, amount: 250 };
    await expect(runTripExpense(env, args, now, { chatId: 778 })).rejects.toThrow('іншому чату');
    await expect(
      runTripExpense(env, { ...args, amount: -1 }, now, { chatId: 777 }),
    ).rejects.toThrow('суму');
    db.prepare("UPDATE trips SET status='cancelled'").run();
    await expect(runTripExpense(env, args, now, { chatId: 777 })).rejects.toThrow('скасовано');
  });
  it('undo removes only its own entry and preserves subsequent expenses and owner totals', async () => {
    const { env, db } = setup();
    db.prepare('UPDATE trips SET cost_json=?').run(
      JSON.stringify({ actual: { minor: 100000, currency: 'UAH' } }),
    );
    const first = await runTripExpense(
      env,
      { trip_id: id, amount: 250, entry_id: 'first-0001' },
      now,
      { chatId: 777 },
    );
    await runTripExpense(env, { trip_id: id, amount: 500, entry_id: 'second-0002' }, now, {
      chatId: 777,
    });
    await undoTripExpense(env, first.prev!);
    await undoTripExpense(env, first.prev!);
    const row = db.prepare('SELECT cost_json FROM trips').get() as { cost_json: string };
    expect(JSON.parse(row.cost_json).actual.minor).toBe(100000);
    expect(tripExpenseSummary(row.cost_json).totals_minor_by_currency).toEqual({ UAH: 50000 });
  });
  it('does not disguise corrupt storage as a zero expense total', () => {
    expect(tripExpenseSummary('broken').note).toContain('не вдалося прочитати');
  });
});
