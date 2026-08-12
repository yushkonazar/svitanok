// Worker: статика дашборда (ASSETS) + /briefing.json із KV + планувальник
// (вікно 08:00–12:00 Київ, спроба щоп'ять хвилин -> GitHub workflow_dispatch,
// рівно один успішний на добу) + DEAD-MAN'S-SWITCH (10:00 Київ) +
// НАГАДУВАННЯ (кожні ~5 хв, Блок P2a) + /api/vote, /api/event (запис подій —
// авторизація власника через Telegram WebApp initData), /api/stats (читання
// агрегату), /api/telegram (вебхук — Блок P0/P1/P4, авторизація через
// X-Telegram-Bot-Api-Secret-Token). KV namespace BRIEFING, ключі
// `latest`/`state`(+`reminders`)/`stats`/`briefing:<date>`.

import { aggregateStats } from './stats-core.mjs';
import {
  verifyWebhookSecret,
  parseUpdate,
  isOwner,
  isDuplicate,
  parseCommand,
  formatStatsMessage,
  formatJobsMessage,
  formatSavedMessage,
  formatWhereAmI,
  buildMiniAppButton,
  sentMessagesKey,
  lastSentMessages,
  parseClearCount,
  chunkArray,
  formatClearResult,
  briefCooldownRemainingMs,
  REPLY_KEYBOARD,
  LOCATE_CANCEL_LABEL,
  normalKeyboard,
} from './tg-core.mjs';
import {
  isSleepStartCallback,
  formatRemindersListMessage,
  buildRemindersKeyboard,
  parseReminderCancelCallbackData,
  parseReminderEditCallbackData,
  parseReminderDoneCallbackData,
  parseReminderSnoozeCallbackData,
  classifyReminderIntent,
} from './reminders-core.mjs';
import {
  formatAgendaMessage,
  buildAgendaKeyboard,
  parseAgendaCallbackData,
} from './calendar-core.mjs';
import { parseProposalCallbackData } from './agent-core.mjs';
import {} from './agent-run-core.mjs';
// Клас Durable Object мусить бути експортований із ГОЛОВНОГО модуля Worker'а
// (це вимога Cloudflare), тож ре-експорт — не стилістика, а контракт деплою.
export { AgentRun } from './agent-run-do.mjs';
import {} from './assistant-data-core.mjs';
import { parseRoadmapCallbackData, formatRootMessage, buildRootKeyboard } from './roadmap-core.mjs';
import { kyivDateKey } from './kyiv-time.mjs';
import { allowedUserIds, isPrimaryOwner, checkOwnerRead } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import {
  handleVote,
  handleEvent,
  handleSettings,
  handleSaved,
  handleStats,
} from './api-dashboard.mjs';
import { tgCall, sendTo, trackIncomingMessage } from './telegram-client.mjs';
import { UNKNOWN_REPLY } from './agent-core.mjs';
import {
  resolveCallbackToast,
  resolveReminderSnooze,
  resolveReminderSnoozePreset,
  resolveReminderCancel,
  resolveSleepStart,
  resolveReminderDone,
  resolveReminderCancelAll,
  resolveReminderEditPrompt,
  readUpcomingWeek,
  resolveAgendaCallback,
  resolveRoadmapCallback,
  REMINDER_CB_PREFIX,
} from './callbacks.mjs';
import {
  checkReminders,
  dispatchBrief,
  loadBriefDispatch,
  recordBriefDispatch,
  autoBriefDispatch,
  checkinNudgeCheck,
  sleepNudgeCheck,
  deadMansCheck,
  runTelegramSetup,
  autoTelegramSetup,
} from './cron.mjs';
import {
  handleLiveWeather,
  handleWeatherLocation,
  handleWeatherLocatePrompt,
  sendLocatePrompt,
  handleLocationShare,
} from './weather-geo.mjs';
import {
  runAssistantAgent,
  handleAgentStep,
  agentRunWatchdog,
  agentHostHealthCheck,
} from './agent-runtime.mjs';
import { createReminderFromText } from './reminders-actions.mjs';
import { resolveProposalCallback } from './proposals.mjs';
import { agentHostUrl } from './llm-host.mjs';
import { loadStats, loadState, loadSentMessages } from './kv-store.mjs';

// 'rc:' (reminder-cancel, §C4) — окремий простір від rm:/pd:/rd:/v1:, живе в
// reminders-core.mjs (REMINDER_CANCEL_CB_PREFIX) — НЕ підпростір усередині
// 'rm:', бо resolveReminderSnooze бере ВЕСЬ залишок після 'rm:' як id.

// /clear (§C5): скільки deleteMessage-викликів паралельно за раз — компроміс
// між швидкістю (не повністю послідовно) і обережністю до rate-limit
// Telegram/Cloudflare (не бурст усіх 40 водночас).
const DELETE_CHUNK_SIZE = 10;

/* ══════════════════════════════════════════════════════════════════════
   TELEGRAM-ВЕБХУК (Блок P0+P1) — прийом callback-кнопок з брифінгу.
   ══════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════
   Команди / Налаштування (Блок P4) — маршрутизація текстових повідомлень.
   ══════════════════════════════════════════════════════════════════════ */

// Фаза C3: /start (онбординг+keyboard) і /help (повний реєстр команд) розділено —
// раніше /start і показував список, і переспамлював reply-keyboard в одному.
const START_TEXT = [
  '👋 Привіт! Я асистент <b>Світанок</b>.',
  '',
  'Повний список команд — /help.',
  '',
  // Один суцільний абзац: конкатенація (не array+join('\n')) — інакше жорсткі
  // розриви джерела ламали б рядок ще ДО клієнтського word-wrap Telegram і
  // давали подвійне, непередбачуване перенесення посеред речення (саме це
  // бачив власник на скріні — "...просто\nнапиши" замість природного потоку).
  'Швидкі кнопки внизу завжди під рукою. Нагадати можна й без команди — просто ' +
    'напиши "нагадай ...". У темі 🤖Асистент можна й просто написати вільним ' +
    'текстом — календар, нагадування, план дня.',
].join('\n');

const HELP_TEXT = [
  '📋 <b>Команди</b>',
  '',
  '/brief — запустити ранковий брифінг',
  '/stats — стрік і статистика',
  '/jobs — активна воронка вакансій',
  '/save — збережене',
  '/remind — нагадування (напр. "через 20 хв ..." або "завтра о 10:00 ...")',
  '/reminders — список активних нагадувань (можна скасувати)',
  '/agenda — найближчі події календаря, тиждень наперед',
  '/agent — що вміє асистент (вільний текст) — повний перелік',
  '/plan — план дня (LLM прочитає календар і запропонує таймлайн)',
  '/roadmap — IT-роадмеп (теми → підпункти, прогрес)',
  '/settings — тихі години, ціль, модулі брифінгу',
  '/clear [N] — видалити останні N повідомлень тут — мої та твої (за замовч. 20)',
  '/whereami — chat_id/thread_id цього чату',
  '/locate — оновити позицію за GPS (точна погода в Mini App, замість IP-приблизності)',
].join('\n');

/**
 * Перелік можливостей асистента (🤖Асистент, вільний текст) — окремо від
 * HELP_TEXT (той — slash-команди бота, це — що можна написати текстом
 * LLM-агенту). Рукописний, не згенерований зі схеми: ASSISTANT_ACTION_SCHEMA
 * (agent-core.mjs) — контракт для моделі, тут потрібні людські приклади фраз.
 */
const AGENT_TEXT = [
  '🤖 <b>Що вміє асистент</b> (пиши в цій темі вільним текстом)',
  '',
  '📅 <b>Календар</b> — створити/перенести/скасувати подію, гості (імена — резолвимо ' +
    'в email, чи одразу email) і місце. «Заплануй кафе з Олексієм завтра о 15:00 в ' +
    '«Аромакава»» — завжди питає підтвердження кнопкою.',
  '⏰ <b>Нагадування</b> — створити/змінити/скасувати, одразу, без підтвердження. ' +
    '«Нагадай через 20 хв подзвонити в клініку».',
  '📧 <b>Пошта</b> — пошук і читання Gmail (лише читання, нічого не відправляє).',
  '✅ <b>Чек-ін</b> — «хочу зробити чек-ін» — заповнить поля активного часу доби ' +
    '(ранок/день/вечір) з розмови.',
  '❤️ <b>Новини</b> — «лайкни цю новину про...» (з того, що щойно показав).',
  '💼 <b>Вакансії</b> — «познач вакансію X як співбесіда» (з того, що щойно показав).',
  '📚 <b>Роадмеп</b> — «познач Docker вивченим».',
  '⚙️ <b>Налаштування</b> — тихі години, модулі брифінгу, заглушені теми — теж через ' +
    'підтвердження (повна заміна, тому діф «було → стане» перед ✅).',
  '👤 <b>Контакти</b> — «збережи Олексія як контакт, email x@y.com» — через підтвердження.',
  '📁 <b>Drive</b> — «знайди моє резюме» — пошук за назвою, лише посилання (без читання ' +
    'вмісту файлу).',
  '📊 <b>Твої дані</b> — «що я зберіг цього тижня?», «як мій стрік?», «які в мене ' +
    'нагадування?» — брифінг/вакансії/прогрес/нагадування/чек-іни/збережене/новини/налаштування.',
].join('\n');

// ASSISTANT_FALLBACK_REPLY тепер живе в agent-core.mjs — поруч із рештою текстів
// відмов (assistantErrorReply), щоб «не зміг розібратись» лишався ОДНИМ із
// варіантів, а не єдиним (A1).

/* ══ Агент: цикл живе на ХОСТІ (варіант Б) ═══════════════════════════════════
   Доти Worker сам крутив цикл раундів у ctx.waitUntil — і впирався в стелю
   платформи: Cloudflare убиває фонову роботу МОВЧКИ на ~25-30с (бісект власника:
   2 раунди відповідають, 3 дають повну тишу). Паліатив AGENT_DEADLINE_MS=18с
   прибрав мовчанку, але ланцюжок «знайди лист І заплануй» лишався неможливим.

   Тепер:
     1. Worker шле «⏳ Працюю…», мінтить ран-токен і робить ОДИН POST на хост,
        який одразу віддає 202 -> waitUntil завершується за ~300мс, евікшену немає.
     2. Хост крутить цикл біля claude CLI без обмеження часу. Потрібен
        інструмент -> POST назад у /api/agent-step -> Worker виконує (секрети є
        лише в нього) і повертає текст для транскрипту + токен наступного кроку.
     3. Термінальна дія -> Worker виконує її, прибирає «⏳» і відповідає власнику.

   ⚠️ Хост НЕ знає переліку дій: системний промпт і JSON-схему йому дає Worker у
   тому ж POST. Тому додати агентові вміння = правка ЛИШЕ Worker'а, без редеплою
   VPS, і скомпрометований хост не отримує ширших повноважень, ніж модель мала
   й до переходу (`extractAssistantAction` — той самий allowlist, що й раніше). */

/**
 * Аварійний вимикач класифікатора наміру (B23): `REMINDER_INTENT_ROUTING=0`
 * (або 'off'/'false') повертає стару жадібну поведінку «будь-яке "нагад" ->
 * парсер». Умикання за замовчуванням — фікс має працювати без налаштування;
 * змінна потрібна лише щоб відкотитись без релізу, якщо в живому вжитку
 * класифікатор поведеться не так, як у тестах. Це щоденний інструмент
 * власника, а не сервіс із вікном обслуговування.
 */
function reminderIntentRoutingEnabled(env) {
  const raw = env.REMINDER_INTENT_ROUTING;
  if (raw === undefined || raw === null) return true;
  return !['0', 'off', 'false', 'no'].includes(String(raw).trim().toLowerCase());
}

/**
 * Команди, доступні ЛИШЕ головному власнику (S1/B1). Решта (/start, /help,
 * /stats, /jobs…) — читальні, їх співвласник бачить і далі.
 *
 * Критерій потрапляння сюди: команда або ПИШЕ в стан власника, або діє від
 * його імені назовні, або витрачає його ресурси (хвилини GitHub Actions, пул
 * підписки Claude). Вільний текст (агент) гейтиться окремо — у нього немає
 * cmd, а найгірший сценарій S1 саме такий: «знайди листи…» від співвласника
 * запускало прогін проти Gmail ВЛАСНИКА.
 */
// /brief — палить хвилини Actions і перезаписує брифінг; /clear — видаляє
// повідомлення; /locate — веде до перезапису гео власника (S5); /remind —
// створює нагадування в його стані. Решта команд (/stats, /jobs, /save,
// /reminders, /agenda, /roadmap, /settings, /whereami) лише ПОКАЗУЮТЬ — їх
// співвласник бачить і далі, а самі кнопки під ними вже гейтяться окремо.
const OWNER_ONLY_COMMANDS = new Set(['brief', 'clear', 'locate', 'remind']);

/** Ввічлива відмова співвласнику — без деталей про те, що саме заблоковано. */
const COOWNER_DENIED_REPLY = '🔒 Ця дія доступна лише власнику. Дашборд і перегляд — як завжди.';
/** Те саме тостом під кнопкою (answerCallbackQuery — інша, коротша поверхня). */
const COOWNER_DENIED_TOAST = '🔒 Лише власник';

/** Обробити текстове повідомлення (slash-команда/reply-keyboard) -> sendMessage. */
async function handleCommand(env, parsed, origin) {
  const sendText = sendTo(env, parsed);

  // GPS-позиція (відповідь на /locate) і скасування тимчасової клавіатури —
  // ОБИДВА поза звичайним parseCommand: перше не має тексту взагалі, друге —
  // не команда й не reply-keyboard alias з KEYBOARD_ALIASES.
  if (parsed.location) return handleLocationShare(env, parsed, sendText);
  if (parsed.text === LOCATE_CANCEL_LABEL) {
    return sendText('Гаразд, без змін.', { reply_markup: normalKeyboard() });
  }

  const cmd = parseCommand(parsed.text);
  // S1/B1: усе, що ПИШЕ в стан власника, діє від його імені назовні або
  // витрачає його ресурси, — лише головному власнику. Співвласник лишається
  // читачем (дашборд), яким список і задумувався.
  const primary = isPrimaryOwner(env, parsed.fromId);
  if (!primary && (!cmd || OWNER_ONLY_COMMANDS.has(cmd.cmd))) {
    return sendText(COOWNER_DENIED_REPLY);
  }

  if (!cmd) {
    // Тригер нагадування (P2a) — першим, як і раніше. agentFallback (B2): якщо
    // час не розібрався — не глухе «не зрозумів», а розмова з агентом (памʼять
    // треду -> перепитав і зібрав відповідь).
    if (/нагад/i.test(parsed.text)) {
      // B23: до фікса сюди жадібно провалювалось БУДЬ-ЯКЕ «нагад», і парсер
      // (він уміє лише зрізати час) перетворював «скасуй нагадування…» на ще
      // одне нагадування з дослівним текстом. Класифікатор пропускає до агента
      // ЛИШЕ сильні сигнали (мутація наявного / друга дія), решта йде старим,
      // швидшим і детермінованим шляхом. Без хоста агента нема — тоді теж
      // парсер (той самий гейт, що в agentFallback нижче).
      const toAgent =
        reminderIntentRoutingEnabled(env) &&
        classifyReminderIntent(parsed.text) === 'agent' &&
        Boolean(agentHostUrl(env));
      if (toAgent) return runAssistantAgent(env, parsed, parsed.text);
      return createReminderFromText(env, parsed, parsed.text, {
        onUnparsed: () => runAssistantAgent(env, parsed, parsed.text),
      });
    }
    // Вільний текст у 🤖Асистент (чи DM, без тем) -> LLM tool-use агент (Блок
    // P2b). Інші теми (Роадмеп/Брифінг/Система) — тема-специфічна поведінка
    // там свідомо поза межами, лишається стара заглушка.
    if (parsed.threadId == null || String(parsed.threadId) === String(env.TOPIC_ASSISTANT)) {
      return runAssistantAgent(env, parsed, parsed.text);
    }
    return sendText(UNKNOWN_REPLY);
  }

  switch (cmd.cmd) {
    case 'start':
      return sendText(START_TEXT, {
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: REPLY_KEYBOARD,
          resize_keyboard: true,
          // is_persistent: клавіатура лишається розгорнутою замість того, щоб
          // ховатись за перемикачем ⊞ — на мобільному прибирає зайвий тап
          // (Bot API 6.4). input_field_placeholder — підказка в порожньому полі
          // вводу: бот розуміє вільний текст («нагадай...»), про що ніде не
          // сказано, поки людина саме дивиться на порожнє поле.
          is_persistent: true,
          input_field_placeholder: 'Команда або "нагадай..."',
        },
      });
    case 'help':
      return sendText(HELP_TEXT, { parse_mode: 'HTML' });
    case 'agent':
      return sendText(AGENT_TEXT, { parse_mode: 'HTML' });
    case 'locate': {
      const isPrivate = String(parsed.chatId) === String(env.TELEGRAM_OWNER_USER_ID);
      const res = await sendLocatePrompt(env);
      if (!res.ok) {
        return sendText('⚠️ Не вдалося надіслати запит — спробуй ще раз за хвилину.', {
          reply_markup: normalKeyboard(),
        });
      }
      // /locate написано НЕ в приватному чаті (група/тема) -> промпт пішов
      // туди (request_location там недоступний), тож попереджаємо тут, звідки
      // й викликали. У приватному чаті sendLocatePrompt уже надіслав
      // повідомлення в ЦЕЙ САМИЙ чат вище — другого не треба (дубль).
      if (!isPrivate) {
        return sendText(
          '📍 Кнопку показано в приватному чаті з ботом — request_location недоступний у групових чатах. Перевір особисті повідомлення.',
        );
      }
      return undefined;
    }
    case 'brief': {
      // Кулдаун 1 год (SL2): кожен /brief = повний workflow_dispatch (палить
      // хвилини Actions + квоту KV/новин), guard гасить лише подвійну відправку.
      const remainMs = briefCooldownRemainingMs(
        (await loadBriefDispatch(env)).lastMs,
        Date.now(),
        60 * 60_000,
      );
      if (remainMs > 0) {
        const mins = Math.ceil(remainMs / 60_000);
        return sendText(
          `⏳ Брифінг нещодавно запускався. Спробуй за ${mins} хв (або дочекайся щоденного о 08:00).`,
        );
      }
      /* B2: /brief більше НЕ перезаписує вже опублікований брифінг.
         Повторний прогін того самого дня бачить усі новини й вакансії вже
         показаними (shownNews/shownJobs) і публікує майже порожній блоб поверх
         ранкового — у KV `latest` І в історії `briefing:<дата>`. Дашборд
         назавжди лишався без новин за той день, а inline-кнопки ранкового
         повідомлення починали вказувати в інший масив.
         Тож перевіряємо це ТУТ, до dispatch (той самий lastSentDate, що читає
         guard), і кажемо чесно — замість «Запустив генерацію» й тиші у відповідь
         на idempotent-скіп у CI. */
      if ((await loadState(env)).lastSentDate === kyivDateKey()) {
        return sendText(
          '✅ Сьогоднішній брифінг уже надіслано — дивись вище або в Mini App. ' +
            'Перегенерація стерла б його новини й вакансії (вони вже позначені показаними), ' +
            'тож роблю це лише вручну через GitHub → workflow «brief» → force.',
        );
      }
      // Мітку кулдауну сіємо ЛИШЕ після успішного dispatch (ревʼю SL): інакше
      // транзієнтний збій GitHub блокував би повтор на годину + брехливе «Запустив».
      // forceWindow: ручний /brief — «хочу зараз, поза вікном». Ідемпотентність
      // за добу лишається живою (див. блок вище).
      const ok = await dispatchBrief(env, { forceWindow: true });
      if (!ok) {
        return sendText(
          '⚠️ Не вдалося запустити генерацію (тимчасова помилка GitHub). Спробуй ще раз за хвилину.',
        );
      }
      await recordBriefDispatch(env);
      return sendText('🔄 Запустив генерацію брифінгу — прийде за кілька хвилин.');
    }
    case 'stats':
      return sendText(formatStatsMessage(aggregateStats(await loadStats(env), kyivDateKey())), {
        parse_mode: 'HTML',
      });
    case 'jobs':
      return sendText(
        formatJobsMessage(aggregateStats(await loadStats(env), kyivDateKey()).funnelList),
        { parse_mode: 'HTML' },
      );
    case 'save':
      return sendText(
        formatSavedMessage(aggregateStats(await loadStats(env), kyivDateKey()).savedList),
        { parse_mode: 'HTML' },
      );
    case 'remind':
      return createReminderFromText(env, parsed, cmd.args, {
        onUnparsed: () => runAssistantAgent(env, parsed, cmd.args),
      });
    case 'reminders': {
      const reminders = (await loadState(env)).reminders ?? [];
      const keyboard = buildRemindersKeyboard(reminders);
      return sendText(formatRemindersListMessage(reminders), {
        parse_mode: 'HTML',
        // reply_markup лише коли є що скасовувати — Telegram не любить порожній inline_keyboard.
        ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
      });
    }
    case 'agenda': {
      const events = await readUpcomingWeek(env);
      if (!events) return sendText('🔌 Не вдалось прочитати календар — спробуй пізніше.');
      const now = Date.now();
      const keyboard = buildAgendaKeyboard(events, now);
      return sendText(formatAgendaMessage(events, now), {
        parse_mode: 'HTML',
        ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
      });
    }
    case 'plan':
      // Префікс «Склади план дня» завжди присутній -> pickAssistantModel дає sonnet
      // (SL1), навіть якщо аргументи не містять планувальних слів.
      return runAssistantAgent(
        env,
        parsed,
        cmd.args ? `Склади план дня: ${cmd.args}` : 'Склади план дня',
      );
    case 'roadmap': {
      const progress = (await loadState(env)).roadmapProgress ?? {};
      return sendText(formatRootMessage(progress), {
        parse_mode: 'HTML',
        reply_markup: buildRootKeyboard(progress),
      });
    }
    case 'clear': {
      const n = parseClearCount(cmd.args);
      const ids = lastSentMessages(await loadSentMessages(env), parsed.chatId, parsed.threadId, n);
      let deleted = 0;
      const forget = []; // остаточно відмовлені id (>48г/без прав) — не пробувати знову
      // Пачками по DELETE_CHUNK_SIZE (не всі N одразу) — компроміс між швидкістю
      // (не повністю послідовно) і обережністю до rate-limit Telegram/Worker.
      for (const chunk of chunkArray(ids, DELETE_CHUNK_SIZE)) {
        const settled = await Promise.allSettled(
          chunk.map((id) =>
            tgCall(env, 'deleteMessage', { chat_id: parsed.chatId, message_id: id }),
          ),
        );
        settled.forEach((r, i) => {
          const id = chunk[i];
          if (r.status !== 'fulfilled') return; // мережева помилка -> ретрай наступного /clear
          if (r.value.ok) {
            deleted++;
            forget.push(id);
          } else if (r.value.status !== 429) {
            // Не rate-limit -> постійна відмова (найімовірніше >48г) -> не тримати id далі.
            forget.push(id);
          }
          // 429 -> НЕ forget: спробувати цей id ще раз наступного /clear.
        });
      }
      // Merge-before-flush (той самий патерн, що src/core/state-kv.ts): цикл
      // видалення міг тривати секунди — перечитуємо ЗАРАЗ і прибираємо ЛИШЕ
      // forget із ЦЬОГО ключа, а не перезаписуємо весь блоб застарілим
      // знімком (інакше конкурентний sendTo()/checkReminders() запис у ті ж
      // секунди був би мовчки затертий — саме той H2-клас гонки, заради
      // якого sentMessages узагалі живе в окремому ключі від 'state').
      const key = sentMessagesKey(parsed.chatId, parsed.threadId);
      const fresh = await loadSentMessages(env);
      fresh[key] = (fresh[key] ?? []).filter((id) => !forget.includes(id));
      await env.BRIEFING.put('sentMessages', JSON.stringify(fresh));
      return sendText(formatClearResult(deleted, ids.length));
    }
    case 'whereami': {
      // getMe -> can_read_all_group_messages: єдиний спосіб дізнатись, чи не
      // ріже Telegram вільний текст режимом приватності (див. formatWhereAmI).
      // Best-effort: діагностика не має падати через мережу.
      let me = null;
      try {
        const res = await tgCall(env, 'getMe', {});
        me = (await res.json())?.result ?? null;
      } catch {
        /* немає — просто не покажемо рядок про приватність */
      }
      return sendText(
        formatWhereAmI(parsed.chatId, parsed.threadId, me, env.TOPIC_ASSISTANT ?? null),
        {
          parse_mode: 'HTML',
        },
      );
    }
    case 'settings':
      return sendText(
        // Кнопка веде на головну Mini App (Direct Link ?startapp без параметра —
        // deep-link у розділ вимагав би зміни спільної buildMiniAppButton, яка
        // дзеркалиться в src/core/telegram.ts). Тож просто кажемо, куди тиснути.
        '⚙️ Налаштування — у Mini App, шестерня вгорі праворуч: тихі години, тижнева ціль подач, модулі брифінгу, конектори.',
        {
          reply_markup: {
            // TELEGRAM_BOT_USERNAME (Direct Link Mini App) заданий -> initData
            // працює і в групі; інакше фолбек за parsed.chatId (web_app лише в
            // приватних чатах — BUTTON_TYPE_INVALID у групі/темі інакше, §core/telegram.ts).
            inline_keyboard: [
              [
                buildMiniAppButton(
                  '📊 Відкрити Mini App',
                  origin,
                  parsed.chatId,
                  env.TELEGRAM_BOT_USERNAME,
                ),
              ],
            ],
          },
        },
      );
    default:
      return sendText(UNKNOWN_REPLY);
  }
}

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
async function processTelegramUpdate(env, parsed, origin) {
  try {
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
      // S1/B1: кнопки — це ВИКЛЮЧНО мутації стану власника (прийняти пропозицію
      // в його календар, скасувати його нагадування, записати його сон, відмітити
      // його роадмеп). Жодної читальної серед них немає, тож межа рівно тут.
      const toast = !isPrimaryOwner(env, parsed.fromId)
        ? COOWNER_DENIED_TOAST
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
    } else if (parsed.kind === 'message' && parsed.chatId != null) {
      // G1: спершу трекнути вхідне (перед handleCommand) — щоб уже цей-таки /clear
      // міг видалити й своє тригер-повідомлення разом із рештою.
      await trackIncomingMessage(env, parsed);
      await handleCommand(env, parsed, origin);
    }

    if (typeof parsed.updateId === 'number') {
      // Перечитати ПІСЛЯ applyEvent — той міг оновити jobPrefs/mockWeights у 'state'.
      const state = await loadState(env);
      state.lastUpdateId = parsed.updateId;
      await env.BRIEFING.put('state', JSON.stringify(state));
    }
  } catch (err) {
    console.error('processTelegramUpdate failed', err);
  }
}

/** POST /api/telegram — Telegram Bot API webhook. Secret-token + owner + дедуп. */
async function handleTelegramWebhook(request, env, ctx) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: 'no-webhook-secret' }, 500);
  }
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!verifyWebhookSecret(header, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'bad-secret' }, 401);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  const update = parsedBody.body;
  const parsed = parseUpdate(update);

  if (!isOwner(parsed, allowedUserIds(env))) {
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
async function handleTelegramSetup(request, env) {
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
 * виглядає як анонімний стек із waitUntil, і незрозуміло, ЯКА з восьми задач
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
export async function runCronTasks(tasks, env) {
  for (const task of tasks) {
    try {
      await task.run(env);
    } catch (e) {
      console.error(`cron: задача ${task.name} впала (решта виконуються далі)`, e);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
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
    if (url.pathname === '/api/history') {
      const auth = await checkOwnerRead(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
      // Список наявних дат (для гортання в Mini App), новіші перші.
      const list = await env.BRIEFING.list({ prefix: 'briefing:' });
      const dates = list.keys
        .map((k) => k.name.slice('briefing:'.length))
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

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCronTasks(CRON_TASKS, env));
  },
};
