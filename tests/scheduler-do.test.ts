// SchedulerDO (web/core/scheduler/do.mjs) на фейковому сховищі: KV — Map,
// SQL — node:sqlite (той самий діалект, що SQLite-бекенд DO). Перевіряються
// рівно платформні обіцянки DO: сівба реєстру, тік із ізоляцією збоїв,
// dedupe появи, shadow-режим «лише лог», рішення сторожа, замір джитера.
// Правила «що прострочене / який ключ появи» тестуються окремо в
// scheduler-core.test.ts — тут вони беруться як дані.

import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi } from 'vitest';
import { SchedulerDO } from '../web/core/scheduler/do.mjs';
import { SCHEDULER_TASKS } from '../web/core/scheduler/tasks.mjs';
import { WATCHDOG_GRACE_MS } from '../web/core/scheduler/core.mjs';

const T0 = Date.parse('2026-08-26T10:00:00.000Z');
const MIN5 = 5 * 60_000;

/** Фейк DurableObjectState: KV на Map, SQL на node:sqlite, alarm у полі. */
function makeCtx() {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();
  const state = {
    alarm: null as number | null,
    storage: {
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      deleteAll: async () => {
        kv.clear();
      },
      setAlarm: async (ms: number) => {
        state.alarm = ms;
      },
      getAlarm: async () => state.alarm,
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          const stmt = db.prepare(query);
          if (/^\s*select/i.test(query)) {
            // @ts-expect-error node:sqlite приймає біндинги варіативно
            return { toArray: () => stmt.all(...bindings) };
          }
          // @ts-expect-error те саме для run
          stmt.run(...bindings);
          return { toArray: () => [] };
        },
      },
    },
  };
  return state;
}

type TaskDef = { periodMin: number; shadowSafe?: boolean; run: () => Promise<unknown> };

function makeDo(env: Record<string, unknown>, tasks?: Record<string, TaskDef>) {
  const ctx = makeCtx();
  // Конструктор стаба кладе ctx/env на this — як справжній базовий клас.
  const scheduler = new SchedulerDO(ctx as never, env as never);
  if (tasks) scheduler.tasks = tasks as never;
  return { scheduler, ctx };
}

const jobsOf = async (scheduler: SchedulerDO) => (await scheduler.status()).jobs;

describe('SchedulerDO — сівба реєстру і сторож', () => {
  it('перший watchdogTick сіє задачі реєстру і ставить alarm на найближчу появу', async () => {
    const { scheduler, ctx } = makeDo({ ASSISTANT_V2: 'shadow' });
    const res = await scheduler.watchdogTick(T0);
    // Сівба сама озброїла alarm (інваріант alarm=min(due_at) живе в
    // #syncRegistry), тож тікати нема по що: перша поява — через period.
    expect(res.ticked).toBe(false);
    const jobs = await jobsOf(scheduler);
    // Не пінимо перелік — він росте з реєстром; контракт: усі види посіяні.
    expect(jobs.map((j) => j.kind).sort()).toEqual(Object.keys(SCHEDULER_TASKS).sort());
    expect(ctx.alarm).toBe(T0 + MIN5);
  });

  it('живий alarm сторож не чіпає', async () => {
    const { scheduler } = makeDo({ ASSISTANT_V2: 'shadow' });
    await scheduler.watchdogTick(T0); // alarm = T0+5хв
    const res = await scheduler.watchdogTick(T0 + 60_000);
    expect(res.ticked).toBe(false);
  });

  it('прострочений понад грейс alarm — сторож рятує і виконує задачу', async () => {
    const { scheduler } = makeDo(
      { ASSISTANT_V2: 'shadow' },
      { hb: { periodMin: 5, shadowSafe: true, run: async () => {} } },
    );
    await scheduler.watchdogTick(T0); // поява о T0+5хв
    const late = T0 + MIN5 + WATCHDOG_GRACE_MS + 1_000;
    const res = await scheduler.watchdogTick(late);
    expect(res).toMatchObject({ ticked: true, ran: 1 });
    const [job] = await jobsOf(scheduler);
    expect(job?.last_status).toBe('ok');
    expect(job?.attempts).toBe(1);
  });

  it('kind, якого більше нема в реєстрі, прибирається із таблиці', async () => {
    const { scheduler } = makeDo({ ASSISTANT_V2: 'shadow' });
    await scheduler.watchdogTick(T0);
    scheduler.tasks = { fresh: { periodMin: 5, shadowSafe: true, run: async () => {} } } as never;
    await scheduler.watchdogTick(T0 + MIN5 + WATCHDOG_GRACE_MS + 1_000);
    expect((await jobsOf(scheduler)).map((j) => j.kind)).toEqual(['fresh']);
  });
});

describe('SchedulerDO — тік', () => {
  const seeded = async (env: Record<string, unknown>, tasks: Record<string, TaskDef>) => {
    const made = makeDo(env, tasks);
    await made.scheduler.watchdogTick(T0); // сівба, перша поява T0+period
    return made;
  };

  it('збій однієї задачі не зачіпає решту (B11), слід у last_status', async () => {
    const ran: string[] = [];
    const { scheduler } = await seeded(
      { ASSISTANT_V2: 'on' },
      {
        broken: {
          periodMin: 5,
          run: async () => {
            throw new Error('навмисний збій');
          },
        },
        healthy: {
          periodMin: 5,
          run: async () => {
            ran.push('healthy');
          },
        },
      },
    );
    const res = await scheduler.tick(T0 + MIN5, 'watchdog');
    expect(res).toMatchObject({ due: 2, ran: 2 });
    expect(ran).toEqual(['healthy']);
    const jobs = await jobsOf(scheduler);
    expect(jobs.find((j) => j.kind === 'broken')?.last_status).toMatch(/^error: навмисний збій/);
    expect(jobs.find((j) => j.kind === 'healthy')?.last_status).toBe('ok');
  });

  it('dedupe: другий тік по ту саму появу не виконує задачу вдруге', async () => {
    const run = vi.fn(async () => {});
    const { scheduler } = await seeded({ ASSISTANT_V2: 'on' }, { once: { periodMin: 5, run } });
    await scheduler.tick(T0 + MIN5, 'watchdog');
    expect(run).toHaveBeenCalledTimes(1);
    // Симулюємо гонку «сторож уже виконав, alarm прийшов по ту саму появу»:
    // повертаємо due_at назад, лишивши dedupe_key виконаної появи.
    const first = new Date(T0 + MIN5).toISOString();
    // @ts-expect-error приватного API нема — правимо таблицю напряму через фейк
    scheduler.ctx.storage.sql.exec('UPDATE jobs SET due_at = ?', first);
    const res = await scheduler.tick(T0 + MIN5 + 1_000, 'alarm');
    expect(run).toHaveBeenCalledTimes(1); // не виконалась удруге
    expect(res.ran).toBe(0);
    // ...але поява посунулась — задача не висить вічно простроченою.
    const [job] = await jobsOf(scheduler);
    expect(Date.parse(job?.due_at ?? '')).toBeGreaterThan(T0 + MIN5);
  });

  it('shadow: задача без shadowSafe НЕ виконується — лише слід shadow', async () => {
    const run = vi.fn(async () => {});
    const { scheduler } = await seeded(
      { ASSISTANT_V2: 'shadow' },
      { sideEffect: { periodMin: 5, run } },
    );
    await scheduler.tick(T0 + MIN5, 'watchdog');
    expect(run).not.toHaveBeenCalled();
    expect((await jobsOf(scheduler))[0]?.last_status).toBe('shadow');
  });

  it('on: та сама задача виконується по-справжньому', async () => {
    const run = vi.fn(async () => {});
    const { scheduler } = await seeded(
      { ASSISTANT_V2: 'on' },
      { sideEffect: { periodMin: 5, run } },
    );
    await scheduler.tick(T0 + MIN5, 'watchdog');
    expect(run).toHaveBeenCalledTimes(1);
    expect((await jobsOf(scheduler))[0]?.last_status).toBe('ok');
  });

  it('після тіку due_at посунуто на наступну появу і alarm переставлено', async () => {
    const { scheduler, ctx } = await seeded(
      { ASSISTANT_V2: 'on' },
      { t: { periodMin: 5, run: async () => {} } },
    );
    await scheduler.tick(T0 + MIN5, 'watchdog');
    const [job] = await jobsOf(scheduler);
    expect(job?.due_at).toBe(new Date(T0 + 2 * MIN5).toISOString());
    expect(ctx.alarm).toBe(T0 + 2 * MIN5);
  });

  it('разова задача (period=null) зникає після успіху', async () => {
    const { scheduler } = makeDo(
      { ASSISTANT_V2: 'on' },
      { periodic: { periodMin: 5, run: async () => {} } },
    );
    await scheduler.watchdogTick(T0);
    // @ts-expect-error фейк дозволяє засіяти разову задачу напряму
    scheduler.ctx.storage.sql.exec(
      `INSERT INTO jobs (id, kind, due_at, period) VALUES ('r1', 'periodic', ?, NULL)`,
      new Date(T0).toISOString(),
    );
    await scheduler.tick(T0 + 1_000, 'watchdog');
    expect((await jobsOf(scheduler)).map((j) => j.id)).toEqual(['periodic']);
  });
});

describe('SchedulerDO — джитер', () => {
  it('alarm-тік записує запізнення відносно найранішої появи', async () => {
    const { scheduler } = makeDo(
      { ASSISTANT_V2: 'shadow' },
      { hb: { periodMin: 5, shadowSafe: true, run: async () => {} } },
    );
    await scheduler.watchdogTick(T0); // поява T0+5хв
    await scheduler.tick(T0 + MIN5 + 7_000, 'alarm'); // alarm запізнився на 7с
    const { jitter } = await scheduler.status();
    expect(jitter).toMatchObject({ count: 1, minMs: 7_000, maxMs: 7_000 });
  });

  it('watchdog-тік джитер НЕ пише: він міряв би крон, а не alarm', async () => {
    const { scheduler } = makeDo(
      { ASSISTANT_V2: 'shadow' },
      { hb: { periodMin: 5, shadowSafe: true, run: async () => {} } },
    );
    await scheduler.watchdogTick(T0);
    await scheduler.tick(T0 + MIN5 + 7_000, 'watchdog');
    expect((await scheduler.status()).jitter).toBeNull();
  });

  it('рятунок простроченої появи рахується у watchdogRescues — слід втраченого alarm', async () => {
    const { scheduler } = makeDo(
      { ASSISTANT_V2: 'shadow' },
      { hb: { periodMin: 5, shadowSafe: true, run: async () => {} } },
    );
    await scheduler.watchdogTick(T0); // alarm = T0+5хв
    // Alarm «загубився»: сторож приходить далеко після появи і рятує її.
    await scheduler.watchdogTick(T0 + MIN5 + WATCHDOG_GRACE_MS + 1_000);
    const { watchdogRescues, jitter } = await scheduler.status();
    expect(watchdogRescues).toBe(1);
    expect(jitter).toBeNull(); // семпла немає — саме тому і є лічильник
  });
});

describe('SchedulerDO — прапорець і реєстр', () => {
  it('alarm при ASSISTANT_V2=off згасає: не виконує задач і не переставляє себе', async () => {
    const run = vi.fn(async () => {});
    const { scheduler, ctx } = makeDo(
      { ASSISTANT_V2: 'shadow' },
      { hb: { periodMin: 5, shadowSafe: true, run } },
    );
    await scheduler.watchdogTick(T0); // озброїли alarm у shadow
    // Прапорець повернули на off — DO прокидається востаннє і засинає.
    (scheduler.env as { ASSISTANT_V2: string }).ASSISTANT_V2 = 'off';
    ctx.alarm = null; // workerd знімає alarm перед викликом обробника
    await scheduler.alarm();
    expect(run).not.toHaveBeenCalled();
    expect(ctx.alarm).toBeNull(); // не переозброївся — «off» справді вимикає
  });

  it('порожній реєстр не ламає сівбу (NOT IN () — синтаксична пастка SQLite)', async () => {
    const { scheduler } = makeDo({ ASSISTANT_V2: 'shadow' }, {});
    const res = await scheduler.watchdogTick(T0);
    expect(res.ticked).toBe(true);
    expect(await jobsOf(scheduler)).toEqual([]);
  });

  it('незмінний реєстр не пересівається щотіку: перша поява НЕ зсувається', async () => {
    const { scheduler } = makeDo({ ASSISTANT_V2: 'shadow' });
    await scheduler.watchdogTick(T0);
    const [before] = await jobsOf(scheduler);
    // Другий сторож-виклик пізніше: якби сівба бігала щоразу, INSERT OR IGNORE
    // був би no-op і так, але DELETE+INSERT — зайва робота; знімок реєстру
    // робить сівбу разовою. Поява лишається тією самою.
    await scheduler.watchdogTick(T0 + 60_000);
    const [after] = await jobsOf(scheduler);
    expect(after?.due_at).toBe(before?.due_at);
  });

  it('нова задача з раннім due переставляє alarm навіть при свіжому alarm', async () => {
    // Інваріант alarm=min(due_at): задача з добовим періодом ставить alarm
    // далеко; додана поруч 5-хвилинна не сміє чекати добу під «свіжим» alarm.
    const daily = { periodMin: 1440, shadowSafe: true, run: async () => {} };
    const { scheduler, ctx } = makeDo({ ASSISTANT_V2: 'shadow' }, { daily });
    await scheduler.watchdogTick(T0);
    expect(ctx.alarm).toBe(T0 + 1440 * 60_000);
    scheduler.tasks = {
      daily,
      fast: { periodMin: 5, shadowSafe: true, run: async () => {} },
    } as never;
    const res = await scheduler.watchdogTick(T0 + 60_000);
    expect(res.ticked).toBe(false); // alarm свіжий — тік не потрібен…
    expect(ctx.alarm).toBe(T0 + 60_000 + MIN5); // …але alarm уже на новій появі
  });

  it('зміна periodMin наявного kind доїжджає до таблиці (стара каденція не вічна)', async () => {
    const { scheduler } = makeDo(
      { ASSISTANT_V2: 'shadow' },
      {
        t: { periodMin: 5, shadowSafe: true, run: async () => {} },
      },
    );
    await scheduler.watchdogTick(T0);
    scheduler.tasks = { t: { periodMin: 15, shadowSafe: true, run: async () => {} } } as never;
    await scheduler.watchdogTick(T0 + 60_000);
    const [job] = await jobsOf(scheduler);
    expect(job?.period).toBe(15);
  });
});
