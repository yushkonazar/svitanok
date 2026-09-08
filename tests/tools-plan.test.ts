// plan.* (етап 3 PR-8, 07 §4, S-P-14): пʼять інструментів плану дня через
// policy (усі T0): intent → чернетка; draft - перерахунок; accept - нагадування
// з «↩»; update - зміни вдень з «↩»; review - огляд і перенос. Календар
// підмінено (readCalendarRange), решта - реальні міграції у node:sqlite.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyPolicy, resolveUndo } from '../web/core/policy/proposals.mjs';
import { ACTION_LEVELS } from '../web/core/policy/core.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { resolvePlanDate } from '../web/core/tools/plan.mjs';
import { getDayPlan, listItems } from '../web/core/day-plan/store.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

vi.mock('../web/google.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/google.mjs')>();
  return {
    ...actual,
    readCalendarRange: vi.fn(async () => [
      {
        title: 'Зустріч',
        startMs: Date.parse('2026-09-07T07:00:00.000Z'),
        endMs: Date.parse('2026-09-07T08:00:00.000Z'),
      },
    ]),
  };
});

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
// Неділя 06.09.2026 18:00 Києва → «завтра» = 2026-09-07.
const NOW = Date.parse('2026-09-06T15:00:00.000Z');
const DATE = '2026-09-07';

afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    // Токен свіжий (Date.now(), не NOW: інакше ядро пішло б по новий у мережу)
    // - блоки в календар тепер створюються одразу, і без нього тест міряв би
    // лише відмову OAuth.
    BRIEFING: memoryKv(
      new Map([['googleToken', JSON.stringify({ token: 'tok', expMs: Date.now() + 3_600_000 })]]),
    ),
    GOOGLE_CLIENT_ID: 'c',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REFRESH_TOKEN: 'r',
    TELEGRAM_CHAT_ID: '555',
    TOPIC_ASSISTANT: '99',
  });
  const act = (kind: string, payload: Record<string, unknown>, at = NOW) =>
    applyPolicy(env, { kind, payload, threadId: '99', tainted: false }, at);
  return { env, db: d1.db, act };
}

const ITEMS = [
  { title: 'Презентація', kind: 'deep', est_min: 60 },
  { title: 'Банк', kind: 'errand', place: 'Центр' },
];

describe('plan.* через policy', () => {
  it('усі пʼять - T0; run напряму - помилка (виконує policy); resolvePlanDate', () => {
    for (const k of ['plan.intent', 'plan.draft', 'plan.accept', 'plan.update', 'plan.review']) {
      expect(ACTION_LEVELS[k]).toBe('T0');
      expect(TOOLS[k as keyof typeof TOOLS]?.write?.kind).toBe(k);
      expect(() => TOOLS[k as keyof typeof TOOLS]!.run({} as never, {} as never, NOW)).toThrow(
        'через policy',
      );
    }
    expect(resolvePlanDate(undefined, NOW)).toBe('2026-09-06');
    expect(resolvePlanDate('Завтра', NOW)).toBe(DATE);
    expect(resolvePlanDate('2026-09-09', NOW)).toBe('2026-09-09');
    expect(() => resolvePlanDate('післязавтра', NOW)).toThrow('сьогодні, завтра або YYYY-MM-DD');
  });

  it('plan.intent: пункти → чернетка з календарем; без «↩»; порожній список - помилка', async () => {
    const { env, db, act } = setup();
    const out = await act('plan.intent', { date: 'завтра', items: ITEMS });
    expect(out.mode).toBe('executed');
    if (out.mode !== 'executed') return;
    const result = out.result as { date: string; text: string; placed: unknown[] };
    expect(result.date).toBe(DATE);
    expect(result.text.split('\n')[0]).toBe('План на 07.09');
    expect(result.text).toContain('Презентація');
    expect(result.text).toContain('• 10:00 Зустріч (календар)');
    expect(result.placed).toHaveLength(2);
    expect(out.undo).toBeUndefined();
    expect((await getDayPlan(env, DATE))?.status).toBe('draft');
    expect(await listItems(env, DATE)).toHaveLength(2);

    // id від моделі не приймається: рядок іншої дати з тим самим id живе далі.
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, reminder_id) VALUES ('keep-id', '2026-09-09', 'Чужий день', 'planned', 'rem-9')`,
    ).run();
    const spoof = await act('plan.intent', {
      date: DATE,
      items: [{ id: 'keep-id', title: 'Підміна' }],
    });
    expect(spoof.mode).toBe('executed');
    expect(
      db.prepare(`SELECT date, reminder_id FROM plan_items WHERE id = 'keep-id'`).get(),
    ).toEqual({
      date: '2026-09-09',
      reminder_id: 'rem-9',
    });

    // Помилка виконавця T0 летить винятком - маршрут інструмента віддає її
    // моделі як відмову інструмента, не як «executed».
    await expect(act('plan.intent', { date: 'завтра', items: [] })).rejects.toThrow(
      'непорожній список',
    );
  });

  it('plan.draft: перерахунок із наявних пунктів; без пунктів - чесна помилка', async () => {
    const { act } = setup();
    await expect(act('plan.draft', { date: DATE })).rejects.toThrow('спершу plan.intent');
    await act('plan.intent', { date: DATE, items: ITEMS });
    const out = await act('plan.draft', { date: DATE });
    expect(out.mode).toBe('executed');
    if (out.mode === 'executed')
      expect((out.result as { placed: unknown[] }).placed).toHaveLength(2);
  });

  it('plan.accept: нагадування на блоки, «↩» скасовує; calendar=true - події одразу з «↩»', async () => {
    const { env, db, act } = setup();
    await act('plan.intent', { date: DATE, items: ITEMS });
    const out = await act('plan.accept', { date: DATE });
    expect(out.mode).toBe('executed');
    if (out.mode !== 'executed') return;
    expect(out.result).toMatchObject({
      date: DATE,
      status: 'accepted',
      reminders: 2,
      calendar_added: 0,
    });
    expect(out.undo).toBeDefined();
    expect(
      db.prepare(`SELECT count(*) AS n FROM reminders WHERE status = 'pending'`).get(),
    ).toEqual({ n: 2 });
    expect((await getDayPlan(env, DATE))?.status).toBe('accepted');

    const undone = await resolveUndo(env, out.undo!.id, NOW + 1000);
    expect(undone).toEqual({ ok: true, status: 'undone' });
    expect(
      db.prepare(`SELECT count(*) AS n FROM reminders WHERE status = 'cancelled'`).get(),
    ).toEqual({ n: 2 });
    expect((await getDayPlan(env, DATE))?.status).toBe('draft');

    // ⚠️ Від 08.09 подія без гостей - T0: блоки їдуть у календар ОДРАЗУ, а в
    // тред іде рядок із «↩» на кожен. Пропозицій ✅/❌ тут більше немає.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'ev-1' }), { status: 200 })),
    );
    const withCal = await act('plan.accept', { date: DATE, calendar: true }, NOW + 2000);
    expect(withCal.mode).toBe('executed');
    if (withCal.mode !== 'executed') return;
    expect(withCal.result).toMatchObject({ calendar_added: 2, calendar_failed: [] });
    const undos = db
      .prepare(`SELECT kind, level, status FROM proposals WHERE kind = 'undo:calendar.event'`)
      .all();
    expect(undos).toEqual([
      { kind: 'undo:calendar.event', level: 'T0', status: 'open' },
      { kind: 'undo:calendar.event', level: 'T0', status: 'open' },
    ]);
    const sent = (
      db.prepare(`SELECT thread_id, payload_json FROM outbox WHERE kind = 'send'`).all() as {
        thread_id: string;
        payload_json: string;
      }[]
    ).map((r) => ({ thread: r.thread_id, p: JSON.parse(r.payload_json) }));
    expect(sent).toHaveLength(2);
    expect(sent[0]?.thread).toBe('99');
    expect(sent[0]?.p.text).toBe('🗓 «Презентація» 07.09 08:00-09:20 - у календарі.');
    expect(JSON.stringify(sent[0]?.p.reply_markup)).toContain('"u:');
    expect(sent[1]?.p.text).toContain('«Банк»');

    await expect(act('plan.accept', { date: '2026-09-09' })).rejects.toThrow('немає чернетки');

    // DM-тред без chatId прогону (після ✅ resolveProposal дає chatId=null):
    // адреса - DM власника, не супергрупа (ревʼю 05.09).
    (env as { TELEGRAM_OWNER_USER_ID?: string }).TELEGRAM_OWNER_USER_ID = '777';
    await act('plan.intent', { date: '2026-09-10', items: ITEMS }, NOW + 3000);
    const dm = await applyPolicy(
      env,
      {
        kind: 'plan.accept',
        payload: { date: '2026-09-10', calendar: true },
        threadId: 'dm',
        chatId: null,
        tainted: false,
      },
      NOW + 4000,
    );
    expect(dm.mode).toBe('executed');
    const dmRows = db
      .prepare(
        `SELECT chat_id, thread_id FROM outbox WHERE kind = 'send' ORDER BY rowid DESC LIMIT 2`,
      )
      .all();
    expect(dmRows).toEqual([
      { chat_id: '777', thread_id: null },
      { chat_id: '777', thread_id: null },
    ]);
    vi.unstubAllGlobals();
  });

  it('один блок не пішов у календар - решта йде, і провал названо вголос', async () => {
    // ⚠️ Без ізоляції одна відмова Google лишала б план наполовину
    // перенесеним, і власник дізнався б про це лише з календаря.
    const { env, act } = setup();
    await act('plan.intent', { date: DATE, items: ITEMS });
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        return n === 1
          ? new Response('{"error":"x"}', { status: 403 })
          : new Response(JSON.stringify({ id: 'ev-2' }), { status: 200 });
      }),
    );
    const out = await applyPolicy(
      env,
      {
        kind: 'plan.accept',
        payload: { date: DATE, calendar: true },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      NOW + 5000,
    );
    expect(out.mode).toBe('executed');
    if (out.mode !== 'executed') return;
    expect(out.result).toMatchObject({ calendar_added: 1, calendar_failed: ['Презентація'] });
    vi.unstubAllGlobals();
  });

  it('plan.update: done/moves/drop за назвою з «↩»; plan.review - огляд і перенос ["all"]', async () => {
    const { env, db, act } = setup();
    await act('plan.intent', { date: DATE, items: ITEMS });
    const upd = await act('plan.update', {
      date: DATE,
      done: ['Презентація'],
      moves: [{ id: 'Банк', to: '16:00' }],
    });
    expect(upd.mode).toBe('executed');
    if (upd.mode !== 'executed') return;
    expect(upd.result).toEqual({ date: DATE, changed: 2 });
    let rows = await listItems(env, DATE);
    expect(rows.find((r) => r.title === 'Презентація')?.status).toBe('done');
    expect(rows.find((r) => r.title === 'Банк')?.window_start).toBe('16:00');
    expect(await resolveUndo(env, upd.undo!.id, NOW + 1)).toEqual({ ok: true, status: 'undone' });
    rows = await listItems(env, DATE);
    expect(rows.every((r) => r.status === 'planned')).toBe(true);

    await act('plan.update', { date: DATE, done: ['Презентація'] }, NOW + 2);
    const review = await act('plan.review', { date: DATE }, NOW + 3);
    expect(review.mode).toBe('executed');
    if (review.mode !== 'executed') return;
    expect(review.result).toMatchObject({ date: DATE, planned: 2, done: 1 });
    expect((review.result as { open: { title: string }[] }).open.map((o) => o.title)).toEqual([
      'Банк',
    ]);
    expect(review.undo).toBeUndefined();

    const carried = await act('plan.review', { date: DATE, carry: ['all'] }, NOW + 4);
    expect(carried.mode).toBe('executed');
    if (carried.mode !== 'executed') return;
    expect(carried.result).toMatchObject({ carried_to: '2026-09-08', stale: [] });
    expect(
      (carried.result as { carried: { title: string }[] }).carried.map((c) => c.title),
    ).toEqual(['Банк']);
    expect(
      db.prepare(`SELECT title, carried_from FROM plan_items WHERE date = '2026-09-08'`).all(),
    ).toEqual([{ title: 'Банк', carried_from: DATE }]);
    expect((await getDayPlan(env, DATE))?.status).toBe('reviewed');

    await expect(act('plan.review', { date: DATE, carry: ['Немає'] }, NOW + 5)).rejects.toThrow(
      'серед відкритих немає',
    );
  });
});
