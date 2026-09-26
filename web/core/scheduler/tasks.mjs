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
import { monoReconcileTask } from '../finance/reconcile.mjs';
import { financeEveningTask } from '../finance/evening.mjs';
import { subscriptionRemindTask } from '../finance/subscriptions.mjs';
import { inboxDigestTask } from '../inbox/digest.mjs';
import { retentionCleanupTask } from '../retention/cleanup.mjs';
import { resumePendingForgetAll } from '../export/forget-all.mjs';
import { kickPendingThreads } from '../prerouter.mjs';
import { mailTriageTask } from '../brief/mail-triage.mjs';
import { refreshBriefCalendar } from '../brief/calendar-snapshot.mjs';
import { secretExpiryTask } from '../ops/secret-expiry.mjs';
import { quotaCheckTask } from '../ops/quota-check.mjs';
import { reconcileMemoryProjection } from '../memory.mjs';
import { reconcileKnowledgeProjection } from '../knowledge-base.mjs';

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
    // ⚠️ 1, не 5: планувальник живе на alarm'ах DO, тож період цієї задачі
    // ні від кого не залежить, а власник бачив нагадування із запізненням до
    // пʼяти хвилин (прогін 08.09). Ціна - ~1440 тіків на добу замість 288;
    // коли нічого не настало, тік - це один SELECT у D1.
    periodMin: 1,
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
  // Брифінг (ADR-026: логіка лишається в Actions). Ядро перед відправкою
  // кладе в KV знімок календаря на добу - з етапу 7 PR-2 брифінг не має
  // Google-токена й читає готовий список звідти (05-ops §2).
  'brief-dispatch': {
    periodMin: 5,
    run: async (env) => {
      try {
        await refreshBriefCalendar(env);
      } catch (/** @type {any} */ e) {
        // Календар не має права зірвати саму відправку брифінгу.
        console.error('brief-dispatch: знімок календаря впав', e?.message);
      }
      return autoBriefDispatch(env);
    },
  },
  // Тріаж пошти в ядрі (07 §7, ADR-027, етап 7 PR-2): кожні 15 хв - нові
  // листи в KV `state.mailTriage`, звідки їх бере брифінг. Гейт періоду -
  // усередині задачі (планувальник тікає щопʼять).
  'mail-triage': { periodMin: 5, run: async (env) => mailTriageTask(env) },
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
  // Pending/failed D1 → Vectorize generations are recoverable: this retry is
  // idempotent by stable vector ids and never makes a partial version visible.
  'memory-projection-reconcile': {
    periodMin: 5,
    run: async (env) => {
      if (!env.DB || !env.AI || !env.VECTORIZE) return { skipped: 'not-configured' };
      return reconcileMemoryProjection(env, Date.now());
    },
  },
  // Документи з allowlist мають незалежну проєкцію: не змішуємо її з
  // memory_chunks і не перечитуємо Drive під час retry.
  'knowledge-projection-reconcile': {
    periodMin: 5,
    run: async (env) => reconcileKnowledgeProjection(env),
  },
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
  // Звірка Mono (етап 6 PR-1, 07 §7, S-4-9/S-4-11): 23:30 Києва - client-info,
  // адреса вебхука і виписка за добу. РІВНО ОДИН зовнішній виклик за тік
  // (ліміт Mono 1/60 с), крок - у KV; поки списку рахунків немає, фаза
  // client-info вмикається в будь-яку годину (бар'єр вебхука S-4-12).
  'mono-reconcile': { periodMin: 5, run: async (env) => monoReconcileTask(env) },
  // Вечірній рядок про гроші (етап 6 PR-2, S-4-7): 21:00 Києва, тиша при
  // нулі покупок; гейт години й мітка дня - усередині задачі.
  'finance-evening': { periodMin: 5, run: async (env) => financeEveningTask(env) },
  // Нагадування про підписку (етап 6 PR-2, S-4-6): 11:00 Києва за два дні до
  // списання, з кнопкою «Скасувати підписку в обліку».
  'subscription-remind': { periodMin: 5, run: async (env) => subscriptionRemindTask(env) },
  // Дайджест чатів (етап 6 PR-4, S-2-5): 08:30 Києва, лише коли ввімкнено у
  // facts.setting.inbox_digest і є про що писати.
  'inbox-digest': { periodMin: 5, run: async (env) => inboxDigestTask(env) },
  // Ретенція (етап 6 PR-4, 07 §1): 04:00 Києва - вхідні 30 діб, транзакції
  // 24 міс, телеметрія 90 діб і решта строків зі схеми.
  'retention-cleanup': { periodMin: 5, run: async (env) => retentionCleanupTask(env) },
  // Після T2 «забудь усе», поданого з активного model run: сам прогін спершу
  // abort-иться, а цей 5-хвилинний reconcile фізично прибирає SDK-сесію та
  // решту копій. Receipt зберігає право/стан, тож повторного слова не треба.
  'deletion-reconcile': { periodMin: 5, run: async (env) => resumePendingForgetAll(env) },
  // Строки секретів (етап 7 PR-5, 05-ops §3): 10:00 Києва - нагадування за 30
  // і 7 днів + щоденна звірка скоупів Google. Дати - з facts, не з памʼяті.
  'secret-expiry': { periodMin: 5, run: async (env) => secretExpiryTask(env) },
  // Платні лічильники (етап 7 PR-5, 01 §7): 09:00 Києва - частка місяця й
  // прогноз за темпом; алерти перетину в bumpQuota лишаються як були.
  'quota-check': { periodMin: 5, run: async (env) => quotaCheckTask(env) },
};
