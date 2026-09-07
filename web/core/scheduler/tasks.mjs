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
import { deliverDueReminders } from '../reminders/deliver.mjs';
import { checkBrainHandshake } from '../brain/health.mjs';
import { memorySummarize } from '../brain/summarize.mjs';
import { weeklyReviewTask } from '../brain/weekly-review-task.mjs';
import { backupTask } from '../backup/task.mjs';
import { dailyHintTask } from '../hints/daily-hint.mjs';
import { dayPlanKickTask } from '../day-plan/kick.mjs';
import { chainNudgeTask } from '../chains/nudge.mjs';
import { priceTrackKickTask } from '../chains/price.mjs';
import { steamCheckTask } from '../steam/check.mjs';
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
  // Нагадування з ДВОХ сховищ до фліпа (етап 2 PR-7): легасі-крон шле з KV
  // (там живе все, створене через /remind), нова гілка - з D1 (там усе, що
  // створив мозок інструментом). Записи різні, тож дублів немає; після фліпа
  // й міграції KV-джерело зникає разом із легасі-циклом. Збій одного джерела
  // не глушить друге - та сама ізоляція, що в brain-health.
  reminder: {
    periodMin: 5,
    run: async (env) => {
      // ⚠️ KV-гілка мовчить при `on` (ревʼю PR-7): після фліпа джерелом стає
      // D1, і залишений KV-читач слав би те саме вдруге - міграція копіює
      // записи, тож у вікні між вставкою і чисткою вони лежать в обох
      // сховищах, і кожне джерело доставило б свою копію. Власник не може
      // відрізнити повтор від нового нагадування.
      if (env.ASSISTANT_V2 !== 'on') {
        try {
          await checkReminders(env);
        } catch (/** @type {any} */ e) {
          console.error('reminder: легасі-джерело (KV) впало', e?.message);
        }
      }
      await deliverDueReminders(env);
    },
  },
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
  // Тижневий звіт (етап 3 PR-3, S-9-1/S-9-4): неділя 09:00 Києва, повтор о
  // 12:00 при збої; гейти й стан тижня - усередині задачі.
  'weekly-review': { periodMin: 5, run: async (env) => weeklyReviewTask(env) },
  // Бекап (етап 3 PR-6, 05-ops §бекапи): неділя 03:00 Києва → Drive; алерт
  // при збої і о 04:00 без файлу; стан тижня - у задачі.
  backup: { periodMin: 5, run: async (env) => backupTask(env) },
  // Проактивна підказка (етап 3 PR-7, S-0-16): 10:00 Києва, ≤ 1 на добу,
  // один кандидат за пріоритетом; теми вимикає facts.setting.hint_mute_json.
  'daily-hint': { periodMin: 5, run: async (env) => dailyHintTask(env) },
  // План дня v2 (етап 3 PR-8, ADR-035): 00:05 Києва - ланцюг DayPlanChain на
  // завтра, якщо день робочий і не поїздка; вимикач - facts.setting.day_plan.
  'day-plan-kick': { periodMin: 5, run: async (env) => dayPlanKickTask(env) },
  // Ланцюги (етап 5 PR-2, S-1-6): «не натиснув кнопку» +5/+20 хв; стан
  // нагадувань - у state_json ланцюга, далі тиша.
  'chain-nudge': { periodMin: 5, run: async (env) => chainNudgeTask(env) },
  // Відстеження цін (етап 5 PR-3, 07 §7): 09:00 Києва - бажання purchase з url
  // без активного PriceTrack → старт (після збою Workflow чи появи привʼязки).
  'price-track-kick': { periodMin: 5, run: async (env) => priceTrackKickTask(env) },
  // Знижки на ігри (етап 5 PR-5, 07 §7): 10:00 Києва - батч ITAD по бажаннях
  // type=game; гейт години й мітка дня - усередині задачі.
  'steam-check': { periodMin: 5, run: async (env) => steamCheckTask(env) },
};
