// Інструменти нагадувань (етап 2 PR-6, 07 §4): create/update/cancel поверх
// чинного KV-сховища. Головний інваріант - ЧАС РАХУЄ КОД: інструмент бере
// природний текст і проганяє його через той самий parseReminderTime, що
// обслуговує /remind, а моделі шляху повз парсер немає (whenMs - внутрішнє
// поле undo, якого немає в схемі інструмента).

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
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-08-28T09:00:00.000Z'); // 12:00 у Києві

function makeEnv(reminders: unknown[] = []) {
  const store = new Map<string, string>();
  store.set('state', JSON.stringify({ reminders }));
  return { store, env: workerEnv({ BRIEFING: memoryKv(store) }) };
}

const state = (store: Map<string, string>) => JSON.parse(store.get('state') ?? '{}');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('reminders.create', () => {
  it('природний час рахує парсер ядра, не модель', async () => {
    const { store, env } = makeEnv();
    const { result } = await runRemindersCreate(
      env,
      { text: 'купити хліб', when: 'через 20 хв' },
      NOW,
    );

    expect(Date.parse(result.when) - NOW).toBe(20 * 60_000);
    const saved = state(store).reminders;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: result.id, text: 'купити хліб', firedTs: null });
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

  it('числовий timestamp у when НЕ приймається - шлях повз парсер закритий', async () => {
    // Головний інваріант інструмента: час рахує код. Якби модель могла
    // передати готовий epoch (як рядок або числом), вона рахувала б київський
    // зсув і переведення годинника сама - і помилялася б тихо.
    const { store, env } = makeEnv();
    for (const when of [String(NOW + 600_000), '1790000000000']) {
      await expect(runRemindersCreate(env, { text: 'x', when }, NOW)).rejects.toThrow(
        /не розібрав час/,
      );
    }
    expect(state(store).reminders ?? []).toHaveLength(0);
  });

  it('нерозібраний час - чесна відмова, KV не чіпається', async () => {
    const { store, env } = makeEnv();
    await expect(runRemindersCreate(env, { text: 'x', when: 'колись потім' }, NOW)).rejects.toThrow(
      /не розібрав час/,
    );
    expect(state(store).reminders ?? []).toHaveLength(0);
  });

  it('година, що вже минула сьогодні, стає завтрашньою - переносить ПАРСЕР', async () => {
    // Перевірено пробою: parseReminderTime сам відсуває «о 08:00» на наступну
    // добу, тож guard «час уже минув» у самому інструменті - запобіжник для
    // внутрішнього whenMs, а не гілка, у яку модель може завести.
    const { env } = makeEnv();
    const morning = Date.parse('2026-08-28T06:30:00Z'); // 09:30 у Києві
    const { result } = await runRemindersCreate(env, { text: 'зарядка', when: 'о 08:00' }, morning);
    expect(Date.parse(result.when)).toBeGreaterThan(morning);
    expect(result.when.slice(0, 10)).toBe('2026-08-29');
  });

  it('внутрішній whenMs минулого ДОЗВОЛЕНИЙ - це шлях undo (окремий параметр, не args)', async () => {
    // «↩» після скасування має повернути нагадування таким, яким воно було.
    // Якщо термін настав, поки власник роздумував, воно спрацює найближчим
    // тіком - це правильніше, ніж мовчки відмовити у відновленні.
    const { env } = makeEnv();
    const { result } = await runRemindersCreate(env, { text: 'вчорашнє' }, NOW, {
      whenMs: NOW - 1000,
      restoreId: 'old1',
    });
    expect(result.id).toBe('old1');
    expect(Date.parse(result.when)).toBe(NOW - 1000);
  });

  it('порожній текст і задовгий текст відкидаються', async () => {
    const { env } = makeEnv();
    await expect(runRemindersCreate(env, { text: '   ', when: 'через 5 хв' }, NOW)).rejects.toThrow(
      /не зрозумів, ПРО ЩО нагадати/,
    );
    await expect(
      runRemindersCreate(env, { text: 'я'.repeat(201), when: 'через 5 хв' }, NOW),
    ).rejects.toThrow(/довший за 200/);
  });
});

describe('reminders.update / cancel', () => {
  const seeded = () =>
    makeEnv([
      { id: 'r1', text: 'стара справа', whenMs: NOW + 3_600_000, createdMs: NOW, firedTs: null },
      { id: 'done', text: 'вже спрацювало', whenMs: NOW - 60_000, createdMs: NOW, firedTs: NOW },
    ]);

  it('патчить текст і час; час перераховує парсер', async () => {
    const { store, env } = seeded();
    const { result } = await runRemindersUpdate(
      env,
      { id: 'r1', text: 'нова справа', when: 'через 2 години' },
      NOW,
    );

    expect(result).toMatchObject({ id: 'r1', text: 'нова справа' });
    expect(Date.parse(result.when) - NOW).toBe(2 * 60 * 60_000);
    const row = state(store).reminders.find((r: { id: string }) => r.id === 'r1');
    expect(row).toMatchObject({ text: 'нова справа', firedTs: null });
  });

  it('скасування прибирає зі списку і віддає текст для відповіді', async () => {
    const { store, env } = seeded();
    const { result } = await runRemindersCancel(env, { id: 'r1' });
    expect(result).toMatchObject({ id: 'r1', text: 'стара справа', cancelled: true });
    expect(state(store).reminders.some((r: { id: string }) => r.id === 'r1')).toBe(false);
  });

  it('невідомий id і вже спрацьоване - відмова з підказкою перечитати список', async () => {
    const { env } = seeded();
    await expect(runRemindersUpdate(env, { id: 'нема', text: 'x' }, NOW)).rejects.toThrow(
      /не знайдено серед активних/,
    );
    // Спрацьоване нагадування не «активне»: правити його нема сенсу.
    await expect(runRemindersCancel(env, { id: 'done' })).rejects.toThrow(/не знайдено/);
  });

  it('порожній патч відкидається (щоб не було мовчазного no-op)', async () => {
    const { env } = seeded();
    await expect(runRemindersUpdate(env, { id: 'r1' }, NOW)).rejects.toThrow(/нема що змінювати/);
  });

  it('readActiveReminders віддає лише активні, за зростанням часу', async () => {
    const { env } = makeEnv([
      { id: 'b', text: 'пізніше', whenMs: NOW + 7200_000, firedTs: null },
      { id: 'a', text: 'скоро', whenMs: NOW + 600_000, firedTs: null },
      { id: 'z', text: 'спрацювало', whenMs: NOW - 1, firedTs: NOW },
    ]);
    expect((await readActiveReminders(env)).map((r) => r.id)).toEqual(['a', 'b']);
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

  it('схема не має шляху повз парсер: whenMs і restoreId моделі недоступні', () => {
    for (const name of ['reminders.create', 'reminders.update']) {
      const props = TOOLS[name]!.args.properties ?? {};
      expect(Object.keys(props)).not.toContain('whenMs');
      expect(Object.keys(props)).not.toContain('restoreId');
    }
  });
});

// ── Policy-шлях: T0 з «↩», tainted → пропозиція, справжній відкат ────────────

describe('адресу і внутрішні поля задає ЯДРО (security-ревʼю PR-6)', () => {
  it('chat_id/thread_id з аргументів моделі ігноруються повністю', async () => {
    // Доти вони жили в args, і через proposals.create модель могла надіслати
    // нагадування з даними власника в ЧУЖИЙ чат: крон шле саме на r.chatId.
    const { store, env } = makeEnv();
    await runRemindersCreate(
      env,
      { text: 'секрет', when: 'через 20 хв', chat_id: 777_000, thread_id: 5 } as never,
      NOW,
    );
    const saved = state(store).reminders[0];
    expect(saved.chatId).toBeUndefined();
    expect(saved.threadId).toBeUndefined();
  });

  it('whenMs/restoreId з аргументів моделі теж ігноруються', async () => {
    const { store, env } = makeEnv();
    const { result } = await runRemindersCreate(
      env,
      { text: 'x', when: 'через 20 хв', whenMs: NOW - 60_000, restoreId: 'hijack' } as never,
      NOW,
    );
    // Час - із парсера, id - випадковий: обидва поля з args не діють.
    expect(Date.parse(result.when) - NOW).toBe(20 * 60_000);
    expect(result.id).not.toBe('hijack');
    expect(state(store).reminders[0].whenMs).toBe(NOW + 20 * 60_000);
  });

  it('адреса приходить окремим параметром - її ставить ядро з контексту прогону', async () => {
    const { store, env } = makeEnv();
    await runRemindersCreate(env, { text: 'x', when: 'через 5 хв' }, NOW, {
      chatId: 555,
      threadId: 99,
    });
    expect(state(store).reminders[0]).toMatchObject({ chatId: 555, threadId: 99 });
  });
});

describe('нагадування через policy (PR-8 × PR-6)', () => {
  const seededEnv = (reminders: unknown[] = []) => {
    const store = new Map<string, string>();
    store.set('state', JSON.stringify({ reminders }));
    const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql']);
    return {
      store,
      env: workerEnv({ BRIEFING: memoryKv(store), DB: d1.stub }),
    };
  };
  const remindersOf = (store: Map<string, string>) =>
    JSON.parse(store.get('state') ?? '{}').reminders ?? [];

  it('T0 у чистій сесії: створено одразу + кнопка «↩», яка справді відкочує', async () => {
    const { store, env } = seededEnv();
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
    expect(remindersOf(store)).toHaveLength(1);
    expect(res.undo).toBeDefined();

    const undone = await resolveUndo(env, res.undo!.id, NOW + 60_000);
    expect(undone).toMatchObject({ ok: true, status: 'undone' });
    expect(remindersOf(store)).toHaveLength(0);
  });

  it('скасування: «↩» повертає нагадування з ТИМ САМИМ id, текстом і часом', async () => {
    const whenMs = NOW + 3_600_000;
    const { store, env } = seededEnv([
      { id: 'r1', text: 'зустріч', whenMs, createdMs: NOW, firedTs: null },
    ]);
    const res = await applyPolicy(
      env,
      { kind: 'reminders.cancel', payload: { id: 'r1' }, tainted: false },
      NOW,
    );
    if (res.mode !== 'executed') throw new Error(`очікували executed, отримали ${res.mode}`);
    expect(remindersOf(store)).toHaveLength(0);

    await resolveUndo(env, res.undo!.id, NOW + 60_000);
    const back = remindersOf(store);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: 'r1', text: 'зустріч', whenMs });
  });

  it('оновлення: «↩» повертає і старий текст, і старий час', async () => {
    const whenMs = NOW + 3_600_000;
    const { store, env } = seededEnv([
      { id: 'r1', text: 'старий текст', whenMs, createdMs: NOW, firedTs: null },
    ]);
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
    expect(remindersOf(store)[0]).toMatchObject({ text: 'новий текст' });

    await resolveUndo(env, res.undo!.id, NOW + 60_000);
    expect(remindersOf(store)[0]).toMatchObject({ id: 'r1', text: 'старий текст', whenMs });
  });

  it('у tainted-сесії - ПРОПОЗИЦІЯ, KV не чіпається до ✅', async () => {
    const { store, env } = seededEnv();
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
    expect(remindersOf(store)).toHaveLength(0);

    const approved = await resolveProposal(env, { id: res.proposal.id, choice: 'ok' }, NOW + 1000);
    expect(approved).toMatchObject({ ok: true, status: 'approved', executed: true });
    expect(remindersOf(store)).toHaveLength(1);
  });

  it('невалідні дані відхиляє САМ інструмент, а не policy мовчки', async () => {
    const { store, env } = seededEnv();
    await expect(
      applyPolicy(
        env,
        { kind: 'reminders.create', payload: { text: 'x', when: 'колись' }, tainted: false },
        NOW,
      ),
    ).rejects.toThrow(/не розібрав час/);
    expect(remindersOf(store)).toHaveLength(0);
  });
});
