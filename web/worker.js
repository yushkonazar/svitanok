// Точка входу Worker'а: маршрути HTTP, диспетчер Telegram-апдейтів і цикл крону.
//
// ЩО ТУТ ЛИШИЛОСЬ ПІСЛЯ МОДУЛЯРИЗАЦІЇ (Фаза 5) — і чому саме це. Файл був на
// 5100 рядків і робив усе; тепер він робить ОДНЕ: приймає запит і віддає його
// тому, хто за нього відповідає. Уся предметна логіка живе в сусідніх модулях:
//
//   api-dashboard / weather-geo — ендпоінти Mini App
//   commands / callbacks        — текстові команди й inline-кнопки
//   agent-runtime               — прогін асистента (старт, крок, сторож)
//   proposals / reminders-actions — дії під ✅ і робота з нагадуваннями
//   cron                        — задачі п'ятихвилинного тіку
//   kv-store / google / telegram-client / llm-host — межі з зовнішнім світом
//
// Тут лишаються три речі, які НЕ мають дому деінде: розбір і автентифікація
// вебхука Telegram, таблиця маршрутів і послідовний цикл крон-задач.

import { verifyWebhookSecret, parseUpdate, isOwner, isDuplicate } from './tg-core.mjs';
import {
  isSleepStartCallback,
  parseReminderCancelCallbackData,
  parseReminderEditCallbackData,
  parseReminderDoneCallbackData,
  parseReminderSnoozeCallbackData,
} from './reminders-core.mjs';
import { parseAgendaCallbackData } from './calendar-core.mjs';
import { parseProposalCallbackData } from './agent-core.mjs';
// Клас Durable Object мусить бути експортований із ГОЛОВНОГО модуля Worker'а
// (це вимога Cloudflare), тож ре-експорт — не стилістика, а контракт деплою.
export { AgentRun } from './agent-run-do.mjs';
export { SchedulerDO } from './core/scheduler/do.mjs';
export { RunRegistryDO } from './core/run-registry/do.mjs';
export { StateStoreDO } from './core/state-store/do.mjs';
export { PendingProposalsDO } from './core/pending-proposals/do.mjs';
// Workflow плану дня (етап 3 PR-8) - той самий контракт деплою, що й DO.
export { DayPlanChain } from './core/day-plan/chain.mjs';
export { IdeaAnalysis } from './core/ideas/analysis.mjs';
export { TableChain } from './core/chains/table.mjs';
export { PriceTrack } from './core/chains/price.mjs';
export { TripChain } from './core/chains/trip.mjs';
export { InboxExport } from './core/chains/inbox-export.mjs';
import { SCHEDULER_DO_NAME } from './core/scheduler/do.mjs';
import { handleInternal } from './core/internal/router.mjs';
import { handleMonoWebhook, handleMonoTest, MONO_WEBHOOK_PREFIX } from './core/finance/webhook.mjs';
import { prerouteMessage, handleBrainCallback } from './core/prerouter.mjs';
import { handleAssistantStatus } from './core/assistant-status.mjs';
import {
  handleBusinessConnection,
  handleBusinessMessage,
  handleBusinessDeleted,
} from './core/inbox/connection.mjs';
import { parseRoadmapCallbackData } from './roadmap-core.mjs';
import { allowedUserIds, isPrimaryOwner, checkOwnerRead } from './auth-core.mjs';
import { json, readJsonBody, MAX_WEBHOOK_BODY_BYTES } from './http-core.mjs';
import {
  handleVote,
  handleEvent,
  handleSettings,
  handleSaved,
  handleStats,
} from './api-dashboard.mjs';
import { handleStatus } from './api-status.mjs';
import { handleArchiveRequest } from './api-archive.mjs';
import { handleLeversRequest } from './api-levers.mjs';
import { handleDeletionsRequest } from './api-deletions.mjs';
import { tgCall, trackIncomingMessage } from './telegram-client.mjs';
import { handleCommand, COOWNER_DENIED_TOAST } from './commands.mjs';
import {
  resolveCallbackToast,
  resolveReminderSnooze,
  resolveReminderSnoozePreset,
  resolveReminderCancel,
  resolveSleepStart,
  resolveReminderDone,
  resolveReminderCancelAll,
  resolveReminderEditPrompt,
  resolveAgendaCallback,
  resolveRoadmapCallback,
  REMINDER_CB_PREFIX,
} from './callbacks.mjs';
import {
  checkReminders,
  autoBriefDispatch,
  checkinNudgeCheck,
  sleepNudgeCheck,
  deadMansCheck,
  runTelegramSetup,
  autoTelegramSetup,
  archiveMonthly,
  computeLevers,
} from './cron.mjs';
import {
  handleLiveWeather,
  handleWeatherLocation,
  handleWeatherLocatePrompt,
} from './weather-geo.mjs';
import { handleAgentStep, agentRunWatchdog, agentHostHealthCheck } from './agent-runtime.mjs';
import { resolveProposalCallback } from './proposals.mjs';
import { loadState, updateState } from './kv-store.mjs';

/**
 * Фактична обробка апдейту (callback-резолв або handleCommand) + запис
 * lastUpdateId — викликається через ctx.waitUntil (Блок P2b): agent-цикл
 * (runAssistantAgent) може тривати до ~75с (3×25с callLlmHost-таймаут),
 * задовго для синхронної відповіді на вебхук (ризик Telegram-ретраю того
 * самого апдейту). Порядок дій ІДЕНТИЧНИЙ попередньому синхронному коду —
 * lastUpdateId пишеться ОСТАННІМ (не раніше!), щоб не затерти
 * jobPrefs/mockWeights, які міг оновити applyEvent усередині обробки.
 * Try/catch — waitUntil мовчки ковтає необроблені reject, лишаючи слід лише
 * в логах.
 */
async function processTelegramUpdate(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ origin,
) {
  try {
    // Telegram Business (кейс 2, етап 6 PR-3). Свідомо ПЕРШИМ і окремою
    // гілкою: `business_message` пише співрозмовник, а не власник, тож ані
    // trackIncomingMessage, ані prerouter, ані handleCommand до нього не
    // застосовні — його шлях закінчується рядком у D1 без жодного прогону.
    if (
      parsed.kind === 'business_connection' ||
      parsed.kind === 'business_message' ||
      parsed.kind === 'business_deleted'
    ) {
      await handleBusinessUpdate(env, /** @type {any} */ (parsed), Date.now());
      if (typeof parsed.updateId === 'number') {
        await updateState(env, (s) => ({ ...s, lastUpdateId: parsed.updateId }));
      }
      return;
    }
    if (parsed.kind === 'callback') {
      const proposalCb = parseProposalCallbackData(parsed.data);
      const agendaCb = parseAgendaCallbackData(parsed.data); // 'ev:' — CRUD /agenda
      const roadmapCb = parseRoadmapCallbackData(parsed.data);
      const reminderCancelId = parseReminderCancelCallbackData(parsed.data); // 'rc:' — §C4
      const reminderEditId = parseReminderEditCallbackData(parsed.data); // 'ru:' — CRUD
      const reminderDoneId = parseReminderDoneCallbackData(parsed.data); // 'rk:' — «✅ Виконано»
      const snoozePreset = parseReminderSnoozeCallbackData(parsed.data); // 'rs:' — extra b
      const isReminderSnooze =
        typeof parsed.data === 'string' && parsed.data.startsWith(REMINDER_CB_PREFIX);
      const isSleepStart = isSleepStartCallback(parsed.data); // 'sl:' — «🌙 Ліг спати»
      // Простір мозку 07 §9 (p:/c:/r:/a:/u:/m:, ADR-039) + голос v: (ADR-040):
      // свої префікси, з легасі не перетинаються (rc:/ru:/… - дволітерні).
      // null = не наш.
      //
      // deferred (ревʼю PR-4): робота, довша за вікно answerCallbackQuery
      // (розпізнавання - десятки секунд), виконується ПІСЛЯ відповіді на
      // callback - інакше Telegram устигає інвалідувати запит, і власник не
      // бачить тосту взагалі. Ми вже всередині ctx.waitUntil, тож проміс
      // дочекаються.
      /** @type {(() => Promise<void>)[]} */
      const deferred = [];
      const brainToast = isPrimaryOwner(env, parsed.fromId)
        ? await handleBrainCallback(env, parsed, Date.now(), (work) => deferred.push(work))
        : null;
      // S1/B1: кнопки — це ВИКЛЮЧНО мутації стану власника (прийняти пропозицію
      // в його календар, скасувати його нагадування, записати його сон, відмітити
      // його роадмеп). Жодної читальної серед них немає, тож межа рівно тут.
      const toast = !isPrimaryOwner(env, parsed.fromId)
        ? COOWNER_DENIED_TOAST
        : brainToast != null
          ? brainToast
          : proposalCb
            ? await resolveProposalCallback(env, parsed, proposalCb)
            : agendaCb
              ? await resolveAgendaCallback(env, parsed, agendaCb)
              : roadmapCb
                ? await resolveRoadmapCallback(env, parsed, roadmapCb)
                : reminderCancelId === 'all'
                  ? await resolveReminderCancelAll(env, parsed)
                  : reminderCancelId
                    ? await resolveReminderCancel(env, parsed, reminderCancelId)
                    : reminderEditId
                      ? await resolveReminderEditPrompt(env, parsed, reminderEditId)
                      : reminderDoneId
                        ? await resolveReminderDone(env, parsed, reminderDoneId)
                        : snoozePreset
                          ? await resolveReminderSnoozePreset(
                              env,
                              parsed,
                              snoozePreset.presetIdx,
                              snoozePreset.id,
                            )
                          : isReminderSnooze
                            ? await resolveReminderSnooze(
                                env,
                                parsed,
                                parsed.data.slice(REMINDER_CB_PREFIX.length),
                              )
                            : isSleepStart
                              ? await resolveSleepStart(env, parsed)
                              : await resolveCallbackToast(env, parsed);
      if (parsed.callbackId) {
        await tgCall(env, 'answerCallbackQuery', {
          callback_query_id: parsed.callbackId,
          text: toast,
        });
      }
      // Тост уже в дорозі - тепер довга частина (розпізнавання, старт прогону).
      for (const work of deferred) {
        await work().catch((err) => console.error('deferred callback work failed', err));
      }
    } else if (parsed.kind === 'message' && parsed.chatId != null) {
      // G1: спершу трекнути вхідне (перед handleCommand) — щоб уже цей-таки /clear
      // міг видалити й своє тригер-повідомлення разом із рештою.
      await trackIncomingMessage(env, parsed);
      // Новий шлях (ADR-039): on - усе в темі Асистент/DM; shadow - лише
      // префікс v2: (решта класифікується в runs і йде далі легасі); off/чуже -
      // false, і легасі працює як завжди.
      const handled = await prerouteMessage(env, parsed);
      if (!handled) await handleCommand(env, parsed, origin);
    }

    if (typeof parsed.updateId === 'number') {
      // Читання ПІСЛЯ applyEvent — той міг оновити jobPrefs/mockWeights у 'state';
      // updateState перечитує сам і мержить, а не кладе зверху свою копію.
      await updateState(env, (s) => ({ ...s, lastUpdateId: parsed.updateId }));
    }
  } catch (err) {
    console.error('processTelegramUpdate failed', err);
  }
}

/**
 * Апдейти Telegram Business (ADR-013): підключення власника, нове/виправлене
 * повідомлення з дозволеного чату, стерті повідомлення. Працює лише при
 * ASSISTANT_V2=on: до фліпа нового шляху немає, а старий про Business нічого
 * не знає.
 * @param {Env} env
 * @param {import('./tg-core.mjs').ParsedBusinessConnection
 *   | import('./tg-core.mjs').ParsedBusinessMessage
 *   | import('./tg-core.mjs').ParsedBusinessDeleted} parsed
 * @param {number} nowMs
 */
async function handleBusinessUpdate(env, parsed, nowMs) {
  if (env.ASSISTANT_V2 !== 'on') return;
  try {
    if (parsed.kind === 'business_connection') {
      await handleBusinessConnection(env, parsed, nowMs);
    } else if (parsed.kind === 'business_message') {
      await handleBusinessMessage(env, parsed, nowMs);
    } else {
      await handleBusinessDeleted(env, parsed);
    }
  } catch (/** @type {any} */ e) {
    // Збій запису одного повідомлення не має валити обробку наступних.
    console.error(`inbox: апдейт ${String(parsed.kind)} не оброблено`, e?.message);
  }
}

/** POST /api/telegram — Telegram Bot API webhook. Secret-token + owner + дедуп. */
async function handleTelegramWebhook(
  /** @type {Request} */ request,
  /** @type {Env} */ env,
  /** @type {ExecutionContext} */ ctx,
) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: 'no-webhook-secret' }, 500);
  }
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!verifyWebhookSecret(header, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'bad-secret' }, 401);
  }

  // Вебхук має ВЛАСНУ стелю: 16 КБ, що вистачає будь-якому /api/*, менші за
  // максимальний законний апдейт Telegram (див. MAX_WEBHOOK_BODY_BYTES).
  const parsedBody = await readJsonBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (!parsedBody.ok) return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  const update = parsedBody.body;
  const parsed = parseUpdate(update);

  // `business_message`/`business_deleted` приходять від СПІВРОЗМОВНИКА, тож
  // гейт «це власник» до них не застосовний — їх автентичність доводить
  // `business_connection_id`, який звіряється в core/inbox (той самий мотив,
  // що перевірка `account` у вебхуці Mono). `business_connection` іде через
  // гейт як звичайний апдейт: у ньому `user` — це власник.
  const business = parsed.kind === 'business_message' || parsed.kind === 'business_deleted';
  if (!business && !isOwner(parsed, allowedUserIds(env))) {
    // Не власник/не в списку дозволених — тихо ігноруємо, не палимо деталі стороннім.
    return json({ ok: true });
  }

  const preState = await loadState(env); // лише для дедуп-перевірки (read-only)
  if (isDuplicate(preState.lastUpdateId, parsed.updateId)) {
    return json({ ok: true }); // Telegram передоставляє апдейти — не обробляємо двічі.
  }

  // Ack одразу, обробка (може бути повільною — agent-цикл) — у фоні.
  ctx.waitUntil(processTelegramUpdate(env, parsed, new URL(request.url).origin));
  return json({ ok: true });
}

/** POST /api/telegram/setup -> ручний виклик runTelegramSetup. Auth тим самим
 *  заголовком, що й вебхук (X-Telegram-Bot-Api-Secret-Token) — не query-param
 *  (не осідає в логах). Лишається як фолбек/діагностика — щоденний
 *  autoTelegramSetup (нижче) робить те саме без ручного curl. */
async function handleTelegramSetup(/** @type {Request} */ request, /** @type {Env} */ env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: 'no-webhook-secret' }, 500);
  }
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!verifyWebhookSecret(header, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'bad-secret' }, 401);
  }
  const url = new URL(request.url);
  const ok = await runTelegramSetup(env, url.origin);
  return json({ ok, webhookUrl: `${url.origin}/api/telegram` });
}

/**
 * Задачі єдиного 5-хвилинного крону. Кожна сама себе гейтить за київською
 * годиною і сама ідемпотентна за добу. Жодних DST-костилів із набором
 * погодинних кронів: годину рахує kyivHour() у момент виконання, а не хвилина
 * крону.
 *
 * Назва поруч із функцією — не косметика: у логах Cloudflare падіння інакше
 * виглядає як анонімний стек із waitUntil, і незрозуміло, ЯКА із задач
 * впала (B11).
 */
export const CRON_TASKS = [
  { name: 'checkReminders', run: checkReminders }, // будь-яка хвилина
  { name: 'agentRunWatchdog', run: agentRunWatchdog }, // обірвані прогони агента
  { name: 'agentHostHealthCheck', run: agentHostHealthCheck }, // розсинхрон версій хоста
  { name: 'autoBriefDispatch', run: autoBriefDispatch }, // [08:00, 11:00) Київ, раз на добу
  { name: 'deadMansCheck', run: deadMansCheck }, // від 12:00 Київ, раз на добу
  { name: 'checkinNudgeCheck', run: checkinNudgeCheck }, // вікна чек-іну, раз на слот/добу
  { name: 'sleepNudgeCheck', run: sleepNudgeCheck }, // «Ліг спати» 23:00–02:00 + прибирання
  { name: 'autoTelegramSetup', run: autoTelegramSetup }, // самозапуск setup, раз на добу
  { name: 'archiveMonthly', run: archiveMonthly }, // місячні згортки в холодний ключ
  { name: 'computeLevers', run: computeLevers }, // шар звʼязків «Важелі», раз на тиждень
];

/**
 * Виконати крон-задачі ПОСЛІДОВНО, ізолювавши збій кожної (B11).
 *
 * Доти всі вісім були awaited підряд в одному ctx.waitUntil без try/catch:
 * throw у першій (типово Telegram лежить о 08:05 — tgCall помилку fetch не
 * ловить) забирав із собою решту. Брифінг не диспатчився, dead-man не
 * спрацьовував, нагадування не йшли — і все МОВЧКИ, бо waitUntil ковтає reject.
 *
 * ⚠️ Саме послідовно, НЕ Promise.allSettled: задачі роблять read-modify-write
 * KV без CAS, тож паралельні гілки в одному ізоляті перетинали б вікна
 * GET->PUT і затирали одна одну (втрачений firedTs -> дубль нагадування;
 * втрачена мітка dispatch -> зайвий Actions-ран) — рівно та причина, з якої
 * вони колись і стали послідовними (ревʼю A). Ізолюємо збій, а не порядок.
 */
/**
 * @param {{ name: string, run: (env: Env) => Promise<unknown> }[]} tasks
 * @param {Env} env
 */
export async function runCronTasks(tasks, env) {
  for (const task of tasks) {
    try {
      await task.run(env);
    } catch (e) {
      console.error(`cron: задача ${task.name} впала (решта виконуються далі)`, e);
    }
  }
}

/**
 * Сторож планувальника (етап 1, PR-2): у shadow/on кожен 5-хвилинний крон-тік
 * будить Scheduler DO — той сам вирішує (shouldWatchdogTick), чи alarm живий і
 * тікати не треба. При off не викликається взагалі (01 §5: код є, не
 * викликається). Збій сторожа не зачіпає runCronTasks — окремий waitUntil.
 */
export async function schedulerWatchdog(/** @type {Env} */ env) {
  if (env.ASSISTANT_V2 !== 'shadow' && env.ASSISTANT_V2 !== 'on') return;
  const ns = env.SCHEDULER;
  if (typeof ns?.getByName !== 'function') {
    // Прапорець увімкнено, а привʼязки немає — це помилка конфігурації, і вона
    // мусить бути видимою, а не тихою деградацією (правило «помилка видима»).
    console.error(`scheduler: ASSISTANT_V2=${env.ASSISTANT_V2}, але SCHEDULER не привʼязано`);
    return;
  }
  try {
    await ns.getByName(SCHEDULER_DO_NAME).watchdogTick(Date.now());
  } catch (/** @type {any} */ e) {
    console.error('scheduler: сторож упав (крон-задачі не зачеплені)', e?.message);
  }
}

export default {
  async fetch(
    /** @type {Request} */ request,
    /** @type {Env} */ env,
    /** @type {ExecutionContext} */ ctx,
  ) {
    const url = new URL(request.url);
    if (url.pathname === '/briefing.json') {
      // Приватні дані власника (події календаря, воронка, збережене) — лише
      // власнику через initData; без нього фронт деградує на SAMPLE (H1).
      const auth = await checkOwnerRead(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
      // ?date=YYYY-MM-DD -> історичний брифінг; інакше — latest.
      const date = url.searchParams.get('date');
      const key = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `briefing:${date}` : 'latest';
      const data = await env.BRIEFING.get(key);
      return new Response(data ?? '{}', {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }
    // ⚠️ ПУБЛІЧНИЙ — свідомо перед усіма auth-гілками. Єдиний ендпоінт без
    // автентифікації: зовнішній бейдж «живий сервіс» на yushko.dev. Тіло —
    // рівно одна мітка часу (web/api-status.mjs), і більше туди нічого класти
    // не можна: усе, що він віддає, віддається всім.
    //
    // Шлях НАВМИСНО /api/status: правило WAF — starts_with(uri.path, "/api/")
    // з винятками /api/telegram і /api/agent-step, тож ліміт 60/10с діє тут
    // без жодних змін конфігу. Будь-яка інша назва (/status або щось із
    // префіксом винятку) тихо вивела б його з-під ліміту.
    if (url.pathname === '/api/status' && request.method === 'GET') {
      return handleStatus(request, env);
    }
    if (url.pathname === '/api/history') {
      const auth = await checkOwnerRead(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
      // Список наявних дат (для гортання в Mini App), новіші перші.
      const list = await env.BRIEFING.list({ prefix: 'briefing:' });
      const dates = list.keys
        .map((/** @type {KvBlob} */ k) => k.name.slice('briefing:'.length))
        .sort()
        .reverse();
      return json({ dates });
    }
    if (url.pathname === '/api/vote' && request.method === 'POST') {
      return handleVote(request, env);
    }
    if (url.pathname === '/api/event' && request.method === 'POST') {
      return handleEvent(request, env);
    }
    if (url.pathname === '/api/archive') {
      // Холодний архів місячних згорток — ОКРЕМО від /api/stats: там бюджет
      // 10 мс CPU на кожен відкритий дашборд, а це потрібно лише коли людина
      // відкриє «Історію».
      return handleArchiveRequest(request, env);
    }
    if (url.pathname === '/api/levers') {
      // Шар звʼязків — ОКРЕМО від /api/stats, як і архів: додаткове читання KV
      // заради блоку, який дивляться раз на тиждень, не має коштувати на
      // кожному відкритті дашборда.
      return handleLeversRequest(request, env);
    }
    if (url.pathname === '/api/deletions') {
      // T2-receipts — приватна історія видалень. Це окреме lazy-read, щоб
      // відкриття звичайної статистики не платило KV-list за рідкісний екран.
      return handleDeletionsRequest(request, env);
    }
    if (url.pathname === '/api/stats') {
      return handleStats(request, env);
    }
    if (url.pathname === '/api/weather') {
      return handleLiveWeather(request, env);
    }
    if (url.pathname === '/api/weather/location') {
      return handleWeatherLocation(request, env);
    }
    if (url.pathname === '/api/weather/locate-prompt') {
      return handleWeatherLocatePrompt(request, env);
    }
    if (url.pathname === '/api/settings') {
      return handleSettings(request, env);
    }
    if (url.pathname === '/api/saved') {
      return handleSaved(request, env);
    }
    if (url.pathname === '/api/telegram' && request.method === 'POST') {
      return handleTelegramWebhook(request, env, ctx);
    }
    // Зворотний виклик LLM-хоста: цикл агента живе там, інструменти — тут
    // (варіант Б). Авторизація подвійна: спільний секрет хоста + підписаний
    // ран-токен. Свідомо БЕЗ CORS — це міжсерверний роут, не для браузера.
    if (url.pathname === '/api/agent-step' && request.method === 'POST') {
      return handleAgentStep(request, env);
    }
    // Вебхук Monobank (етап 6, S-4-1…S-4-5): ПУБЛІЧНИЙ шлях із секретом
    // усередині, тому під префіксом /api/ — так на нього діє чинне правило
    // WAF (60/10 с). Деталі перевірок — core/finance/webhook.mjs.
    if (url.pathname.startsWith(MONO_WEBHOOK_PREFIX)) {
      return handleMonoWebhook(request, env, ctx);
    }
    // Тестова транзакція для приймання (07 §3): за Access + X-Test: 1 +
    // секрет вебхука. ПЕРЕД handleInternal — у того свій підпис ADR-037,
    // якого власник руками не порахує.
    if (url.pathname === '/internal/test/mono') {
      return handleMonoTest(request, env);
    }
    // Internal API редизайну (етап 1, PR-5): HMAC + run_id, деталі — router.
    // Свідомо без CORS з тієї ж причини, що /api/agent-step. При off віддає
    // 404 сам (код є, не викликається).
    if (url.pathname.startsWith('/internal/')) {
      return handleInternal(request, env, Date.now(), ctx);
    }
    // Стан нового асистента для власника (етап 1, PR-10): планувальник,
    // прогони, квоти. Приватний (initData), при off — 404 зсередини.
    if (url.pathname === '/api/assistant-status' && request.method === 'GET') {
      return handleAssistantStatus(request, env);
    }
    if (url.pathname === '/api/telegram/setup' && request.method === 'POST') {
      return handleTelegramSetup(request, env);
    }
    // E4-final (роадмеп v3): корінь віддає React-дашборд (/app/index.html) — URL
    // лишається '/', ассети React абсолютні (/app/assets/*). React пройшов смоук
    // у реальному Telegram, старий index.html видалено, тож фолбек більше не
    // потрібен. Cloudflare build-команда (npm run build:web) гарантує /app у
    // задеплоєних ассетах.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return env.ASSETS.fetch(new Request(new URL('/app/index.html', url.origin), request));
    }
    return env.ASSETS.fetch(request); // статичні ассети React (/app/*)
  },

  async scheduled(
    /** @type {ScheduledController} */ _event,
    /** @type {Env} */ env,
    /** @type {ExecutionContext} */ ctx,
  ) {
    // При ASSISTANT_V2=on крон-задачі виконує планувальник (реєстр
    // core/scheduler/tasks.mjs посилається на ТІ САМІ функції) — легасі-цикл
    // мовчить, інакше кожен ефект був би подвійним. Сам CRON_TASKS лишається
    // живим до кінця етапу 2: «off» повертає все одним перемиканням (03-plan).
    if (env.ASSISTANT_V2 !== 'on') ctx.waitUntil(runCronTasks(CRON_TASKS, env));
    // Окремий waitUntil, а не хвіст runCronTasks: збій/зависання сторожа не
    // сміє відкласти чи забрати крон-задачі (і навпаки) — той самий мотив
    // ізоляції B11, тільки на рівень вище.
    ctx.waitUntil(schedulerWatchdog(env));
  },
};
