// Команди бота (Фаза 5, модуляризація worker.js, план A2 §5).
//
// Один вхід — `handleCommand`: сюди приходить УСЕ текстове, що написав власник,
// і тут вирішується, що це — slash-команда, натиск reply-кнопки, GPS-позиція,
// фраза про нагадування чи вільний текст для асистента.
//
// ДВІ МЕЖІ, ЯКІ ТУТ ТРИМАЮТЬСЯ.
//   1. **Хто питає** (S1/B1): усе, що ПИШЕ в стан власника, діє від його імені
//      назовні чи витрачає його ресурси (хвилини Actions, пул підписки), —
//      лише головному власнику. Співвласник лишається читачем, яким список і
//      задумувався. Вільний текст гейтиться окремо: у нього немає `cmd`, а
//      найгірший сценарій саме такий — «знайди листи…» від співвласника
//      запускало прогін проти Gmail ВЛАСНИКА.
//   2. **Куди веде «нагад»** (B23): жадібне `/нагад/` перехоплювало compound-
//      запити («скасуй нагадування…і постав…») і перетворювало їх на дубль.
//      Тепер класифікатор пропускає до агента ЛИШЕ сильні сигнали, решта йде
//      старим, швидшим і детермінованим парсером.

import {
  parseCommand,
  parseClearCount,
  sentMessagesKey,
  formatWhereAmI,
  REPLY_KEYBOARD,
  normalKeyboard,
  LOCATE_CANCEL_LABEL,
  chunkArray,
  formatClearResult,
  lastSentMessages,
  briefCooldownRemainingMs,
  buildMiniAppButton,
} from './tg-core.mjs';
import {
  classifyReminderIntent,
  buildRemindersKeyboard,
  formatRemindersListMessage,
} from './reminders-core.mjs';
import { aggregateStats } from './stats-core.mjs';
import { masteryTopics } from './mastery-core.mjs';
import { formatStatsMessage, formatJobsMessage, formatSavedMessage } from './tg-core.mjs';
import { formatAgendaMessage, buildAgendaKeyboard } from './calendar-core.mjs';
import { formatRootMessage, buildRootKeyboard } from './roadmap-core.mjs';
import { kyivDateKey } from './kyiv-time.mjs';
import { loadState, loadStats, loadSentMessages } from './kv-store.mjs';

/** /clear (§C5): скільки deleteMessage-викликів паралельно за раз — компроміс
 *  між швидкістю й обережністю до rate-limit Telegram/Cloudflare. */
const DELETE_CHUNK_SIZE = 10;
import { tgCall, sendTo } from './telegram-client.mjs';
import { agentHostUrl } from './llm-host.mjs';
import { isPrimaryOwner } from './auth-core.mjs';
import { runAssistantAgent } from './agent-runtime.mjs';
import { createReminderFromText } from './reminders-actions.mjs';
import { handleLocationShare, sendLocatePrompt } from './weather-geo.mjs';
import { readUpcomingWeek } from './callbacks.mjs';
import { dispatchBrief, loadBriefDispatch, recordBriefDispatch } from './cron.mjs';
import { UNKNOWN_REPLY } from './agent-core.mjs';

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

// /brief — палить хвилини Actions і перезаписує брифінг; /clear — видаляє
// повідомлення; /locate — веде до перезапису гео власника (S5); /remind —
// створює нагадування в його стані. Решта команд (/stats, /jobs, /save,
// /reminders, /agenda, /roadmap, /settings, /whereami) лише ПОКАЗУЮТЬ — їх
// співвласник бачить і далі, а самі кнопки під ними вже гейтяться окремо.
const OWNER_ONLY_COMMANDS = new Set(['brief', 'clear', 'locate', 'remind']);

/** Ввічлива відмова співвласнику — без деталей про те, що саме заблоковано. */
const COOWNER_DENIED_REPLY = '🔒 Ця дія доступна лише власнику. Дашборд і перегляд — як завжди.';

/** Те саме тостом під кнопкою (answerCallbackQuery — інша, коротша поверхня). */
export const COOWNER_DENIED_TOAST = '🔒 Лише власник';

/**
 * Аварійний вимикач класифікатора наміру (B23): `REMINDER_INTENT_ROUTING=0`
 * (або 'off'/'false') повертає стару жадібну поведінку «будь-яке "нагад" ->
 * парсер». Умикання за замовчуванням — фікс має працювати без налаштування;
 * змінна потрібна лише щоб відкотитись без релізу, якщо в живому вжитку
 * класифікатор поведеться не так, як у тестах. Це щоденний інструмент
 * власника, а не сервіс із вікном обслуговування.
 */
function reminderIntentRoutingEnabled(/** @type {Env} */ env) {
  const raw = env.REMINDER_INTENT_ROUTING;
  if (raw === undefined || raw === null) return true;
  return !['0', 'off', 'false', 'no'].includes(String(raw).trim().toLowerCase());
}

/** Обробити текстове повідомлення (slash-команда/reply-keyboard) -> sendMessage. */
export async function handleCommand(
  /** @type {Env} */ env,
  /** @type {KvBlob} */ parsed,
  /** @type {string} */ origin,
) {
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
    case 'stats': {
      // Два незалежні KV-блоби: лічильники живуть у stats, прогрес роадмепу —
      // у state. Розрив «відмітив ↔ дається» зшивається лише з обох, тож тут
      // повторюється те саме, що робить handleStats для дашборда (masteryTopics
      // — чиста функція, дублюється виклик, а не логіка).
      const [store, state] = await Promise.all([loadStats(env), loadState(env)]);
      // Блоб: нижче до агрегату дописується майстерність — поле, якого
      // aggregateStats не знає (той самий мотив, що в handleStats).
      const agg = /** @type {KvBlob} */ (aggregateStats(store, kyivDateKey()));
      agg.mastery = { topics: masteryTopics(state.roadmapProgress ?? {}, store.mockTopics) };
      return sendText(formatStatsMessage(agg), { parse_mode: 'HTML' });
    }
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
      /** @type {number[]} */
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
          const id = /** @type {number} */ (chunk[i]);
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
      fresh[key] = (fresh[key] ?? []).filter((/** @type {number} */ id) => !forget.includes(id));
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
