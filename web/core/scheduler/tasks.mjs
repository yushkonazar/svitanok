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
  // Сьогодні це перевірка СТАРОГО хоста (agentHostHealthCheck); kind
  // канонічний — на етапі 2 під ним стане handshake нового мозку (01 §2.2).
  'brain-health': { periodMin: 5, run: agentHostHealthCheck },
  'brief-dispatch': { periodMin: 5, run: autoBriefDispatch },
  'dead-man': { periodMin: 5, run: deadMansCheck },
  'checkin-nudge': { periodMin: 5, run: checkinNudgeCheck },
  'sleep-nudge': { periodMin: 5, run: sleepNudgeCheck },
  'tg-setup': { periodMin: 5, run: autoTelegramSetup },
  'archive-monthly': { periodMin: 5, run: archiveMonthly },
  'levers-weekly': { periodMin: 5, run: computeLevers },
};
