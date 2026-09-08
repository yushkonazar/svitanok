// Містки між можливостями (релізний блок PR-6, §2 плану): одна кнопка після
// дії, що веде в наступну. Тут перевіряється, що кнопка зʼявляється саме там,
// де для неї є дані, і що тап робить обіцяне - разом із чесним фолбеком, коли
// маршрут не рахується.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { followUpButtons, reportButtons, boughtButton } from '../web/core/links.mjs';
import { applyPolicy, EXECUTORS } from '../web/core/policy/proposals.mjs';
import { handleBrainCallback } from '../web/core/prerouter.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-08T09:00:00.000Z');
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0008_fts.sql',
  '0010_reminders_address.sql',
  '0011_ideas_number.sql',
];

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const kv = new Map<string, string>([
    ['googleToken', JSON.stringify({ token: 'tok', expMs: Date.now() + 3_600_000 })],
  ]);
  const tg: { method: string; body: Record<string, unknown> }[] = [];
  const env = workerEnv({
    ASSISTANT_V2: 'on',
    DB: d1.stub,
    BRIEFING: memoryKv(kv),
    TELEGRAM_BOT_TOKEN: 'bot',
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '555',
    GOOGLE_CLIENT_ID: 'c',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REFRESH_TOKEN: 'r',
  });
  return { env, db: d1.db, kv, tg };
}

/** Стаб мережі: календар віддає подію, Tasks - задачу, Telegram - ok. */
function stubNet(tg: { method: string; body: Record<string, unknown> }[], over = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) {
        const method = u.split('/').pop() ?? '';
        tg.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      const custom = (over as Record<string, () => Response>)[
        Object.keys(over).find((k) => u.includes(k)) ?? ''
      ];
      if (custom) return custom();
      if (u.includes('tasks.googleapis.com')) {
        return new Response(JSON.stringify({ id: 't9', title: 'Профіль' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'ev-1' }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('коли кнопка-місток зʼявляється', () => {
  it('подія З МІСЦЕМ дає «Коли виходити»; без місця - ні', () => {
    expect(
      followUpButtons('calendar.event', { location: 'вул. Вірменська 6' }, 'u1')[0]?.[0]
        ?.callback_data,
    ).toBe('m:dep:u1');
    expect(followUpButtons('calendar.event', { location: '  ' }, 'u1')).toEqual([]);
    expect(followUpButtons('calendar.event', {}, 'u1')).toEqual([]);
  });

  it('ідея дає «У задачі»; решта дій - без містка', () => {
    expect(followUpButtons('ideas.create', { id: 'i1' }, 'u1')[0]?.[0]?.callback_data).toBe(
      'm:it:u1',
    );
    for (const kind of ['facts.set', 'reminders.create', 'record', 'plan.accept'])
      expect(followUpButtons(kind, {}, 'u1'), kind).toEqual([]);
  });

  it('кривий id - жодної кнопки (callback_data не місце для сміття)', () => {
    for (const bad of ['', 'a b', 'x'.repeat(50), 'a:b'])
      expect(followUpButtons('ideas.create', { id: 'i1' }, bad), bad).toEqual([]);
  });

  it('звіт і «Купив» - фіксовані набори', () => {
    expect(reportButtons()[0]?.map((b) => b.callback_data)).toEqual(['m:wr:carry', 'm:wr:idea']);
    expect(boughtButton('w1')[0]?.callback_data).toBe('m:buy:w1');
    expect(boughtButton('')).toEqual([]);
  });
});

describe('подія → вихід (2.1)', () => {
  /** Створити подію з місцем і повернути id рядка undo. */
  async function eventWithPlace(env: Env, startIso: string) {
    const out = await applyPolicy(
      env,
      {
        kind: 'calendar.event',
        payload: {
          title: 'Кава з Марком',
          startIso,
          endIso: '2026-09-08T13:00:00.000Z',
          location: 'вул. Вірменська 6',
        },
        threadId: 'dm',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    return out;
  }

  it('кнопка «Коли виходити» стоїть ПЕРЕД «↩»', async () => {
    const { env, tg } = setup();
    stubNet(tg);
    const out = await eventWithPlace(env, '2026-09-08T12:00:00.000Z');
    const row = (out.mode === 'executed' ? out.undo?.buttons : []) as {
      callback_data: string;
    }[][];
    expect(row.map((r) => String(r[0]?.callback_data).split(':')[0])).toEqual(['m', 'u']);
    expect(String(row[0]?.[0]?.callback_data)).toMatch(/^m:dep:/);
  });

  it('маршрут не порахувався - нагадування за пів години і ЧЕСНИЙ рядок про це', async () => {
    const { env, tg } = setup();
    stubNet(tg);
    const out = await eventWithPlace(env, '2026-09-08T12:00:00.000Z');
    const undoId = out.mode === 'executed' ? String(out.undo?.id) : '';
    // Локації власника немає → resolveWaypoint кине → фолбек 30 хв.
    const toast = await handleBrainCallback(
      env,
      { data: `m:dep:${undoId}`, chatId: 555, messageId: 7 },
      NOW,
    );
    expect(toast).toBe('Рахую дорогу');
    const line = tg.find((c) => String(c.body.text ?? '').includes('Нагадаю о'))!;
    expect(String(line.body.text)).toContain('маршрут не порахувався');
    // 12:00 UTC = 15:00 Київ; мінус 30 хв = 14:30.
    expect(String(line.body.text)).toContain('14:30');
  });

  it('подія вже почалась або деталей немає - чесний тост, нічого не створюємо', async () => {
    const { env, tg } = setup();
    stubNet(tg);
    const out = await eventWithPlace(env, '2026-09-08T08:00:00.000Z');
    const undoId = out.mode === 'executed' ? String(out.undo?.id) : '';
    expect(await handleBrainCallback(env, { data: `m:dep:${undoId}`, chatId: 555 }, NOW)).toBe(
      'Подія вже почалась.',
    );
    expect(await handleBrainCallback(env, { data: 'm:dep:no-such-row', chatId: 555 }, NOW)).toBe(
      'Про цю подію я вже не памʼятаю деталей.',
    );
  });
});

describe('ідея → задача (2.3)', () => {
  it('тап створює задачу в Tasks і лишає «↩»', async () => {
    const { env, db, tg } = setup();
    stubNet(tg);
    const out = await applyPolicy(
      env,
      {
        kind: 'ideas.create',
        payload: { title: 'Профіль', body_md: 'опис' },
        threadId: 'dm',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    const undoId = String(out.undo?.id);
    expect(await handleBrainCallback(env, { data: `m:it:${undoId}`, chatId: 555 }, NOW)).toBe(
      'Поставив',
    );
    expect(tg.some((c) => String(c.body.text ?? '').includes('Поставив задачу «Профіль»'))).toBe(
      true,
    );
    // Задача - теж T0, тож у базі зʼявився ще один рядок відкату.
    expect(
      db.prepare(`SELECT count(*) AS n FROM proposals WHERE kind = 'undo:tasks.create'`).get(),
    ).toEqual({ n: 1 });
  });

  it('ідею вже видалили - чесно, без задачі', async () => {
    const { env, tg } = setup();
    stubNet(tg);
    const out = await applyPolicy(
      env,
      {
        kind: 'ideas.create',
        payload: { title: 'Профіль', body_md: 'опис' },
        threadId: 'dm',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    await EXECUTORS['ideas.create']!.undo!(env, { id: (out.result as { id: string }).id }, NOW);
    expect(
      await handleBrainCallback(env, { data: `m:it:${String(out.undo?.id)}`, chatId: 555 }, NOW),
    ).toBe('Ідеї вже немає.');
  });
});

describe('звіт → дії (2.5) і бажання → «Купив» (2.6)', () => {
  it('кнопка звіту шле підказку в тред як текст власника', async () => {
    const { env, tg } = setup();
    stubNet(tg);
    const toast = await handleBrainCallback(
      env,
      { data: 'm:wr:carry', chatId: 555, messageId: 7 },
      NOW,
    );
    expect(toast).toBe('Переношу');
  });

  it('«Купив» закриває бажання', async () => {
    const { env, db, tg } = setup();
    stubNet(tg);
    db.prepare(
      `INSERT INTO wishes (id, type, title, status, created_at)
       VALUES ('w1', 'purchase', 'Philips HD9200', 'active', 'x')`,
    ).run();
    expect(await handleBrainCallback(env, { data: 'm:buy:w1', chatId: 555 }, NOW)).toBe('Вітаю');
    expect(db.prepare(`SELECT status FROM wishes WHERE id = 'w1'`).get()).toEqual({
      status: 'done',
    });
    expect(tg.some((c) => String(c.body.text ?? '').includes('Закрив бажання'))).toBe(true);
  });
});
