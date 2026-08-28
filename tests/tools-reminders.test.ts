// Інструменти нагадувань (етап 2 PR-6/PR-7, 07 §4): create/update/cancel
// поверх D1 `reminders`. Два головні інваріанти:
//
//  1. ЧАС РАХУЄ КОД: інструмент бере природний текст і жене його через той
//     самий parseReminderTime, що обслуговує /remind; шляху повз парсер у
//     схемі немає (внутрішні поля - окремий параметр функції).
//  2. Адресу доставки задає ЯДРО з контексту прогону, не аргументи моделі.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  runRemindersCreate,
  runRemindersUpdate,
  runRemindersCancel,
  readActiveReminders,
} from '../web/core/tools/reminders.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { applyPolicy, resolveProposal, resolveUndo } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';
import { memoryKv } from './helpers/kv.js';

const NOW = Date.parse('2026-08-28T09:00:00.000Z'); // 12:00 у Києві
const MIGRATIONS = ['0001_base.sql', '0002_assistant.sql', '0010_reminders_address.sql'];

type SeedReminder = { id: string; text: string; dueAtMs: number; status?: string };

function makeEnv(seed: SeedReminder[] = []) {
  const d1 = d1FromSqlite(MIGRATIONS);
  for (const r of seed) {
    d1.db
      .prepare(
        `INSERT INTO reminders (id, due_at, text, status, snooze_count) VALUES (?, ?, ?, ?, 0)`,
      )
      .run(r.id, new Date(r.dueAtMs).toISOString(), r.text, r.status ?? 'pending');
  }
  return { d1, env: workerEnv({ DB: d1.stub }) };
}

type Row = Record<string, unknown>;
const rows = (d1: ReturnType<typeof d1FromSqlite>) =>
  d1.db.prepare('SELECT * FROM reminders ORDER BY due_at').all() as Row[];
const active = (d1: ReturnType<typeof d1FromSqlite>) =>
  rows(d1).filter((r) => r.status === 'pending' || r.status === 'snoozed');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('reminders.create', () => {
  it('природний час рахує парсер ядра, не модель', async () => {
    const { d1, env } = makeEnv();
    const { result } = await runRemindersCreate(
      env,
      { text: 'купити хліб', when: 'через 20 хв' },
      NOW,
    );

    expect(Date.parse(result.when) - NOW).toBe(20 * 60_000);
    const saved = active(d1);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: result.id, text: 'купити хліб', status: 'pending' });
  });

  it('зміст із самого when стає текстом, коли text не заданий', async () => {
    const { env } = makeEnv();
    const { result } = await runRemindersCreate(
      env,
      { when: 'через 60 хвилин подзвонити мамі' },
      NOW,
    );
    expect(result.text).toBe('подзвонити мамі');
    expect(Date.parse(result.when) - NOW).toBe(60 * 60_000);
  });

  it('сам лише час без змісту - відмова, а не нагадування «Нагадування»', async () => {
    // cleanRemainder віддає підпис-заглушку, і без перевірки вона сходила б за
    // зміст (ревʼю PR-6).
    const { d1, env } = makeEnv();
    await expect(runRemindersCreate(env, { when: 'через 20 хв' }, NOW)).rejects.toThrow(
      /не зрозумів, ПРО ЩО нагадати/,
    );
    expect(rows(d1)).toHaveLength(0);
  });

  it('числовий timestamp у when НЕ приймається - шлях повз парсер закритий', async () => {
    const { d1, env } = makeEnv();
    for (const when of [String(NOW + 600_000), '1790000000000']) {
      await expect(runRemindersCreate(env, { text: 'x', when }, NOW)).rejects.toThrow(
        /не розібрав час/,
      );
    }
    expect(rows(d1)).toHaveLength(0);
  });

  it('нерозібраний час - чесна відмова, база не чіпається', async () => {
    const { d1, env } = makeEnv();
    await expect(runRemindersCreate(env, { text: 'x', when: 'колись потім' }, NOW)).rejects.toThrow(
      /не розібрав час/,
    );
    expect(rows(d1)).toHaveLength(0);
  });

  it('година, що вже минула сьогодні, стає завтрашньою - переносить ПАРСЕР', async () => {
    const { env } = makeEnv();
    const morning = Date.parse('2026-08-28T06:30:00Z'); // 09:30 у Києві
    const { result } = await runRemindersCreate(env, { text: 'зарядка', when: 'о 08:00' }, morning);
    expect(result.when.slice(0, 10)).toBe('2026-08-29');
  });

  it('порожній і задовгий текст відкидаються', async () => {
    const { env } = makeEnv();
    await expect(runRemindersCreate(env, { text: '   ', when: 'через 5 хв' }, NOW)).rejects.toThrow(
      /не зрозумів, ПРО ЩО нагадати/,
    );
    await expect(
      runRemindersCreate(env, { text: 'я'.repeat(201), when: 'через 5 хв' }, NOW),
    ).rejects.toThrow(/довший за 200/);
  });
});

describe('адресу і внутрішні поля задає ЯДРО (security-ревʼю PR-6)', () => {
  it('chat_id/thread_id з аргументів моделі ігноруються повністю', async () => {
    const { d1, env } = makeEnv();
    await runRemindersCreate(
      env,
      { text: 'секрет', when: 'через 20 хв', chat_id: 777_000, thread_id: 5 } as never,
      NOW,
    );
    expect(rows(d1)[0]).toMatchObject({ chat_id: null, thread_id: null });
  });

  it('dueAtMs/restoreId з аргументів моделі теж ігноруються', async () => {
    const { d1, env } = makeEnv();
    const { result } = await runRemindersCreate(
      env,
      { text: 'x', when: 'через 20 хв', dueAtMs: NOW - 60_000, restoreId: 'hijack' } as never,
      NOW,
    );
    expect(Date.parse(result.when) - NOW).toBe(20 * 60_000);
    expect(result.id).not.toBe('hijack');
    expect(Date.parse(String(rows(d1)[0]!.due_at))).toBe(NOW + 20 * 60_000);
  });

  it('адреса приходить окремим параметром - її ставить ядро з контексту прогону', async () => {
    const { d1, env } = makeEnv();
    await runRemindersCreate(env, { text: 'x', when: 'через 5 хв' }, NOW, {
      chatId: 555,
      threadId: 99,
    });
    expect(rows(d1)[0]).toMatchObject({ chat_id: '555', thread_id: '99' });
  });

  it('внутрішній dueAtMs у минулому ДОЗВОЛЕНИЙ - це шлях undo', async () => {
    const { env } = makeEnv();
    const { result } = await runRemindersCreate(env, { text: 'вчорашнє' }, NOW, {
      dueAtMs: NOW - 1000,
      restoreId: 'old1',
    });
    expect(result.id).toBe('old1');
    expect(Date.parse(result.when)).toBe(NOW - 1000);
  });
});

describe('reminders.update / cancel', () => {
  const seeded = () =>
    makeEnv([
      { id: 'r1', text: 'стара справа', dueAtMs: NOW + 3_600_000 },
      { id: 'done', text: 'вже надіслане', dueAtMs: NOW - 60_000, status: 'sent' },
    ]);

  it('патчить текст і час; час перераховує парсер', async () => {
    const { d1, env } = seeded();
    const { result } = await runRemindersUpdate(
      env,
      { id: 'r1', text: 'нова справа', when: 'через 2 години' },
      NOW,
    );

    expect(result).toMatchObject({ id: 'r1', text: 'нова справа' });
    expect(Date.parse(result.when) - NOW).toBe(2 * 60 * 60_000);
    expect(rows(d1).find((r) => r.id === 'r1')).toMatchObject({
      text: 'нова справа',
      status: 'pending',
    });
  });

  it('скасування лишає рядок зі статусом cancelled - є що відновлювати', async () => {
    const { d1, env } = seeded();
    const { result } = await runRemindersCancel(env, { id: 'r1' });
    expect(result).toMatchObject({ id: 'r1', text: 'стара справа', cancelled: true });
    expect(rows(d1).find((r) => r.id === 'r1')).toMatchObject({ status: 'cancelled' });
    expect(active(d1)).toHaveLength(0);
  });

  it('невідомий id і вже надіслане - відмова з підказкою перечитати список', async () => {
    const { env } = seeded();
    await expect(runRemindersUpdate(env, { id: 'нема', text: 'x' }, NOW)).rejects.toThrow(
      /не знайдено серед активних/,
    );
    await expect(runRemindersCancel(env, { id: 'done' })).rejects.toThrow(/не знайдено/);
  });

  it('порожній патч відкидається (щоб не було мовчазного no-op)', async () => {
    const { env } = seeded();
    await expect(runRemindersUpdate(env, { id: 'r1' }, NOW)).rejects.toThrow(/нема що змінювати/);
  });

  it('readActiveReminders віддає лише активні, за зростанням часу', async () => {
    const { env } = makeEnv([
      { id: 'b', text: 'пізніше', dueAtMs: NOW + 7_200_000 },
      { id: 'a', text: 'скоро', dueAtMs: NOW + 600_000 },
      { id: 'z', text: 'надіслане', dueAtMs: NOW - 1, status: 'sent' },
    ]);
    expect((await readActiveReminders(env)).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('нагадування через policy (PR-8 × PR-6)', () => {
  it('T0 у чистій сесії: створено одразу + кнопка «↩», яка справді відкочує', async () => {
    const { d1, env } = makeEnv();
    const res = await applyPolicy(
      env,
      {
        kind: 'reminders.create',
        payload: { text: 'подзвонити', when: 'через 30 хв' },
        tainted: false,
      },
      NOW,
    );
    if (res.mode !== 'executed') throw new Error(`очікували executed, отримали ${res.mode}`);
    expect(active(d1)).toHaveLength(1);

    const undone = await resolveUndo(env, res.undo!.id, NOW + 60_000);
    expect(undone).toMatchObject({ ok: true, status: 'undone' });
    expect(active(d1)).toHaveLength(0);
  });

  it('скасування: «↩» повертає ТОЙ САМИЙ рядок, а не створює дубль', async () => {
    const dueAtMs = NOW + 3_600_000;
    const { d1, env } = makeEnv([{ id: 'r1', text: 'зустріч', dueAtMs }]);
    const res = await applyPolicy(
      env,
      { kind: 'reminders.cancel', payload: { id: 'r1' }, tainted: false },
      NOW,
    );
    if (res.mode !== 'executed') throw new Error(`очікували executed, отримали ${res.mode}`);
    expect(active(d1)).toHaveLength(0);

    await resolveUndo(env, res.undo!.id, NOW + 60_000);
    // Рядок один - той самий id, час і текст: у D1 скасування не видаляє запис.
    expect(rows(d1)).toHaveLength(1);
    expect(active(d1)[0]).toMatchObject({
      id: 'r1',
      text: 'зустріч',
      due_at: new Date(dueAtMs).toISOString(),
    });
  });

  it('оновлення: «↩» повертає і старий текст, і старий час', async () => {
    const dueAtMs = NOW + 3_600_000;
    const { d1, env } = makeEnv([{ id: 'r1', text: 'старий текст', dueAtMs }]);
    const res = await applyPolicy(
      env,
      {
        kind: 'reminders.update',
        payload: { id: 'r1', text: 'новий текст', when: 'через 5 годин' },
        tainted: false,
      },
      NOW,
    );
    if (res.mode !== 'executed') throw new Error(`очікували executed, отримали ${res.mode}`);
    expect(active(d1)[0]).toMatchObject({ text: 'новий текст' });

    await resolveUndo(env, res.undo!.id, NOW + 60_000);
    expect(active(d1)[0]).toMatchObject({
      id: 'r1',
      text: 'старий текст',
      due_at: new Date(dueAtMs).toISOString(),
    });
  });

  it('у tainted-сесії - ПРОПОЗИЦІЯ, база не чіпається до ✅', async () => {
    const { d1, env } = makeEnv();
    const res = await applyPolicy(
      env,
      {
        kind: 'reminders.create',
        payload: { text: 'з листа', when: 'через 10 хв' },
        tainted: true,
      },
      NOW,
    );
    if (res.mode !== 'proposed') throw new Error(`очікували proposed, отримали ${res.mode}`);
    expect(res.proposal.level).toBe('T1');
    expect(rows(d1)).toHaveLength(0);

    const approved = await resolveProposal(env, { id: res.proposal.id, choice: 'ok' }, NOW + 1000);
    expect(approved).toMatchObject({ ok: true, status: 'approved', executed: true });
    expect(active(d1)).toHaveLength(1);
  });

  it('невалідні дані відхиляє САМ інструмент, а не policy мовчки', async () => {
    const { d1, env } = makeEnv();
    await expect(
      applyPolicy(
        env,
        { kind: 'reminders.create', payload: { text: 'x', when: 'колись' }, tainted: false },
        NOW,
      ),
    ).rejects.toThrow(/не розібрав час/);
    expect(rows(d1)).toHaveLength(0);
  });
});

describe('модель бачить те, що створила (data.read × D1)', () => {
  it('нагадування з D1 потрапляє у дайджест разом із KV-записами', async () => {
    // Інакше модель створює нагадування інструментом і не знаходить його id -
    // ані змінити, ані скасувати (розрив, що зʼявився при переході на D1).
    const { runDataRead } = await import('../web/core/tools/read.mjs');
    const d1 = d1FromSqlite(MIGRATIONS);
    const kv = new Map<string, string>();
    kv.set(
      'state',
      JSON.stringify({
        reminders: [{ id: 'kv1', text: 'з легасі', whenMs: NOW + 900_000, firedTs: null }],
      }),
    );
    const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(kv) });

    await runRemindersCreate(env, { text: 'з мозку', when: 'через 30 хв' }, NOW);
    const { result } = await runDataRead(env, { scope: 'reminders' }, NOW);

    expect(String(result)).toContain('з мозку');
    expect(String(result)).toContain('з легасі');
  });
});

describe('реєстрація в реєстрі інструментів', () => {
  it('усі три - write через policy, прямий run кидає', () => {
    for (const name of ['reminders.create', 'reminders.update', 'reminders.cancel']) {
      const def = TOOLS[name]!;
      expect(def.write).toEqual({ kind: name });
      expect(() => def.run({} as never, {}, NOW)).toThrow(/через policy/);
    }
  });

  it('схема не має шляху повз парсер і повз контекст прогону', () => {
    for (const name of ['reminders.create', 'reminders.update']) {
      const props = Object.keys(TOOLS[name]!.args.properties ?? {});
      for (const forbidden of ['dueAtMs', 'whenMs', 'restoreId', 'chat_id', 'thread_id']) {
        expect(props).not.toContain(forbidden);
      }
    }
  });
});
