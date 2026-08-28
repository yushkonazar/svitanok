// Реєстр задач планувальника (етап 1, PR-3) і гейт scheduled() за прапорцем.
//
// Реєстр перевіряється ТОТОЖНІСТЮ функцій, а не назвами: доки ASSISTANT_V2 !=
// on, ті самі задачі виконує легасі CRON_TASKS, і будь-яке «майже те саме»
// (обгортка, копія, інша функція) означало б, що shadow-порівняння і майбутнє
// перемикання зіставляють різну поведінку.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { CRON_TASKS } from '../web/worker.js';
import { SCHEDULER_TASKS } from '../web/core/scheduler/tasks.mjs';
import {
  autoBriefDispatch,
  deadMansCheck,
  checkinNudgeCheck,
  sleepNudgeCheck,
  autoTelegramSetup,
  archiveMonthly,
  computeLevers,
} from '../web/cron.mjs';
import { agentRunWatchdog } from '../web/agent-runtime.mjs';
import { workerEnv } from './helpers/env.js';

describe('SCHEDULER_TASKS — реєстр видів (07 §7)', () => {
  it('канонічні kind-и: heartbeat + десять крон-задач + sweeper outbox + memory-summarize (етап 2 PR-2)', () => {
    expect(Object.keys(SCHEDULER_TASKS)).toEqual([
      'heartbeat',
      'reminder',
      'run-watchdog',
      'brain-health',
      'brief-dispatch',
      'dead-man',
      'checkin-nudge',
      'sleep-nudge',
      'tg-setup',
      'archive-monthly',
      'levers-weekly',
      'outbox-drain',
      'memory-summarize',
    ]);
  });

  it('run — ті САМІ функції, що виконує легасі CRON_TASKS (тотожність)', () => {
    const expected: Record<string, (env: never) => Promise<unknown>> = {
      // reminder тепер композит (етап 2 PR-7): легасі-джерело KV + нове D1.
      // Тотожність там неможлива; склад перевіряє окремий тест нижче.
      'run-watchdog': agentRunWatchdog,
      // brain-health - композит (легасі-хост + handshake нового мозку, PR-9),
      // тотожність там неможлива; його склад перевіряє окремий тест нижче.
      'brief-dispatch': autoBriefDispatch,
      'dead-man': deadMansCheck,
      'checkin-nudge': checkinNudgeCheck,
      'sleep-nudge': sleepNudgeCheck,
      'tg-setup': autoTelegramSetup,
      'archive-monthly': archiveMonthly,
      'levers-weekly': computeLevers,
    };
    for (const [kind, fn] of Object.entries(expected)) {
      expect(SCHEDULER_TASKS[kind]?.run, kind).toBe(fn);
    }
    // І легасі-список зібраний із тих самих функцій — обидва читачі однієї логіки.
    const legacy = new Set(CRON_TASKS.map((t: { run: unknown }) => t.run));
    for (const fn of Object.values(expected)) expect(legacy.has(fn)).toBe(true);
  });

  it('reminder: композит шле з ОБОХ джерел, і збій KV не глушить D1', async () => {
    // До фліпа ASSISTANT_V2=on нагадування живуть у двох сховищах: створені
    // через /remind - у KV, створені мозком - у D1. Пропустити одне з них
    // означало б мовчки не доставити частину.
    const calls: string[] = [];
    vi.doMock('../web/cron.mjs', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      checkReminders: async () => {
        calls.push('kv');
        throw new Error('KV лежить');
      },
    }));
    vi.doMock('../web/core/reminders/deliver.mjs', () => ({
      deliverDueReminders: async () => {
        calls.push('d1');
        return { sent: 0 };
      },
    }));
    vi.resetModules();
    const { SCHEDULER_TASKS: fresh } = await import('../web/core/scheduler/tasks.mjs');
    await expect(fresh.reminder!.run(workerEnv({}))).resolves.not.toThrow();
    expect(calls).toEqual(['kv', 'd1']);
    vi.doUnmock('../web/cron.mjs');
    vi.doUnmock('../web/core/reminders/deliver.mjs');
    vi.resetModules();
  });

  it('reminder: після фліпа KV-гілка МОВЧИТЬ - інакше подвійна доставка', async () => {
    // У вікні міграції запис лежить в обох сховищах; якби обидві гілки
    // працювали при `on`, власник отримав би дві копії одного нагадування
    // (ревʼю PR-7).
    const calls: string[] = [];
    vi.doMock('../web/cron.mjs', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      checkReminders: async () => void calls.push('kv'),
    }));
    vi.doMock('../web/core/reminders/deliver.mjs', () => ({
      deliverDueReminders: async () => {
        calls.push('d1');
        return { sent: 0 };
      },
    }));
    vi.resetModules();
    const { SCHEDULER_TASKS: fresh } = await import('../web/core/scheduler/tasks.mjs');

    await fresh.reminder!.run(workerEnv({ ASSISTANT_V2: 'on' }));
    expect(calls).toEqual(['d1']);

    calls.length = 0;
    await fresh.reminder!.run(workerEnv({ ASSISTANT_V2: 'shadow' }));
    expect(calls).toEqual(['kv', 'd1']);

    vi.doUnmock('../web/cron.mjs');
    vi.doUnmock('../web/core/reminders/deliver.mjs');
    vi.resetModules();
  });

  it('brain-health: композит не кидає, коли ні старий хост, ні мозок не сконфігуровані', async () => {
    // Легасі-перевірка рано виходить без LLM_HOST_*, handshake — без BRAIN_URL;
    // жоден із них не сміє валити задачу (ізоляція всередині композита).
    await SCHEDULER_TASKS['brain-health']?.run(workerEnv() as never); // не кидає
  });

  it('усі появи 5-хвилинні; shadowSafe — лише heartbeat', () => {
    for (const [kind, def] of Object.entries(SCHEDULER_TASKS)) {
      expect(def.periodMin, kind).toBe(5);
      // Десять перенесених задач мають побічні ефекти (Telegram, KV, GitHub) —
      // у shadow вони мусять лише логуватись, інакше кожен ефект подвоївся б.
      expect(def.shadowSafe === true, kind).toBe(kind === 'heartbeat');
    }
  });
});

describe('scheduled() — гейт легасі-крону за прапорцем', () => {
  let reads: string[];
  let watchdogCalls: string[];

  const makeEnv = (assistantV2?: string) =>
    workerEnv({
      BRIEFING: {
        // agentRunWatchdog читає 'agentRuns' безумовно — надійний маркер того,
        // що легасі-цикл справді бігав.
        get: async (k: string) => {
          reads.push(k);
          return null;
        },
        put: async () => {},
        list: async () => ({ keys: [] }),
      },
      SCHEDULER: {
        getByName: (name: string) => ({
          watchdogTick: async () => {
            watchdogCalls.push(name);
            return { ticked: false };
          },
        }),
      },
      ...(assistantV2 === undefined ? {} : { ASSISTANT_V2: assistantV2 }),
    });

  const runScheduled = async (env: unknown) => {
    const ctxTasks: Promise<unknown>[] = [];
    await worker.scheduled({}, env as never, {
      waitUntil: (p: Promise<unknown>) => ctxTasks.push(p),
    });
    await Promise.all(ctxTasks);
  };

  beforeEach(() => {
    reads = [];
    watchdogCalls = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('off (прапорця немає): легасі-крон бігає, планувальник мовчить', async () => {
    await runScheduled(makeEnv());
    expect(reads).toContain('agentRuns');
    expect(watchdogCalls).toEqual([]);
  });

  it('shadow: бігають ОБИДВА — легасі виконує, планувальник тікає поруч', async () => {
    await runScheduled(makeEnv('shadow'));
    expect(reads).toContain('agentRuns');
    expect(watchdogCalls).toEqual(['scheduler']);
  });

  it('on: легасі-крон мовчить — задачі належать планувальнику', async () => {
    await runScheduled(makeEnv('on'));
    expect(reads).not.toContain('agentRuns');
    expect(watchdogCalls).toEqual(['scheduler']);
  });
});

describe('brain-health → підняття черг (ревʼю PR-3)', () => {
  const kickEnv = (fetchOk: boolean) => {
    const kv = new Map<string, string>();
    kv.set('brainExpected', JSON.stringify({ version: '1.0.0', gitSha: 'same-sha' }));
    let snapshotCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fetchOk
          ? new Response(JSON.stringify({ version: '1.0.0', gitSha: 'same-sha' }), { status: 200 })
          : new Response('gateway error', { status: 502 }),
      ),
    );
    const env = workerEnv({
      ASSISTANT_V2: 'shadow',
      BRAIN_URL: 'https://brain.test',
      BRAIN_ACCESS_CLIENT_ID: 'cid',
      BRAIN_ACCESS_CLIENT_SECRET: 'csec',
      BRIEFING: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        delete: async () => undefined,
        list: async () => ({ keys: [] }),
      },
      RUN_REGISTRY: {
        getByName: () => ({
          sweepStale: async () => [],
          threadSweep: async () => [],
          threadsSnapshot: async () => {
            snapshotCalls += 1;
            return {};
          },
        }),
      },
    });
    return { env, calls: () => snapshotCalls };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handshake ok → сторож+kick викликані (threadsSnapshot торкнуто)', async () => {
    const { env, calls } = kickEnv(true);
    await SCHEDULER_TASKS['brain-health']?.run(env as never);
    expect(calls()).toBeGreaterThan(0);
  });

  it('handshake down → kick НЕ викликається', async () => {
    const { env, calls } = kickEnv(false);
    await SCHEDULER_TASKS['brain-health']?.run(env as never);
    expect(calls()).toBe(0);
  });
});
