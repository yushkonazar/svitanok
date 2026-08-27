// Реєстр задач планувальника (етап 1, PR-3) і гейт scheduled() за прапорцем.
//
// Реєстр перевіряється ТОТОЖНІСТЮ функцій, а не назвами: доки ASSISTANT_V2 !=
// on, ті самі задачі виконує легасі CRON_TASKS, і будь-яке «майже те саме»
// (обгортка, копія, інша функція) означало б, що shadow-порівняння і майбутнє
// перемикання зіставляють різну поведінку.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { CRON_TASKS } from '../web/worker.js';
import { SCHEDULER_TASKS } from '../web/core/scheduler/tasks.mjs';
import {
  checkReminders,
  autoBriefDispatch,
  deadMansCheck,
  checkinNudgeCheck,
  sleepNudgeCheck,
  autoTelegramSetup,
  archiveMonthly,
  computeLevers,
} from '../web/cron.mjs';
import { agentRunWatchdog, agentHostHealthCheck } from '../web/agent-runtime.mjs';
import { workerEnv } from './helpers/env.js';

describe('SCHEDULER_TASKS — реєстр видів (07 §7)', () => {
  it('канонічні kind-и: heartbeat + десять крон-задач + sweeper outbox', () => {
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
    ]);
  });

  it('run — ті САМІ функції, що виконує легасі CRON_TASKS (тотожність)', () => {
    const expected: Record<string, (env: never) => Promise<unknown>> = {
      reminder: checkReminders,
      'run-watchdog': agentRunWatchdog,
      'brain-health': agentHostHealthCheck,
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
