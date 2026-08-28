// Реєстр задач планувальника: kind (канонічні імена 07 §7) -> {periodMin,
// shadowSafe, run}. Етап 1, PR-3: десять крон-задач зареєстровано як види.
//
// Функції задач НЕ переносились фізично — реєстр посилається на ті самі
// експорти cron.mjs / agent-runtime.mjs, які виконує і легасі CRON_TASKS:
// доки ASSISTANT_V2 != on, працює старий цикл (03-plan: «тримати обидва до
// кінця етапу 2»), і два місця з однією логікою — це рівно одна логіка.
// Фізичний переїзд у tasks/* станеться разом із видаленням легасі-шляху на
// етапі 2, коли лишиться один читач.
//
// У shadow задачі без shadowSafe планувальник лише логує — подвійних ефектів
// поруч зі старим кроном немає. periodMin: 5 у всіх десяти: кожна задача, як
// і в кроні, САМА гейтиться київською годиною в момент виконання й
// ідемпотентна за добу — пʼятихвилинна поява плюс гейт = багато спроб, рівно
// один ефект (той самий мотив, що в шапці cron.mjs).

import {
  checkReminders,
  autoBriefDispatch,
  deadMansCheck,
  checkinNudgeCheck,
  sleepNudgeCheck,
  autoTelegramSetup,
  archiveMonthly,
  computeLevers,
} from '../../cron.mjs';
import { agentRunWatchdog, agentHostHealthCheck } from '../../agent-runtime.mjs';
import { drainOutbox } from '../tg/outbox.mjs';
import { checkBrainHandshake } from '../brain/health.mjs';
import { memorySummarize } from '../brain/summarize.mjs';
import { kickPendingThreads } from '../prerouter.mjs';

/**
 * @typedef {{
 *   periodMin: number,
 *   shadowSafe?: boolean,
 *   run: (env: Env) => Promise<unknown>,
 * }} SchedulerTaskDef
 */

/** @type {Record<string, SchedulerTaskDef>} */
export const SCHEDULER_TASKS = {
  // Носій заміру джитера і канарка shadow-режиму: єдина задача, що
  // ВИКОНУЄТЬСЯ (а не логується) і в shadow — без побічних ефектів.
  heartbeat: {
    periodMin: 5,
    shadowSafe: true,
    run: async () => {
      console.log('scheduler: heartbeat');
    },
  },
  reminder: { periodMin: 5, run: checkReminders },
  'run-watchdog': { periodMin: 5, run: agentRunWatchdog },
  // Обидва мозки під одним канонічним kind: старий хост (agentHostHealthCheck,
  // живе до кінця етапу 2) і handshake нового (checkBrainHandshake - тихий
  // no-op, доки BRAIN_URL не заданий). Збої ізольовані: розсинхрон нового не
  // глушить перевірку старого і навпаки.
  'brain-health': {
    periodMin: 5,
    run: async (env) => {
      try {
        await agentHostHealthCheck(env);
      } catch (/** @type {any} */ e) {
        console.error('brain-health: перевірка старого хоста впала', e?.message);
      }
      const handshake = await checkBrainHandshake(env);
      // «Підняття» черг тредів (ADR-039, S-0-7) + сторож мертвих claim-ів
      // (усередині kickPendingThreads): щойно мозок ЖИВИЙ - ok АБО desync
      // (ревʼю PR-3: desync = версії розійшлись, /run працює; блокувати
      // підняття означало б повторити сліпоту інциденту 19.07). Без нового
      // kind - той самий 5-хвилинний такт.
      const state = /** @type {any} */ (handshake)?.state;
      if (state === 'ok' || state === 'desync') {
        try {
          await kickPendingThreads(env);
        } catch (/** @type {any} */ e) {
          console.error('brain-health: підняття черг впало', e?.message);
        }
      }
    },
  },
  'brief-dispatch': { periodMin: 5, run: autoBriefDispatch },
  'dead-man': { periodMin: 5, run: deadMansCheck },
  'checkin-nudge': { periodMin: 5, run: checkinNudgeCheck },
  'sleep-nudge': { periodMin: 5, run: sleepNudgeCheck },
  'tg-setup': { periodMin: 5, run: autoTelegramSetup },
  'archive-monthly': { periodMin: 5, run: archiveMonthly },
  'levers-weekly': { periodMin: 5, run: computeLevers },
  // Sweeper outbox (PR-7): ретраї 429/збоїв і повернення завислих claim-ів.
  // Основний драйн - одразу в deliver/status; це страховка.
  'outbox-drain': { periodMin: 5, run: async (env) => drainOutbox(env) },
  // Згортки памʼяті (етап 2 PR-2, ADR-038): 04:00 Києва, гейт усередині
  // задачі; без shadowSafe - у shadow лише лог, бойово з ASSISTANT_V2=on.
  'memory-summarize': { periodMin: 5, run: async (env) => memorySummarize(env) },
};
