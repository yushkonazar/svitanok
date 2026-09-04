// Сховище плану дня (етап 3 PR-8, 07 §1 day_plans/plan_items): налаштування
// з facts, upsert дня, пункти з розкладки, прийняття з нагадуваннями (T0) і
// відкат, зміни вдень і відкат, огляд і перенос із «третім днем». Реальні
// міграції у node:sqlite.

import { describe, it, expect } from 'vitest';
import {
  readDayPlanConfig,
  getDayPlan,
  upsertDayPlan,
  listItems,
  normalizeItem,
  replaceItems,
  acceptPlan,
  undoAccept,
  updateItems,
  undoUpdateItems,
  reviewPlan,
  carryItems,
  carriedInto,
  nextPlannedDay,
  kyivMs,
  ITEMS_MAX,
} from '../web/core/day-plan/store.mjs';
import { computeSlots } from '../web/core/day-plan/slots.mjs';
import { runFactsSet } from '../web/core/tools/facts.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0005_finance.sql',
  '0006_inbox_collections.sql',
  '0007_instructions_plans.sql',
  '0008_fts.sql',
  '0009_voice.sql',
  '0010_reminders_address.sql',
];
// Неділя 06.09.2026 18:00 Києва.
const NOW = Date.parse('2026-09-06T15:00:00.000Z');
const DATE = '2026-09-07';

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map()),
    TELEGRAM_CHAT_ID: '555',
    TOPIC_ASSISTANT: '99',
  });
  return { d1, env, db: d1.db };
}

async function seedDraft(env: Env, titles: string[]) {
  const items = titles.map((t, i) => normalizeItem({ title: t, kind: 'routine', est_min: 30 }, i));
  const slots = computeSlots({ date: DATE, items, events: [] });
  await upsertDayPlan(env, DATE, { status: 'draft' }, NOW);
  await replaceItems(env, DATE, slots, items);
  return items;
}

describe('readDayPlanConfig', () => {
  it('без факту day_plan - вимкнено з дефолтами; з фактом - enabled, свої часи, звички', async () => {
    const { env } = setup();
    const off = await readDayPlanConfig(env);
    expect(off.enabled).toBe(false);
    expect(off.settings).toMatchObject({
      intent_at: '20:30',
      morning_at: '08:30',
      fill_ratio: 0.6,
    });
    expect([...off.weekdays].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(off.habits).toMatchObject({ day_start: '08:00', estimate_bias: 1.3 });

    await runFactsSet(
      env,
      {
        kind: 'setting',
        key: 'day_plan',
        value: {
          enabled: true,
          intent_at: '21:00',
          weekdays: 'пн-сб',
          max_deep: 2,
          fill_ratio: 0.5,
        },
        source: 'owner',
      },
      NOW,
    );
    await runFactsSet(
      env,
      { kind: 'habit', key: 'day_start', value: '09:00', source: 'owner' },
      NOW,
    );
    await runFactsSet(
      env,
      { kind: 'habit', key: 'lunch_at', value: '25:99', source: 'owner' },
      NOW,
    );
    await runFactsSet(
      env,
      { kind: 'habit', key: 'estimate_bias', value: 1.5, source: 'owner' },
      NOW,
    );
    const on = await readDayPlanConfig(env);
    expect(on.enabled).toBe(true);
    expect(on.settings).toMatchObject({ intent_at: '21:00', max_deep: 2, fill_ratio: 0.5 });
    expect(on.weekdays.has(6)).toBe(true);
    // Крива звичка - дефолт, а не «25:99» у розкладці.
    expect(on.habits).toMatchObject({ day_start: '09:00', lunch_at: '13:00', estimate_bias: 1.5 });

    await runFactsSet(
      env,
      { kind: 'setting', key: 'day_plan', value: { enabled: false }, source: 'owner' },
      NOW + 1,
    );
    expect((await readDayPlanConfig(env)).enabled).toBe(false);
  });
});

describe('день і пункти', () => {
  it('upsertDayPlan: створює, оновлює лише передані поля, невідомий статус - помилка', async () => {
    const { env } = setup();
    expect(await getDayPlan(env, DATE)).toBeNull();
    await upsertDayPlan(env, DATE, { status: 'intent', intent_text: 'банк, пошта' }, NOW);
    await upsertDayPlan(env, DATE, { status: 'draft', fill_ratio: 0.6 }, NOW + 1);
    const row = await getDayPlan(env, DATE);
    expect(row).toMatchObject({ status: 'draft', intent_text: 'банк, пошта', fill_ratio: 0.6 });
    expect(row?.created_at).toBe(new Date(NOW).toISOString());
    await expect(upsertDayPlan(env, DATE, { status: 'готово' }, NOW)).rejects.toThrow(
      'невідомий статус',
    );
  });

  it('normalizeItem: kind зі списку, title ≤ 60, est ≥ 5, hard_at HH:MM, порожня назва - помилка', () => {
    const it1 = normalizeItem(
      { title: ' Презентація ', kind: 'deep', est_min: '90', hard_at: '9:00', deadline: 'скоро' },
      0,
    );
    expect(it1).toMatchObject({ title: 'Презентація', kind: 'deep', est_min: 90, hard_at: '9:00' });
    expect(it1.deadline).toBeNull();
    expect(normalizeItem({ title: 'x', kind: 'дивне', est_min: 2 }, 0)).toMatchObject({
      kind: 'routine',
      est_min: null,
    });
    expect(normalizeItem({ title: 'а'.repeat(80) }, 0).title).toHaveLength(60);
    expect(() => normalizeItem({ title: '  ' }, 2)).toThrow('пункт 3: порожня назва');
    expect(ITEMS_MAX).toBe(6);
  });

  it('replaceItems: placed із вікнами, flexible без; рядки з reminder_id не чіпає', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, reminder_id) VALUES ('keep', ?, 'Зі старим нагадуванням', 'planned', 'rem-1')`,
    ).run(DATE);
    const items = [
      normalizeItem({ title: 'Презентація', kind: 'deep', est_min: 60 }, 0),
      normalizeItem({ title: 'Марафон', kind: 'deep', est_min: 600 }, 1),
    ];
    const slots = computeSlots({ date: DATE, items, events: [] });
    expect(await replaceItems(env, DATE, slots, items)).toBe(2);
    const rows = await listItems(env, DATE);
    expect(rows.map((r) => r.title).sort()).toEqual([
      'Зі старим нагадуванням',
      'Марафон',
      'Презентація',
    ]);
    expect(rows.find((r) => r.title === 'Презентація')).toMatchObject({
      window_start: '08:00',
      window_end: '09:20',
      flexible: 0,
      status: 'planned',
    });
    expect(rows.find((r) => r.title === 'Марафон')).toMatchObject({
      window_start: null,
      flexible: 1,
    });
    // Повторна розкладка прибирає лише «свої» рядки.
    await replaceItems(env, DATE, computeSlots({ date: DATE, items: [items[0]!], events: [] }), [
      items[0]!,
    ]);
    expect((await listItems(env, DATE)).map((r) => r.id).sort()).toEqual(
      [items[0]!.id, 'keep'].sort(),
    );
  });
});

describe('прийняття, зміни, огляд', () => {
  it('acceptPlan: нагадування на початок блоків із часом (T0), статус accepted; undoAccept скасовує', async () => {
    const { env, db } = setup();
    const items = await seedDraft(env, ['Презентація', 'Банк']);
    db.prepare(
      `UPDATE plan_items SET window_start = NULL, window_end = NULL, flexible = 1 WHERE id = ?`,
    ).run(items[1]!.id);
    const res = await acceptPlan(env, DATE, NOW, { chatId: '555', threadId: '99' });
    expect(res).toMatchObject({ date: DATE, reminders: 1 });
    const rem = db.prepare(`SELECT id, text, due_at, status FROM reminders`).all() as {
      id: string;
      text: string;
      due_at: string;
      status: string;
    }[];
    expect(rem).toHaveLength(1);
    expect(rem[0]).toMatchObject({ text: 'План: Презентація', status: 'pending' });
    expect(Date.parse(rem[0]!.due_at)).toBe(kyivMs(DATE, '08:00'));
    expect((await listItems(env, DATE)).find((r) => r.title === 'Презентація')?.reminder_id).toBe(
      rem[0]!.id,
    );
    expect((await getDayPlan(env, DATE))?.status).toBe('accepted');

    await undoAccept(env, res, NOW + 1000);
    expect(db.prepare(`SELECT status FROM reminders`).get()).toEqual({ status: 'cancelled' });
    expect((await listItems(env, DATE)).every((r) => r.reminder_id == null)).toBe(true);
    expect((await getDayPlan(env, DATE))?.status).toBe('draft');
  });

  it('acceptPlan: блок, чий час уже минув, нагадування не отримує', async () => {
    const { env, db } = setup();
    await seedDraft(env, ['Ранкове']);
    // «Зараз» - уже після 08:00 того дня.
    const late = kyivMs(DATE, '12:00') ?? 0;
    const res = await acceptPlan(env, DATE, late, { chatId: '555', threadId: '99' });
    expect(res.reminders).toBe(0);
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 0 });
  });

  it('updateItems: done/moves/drop за id, префіксом або назвою; знімок для undo; порожньо - помилка', async () => {
    const { env } = setup();
    const items = await seedDraft(env, ['Презентація', 'Банк', 'Пошта']);
    const out = await updateItems(
      env,
      DATE,
      {
        done: ['презентація'],
        moves: [{ id: items[1]!.id.slice(0, 8), to: '16:00' }],
        drop: [items[2]!.id],
      },
      NOW,
    );
    expect(out.changed).toBe(3);
    const rows = await listItems(env, DATE);
    expect(rows.find((r) => r.title === 'Презентація')).toMatchObject({
      status: 'done',
      done_at: new Date(NOW).toISOString(),
    });
    // est_min у рядку - довжина блоку вже з запасом (30 × 1,3 → 40).
    expect(rows.find((r) => r.title === 'Банк')).toMatchObject({
      window_start: '16:00',
      window_end: '16:40',
      flexible: 0,
    });
    expect(rows.find((r) => r.title === 'Пошта')?.status).toBe('skipped');

    await undoUpdateItems(env, out);
    const back = await listItems(env, DATE);
    expect(back.every((r) => r.status === 'planned' && r.done_at == null)).toBe(true);
    expect(back.find((r) => r.title === 'Банк')?.window_start).not.toBe('16:00');

    await expect(updateItems(env, DATE, {}, NOW)).rejects.toThrow('нічого змінювати');
    await expect(updateItems(env, DATE, { done: ['Немає такого'] }, NOW)).rejects.toThrow(
      'у плані 2026-09-07 немає',
    );
    await expect(
      updateItems(env, DATE, { moves: [{ id: items[0]!.id, to: '16' }] }, NOW),
    ).rejects.toThrow('очікую HH:MM');
  });

  it('reviewPlan + carryItems: відкриті → carried, копії на наступний день із carried_from; третій день - stale', async () => {
    const { env, db } = setup();
    const items = await seedDraft(env, ['Презентація', 'Банк', 'Пошта']);
    await updateItems(env, DATE, { done: [items[0]!.id], drop: [items[2]!.id] }, NOW);
    // Банк уже їхав з пʼятниці: на вівторок це 4-й день.
    db.prepare(`UPDATE plan_items SET carried_from = '2026-09-04' WHERE id = ?`).run(items[1]!.id);

    const review = await reviewPlan(env, DATE);
    expect(review).toMatchObject({ date: DATE, planned: 2, done: 1 });
    expect(review.open.map((o) => o.title)).toEqual(['Банк']);

    const to = nextPlannedDay(DATE, new Set([1, 2, 3, 4, 5]));
    expect(to).toBe('2026-09-08');
    const carried = await carryItems(env, DATE, to, [], NOW);
    expect(carried.carried).toEqual([{ title: 'Банк', origin: '2026-09-04', days: 4 }]);
    expect(carried.stale.map((s) => s.title)).toEqual(['Банк']);
    expect((await listItems(env, DATE)).find((r) => r.title === 'Банк')?.status).toBe('carried');
    const next = await carriedInto(env, to);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ title: 'Банк', carried_from: '2026-09-04', status: 'planned' });
    expect(await getDayPlan(env, DATE)).toMatchObject({
      status: 'reviewed',
      reviewed_at: new Date(NOW).toISOString(),
    });

    // «Ні» на перенос: ids, яких немає, - нічого не переїжджає, день reviewed.
    await seedDraft(env, ['Ще одне']);
    const none = await carryItems(env, DATE, to, ['__none__'], NOW);
    expect(none.carried).toEqual([]);
  });

  it('nextPlannedDay пропускає вихідні за weekdays; kyivMs рахує літній/зимовий зсув', () => {
    const weekdays = new Set([1, 2, 3, 4, 5]);
    expect(nextPlannedDay('2026-09-04', weekdays)).toBe('2026-09-07');
    expect(nextPlannedDay('2026-09-07', weekdays)).toBe('2026-09-08');
    expect(nextPlannedDay('2026-09-05', new Set([6, 7]))).toBe('2026-09-06');
    expect(kyivMs('2026-09-07', '09:00')).toBe(Date.parse('2026-09-07T06:00:00.000Z'));
    expect(kyivMs('2026-12-07', '09:00')).toBe(Date.parse('2026-12-07T07:00:00.000Z'));
    expect(kyivMs('2026-09-07', 'зранку')).toBeNull();
  });
});
