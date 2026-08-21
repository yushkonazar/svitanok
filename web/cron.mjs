// Крон-задачі Worker'а (Фаза 5, модуляризація worker.js, план A2 §5).
//
// ОДИН крон раз на 5 хвилин — і вісім задач усередині. Кожна САМА вирішує, чи
// її час: гейт за київською годиною в момент виконання + ідемпотентність за
// добу (мітка в KV). Причина такої форми, а не кількох крон-виразів: крон
// Cloudflare Free має jitter у десятки хвилин, і розклад «о 08:05» означав би
// одну-єдину спробу, яка регулярно гинула (14.07 брифінг спізнився на ~50 хв).
// П'ятихвилинний тік плюс гейт = багато спроб, рівно один ефект.
//
// ІНВАРІАНТ ІЗОЛЯЦІЇ (B11): задачі виконуються ПОСЛІДОВНО і кожна у своєму
// try/catch — throw у першій не сміє забрати решту. До фіксу збій Telegram о
// 08:05 означав, що й брифінг не пішов, і dead-man не спрацював.
//
// ІНВАРІАНТ ІДЕМПОТЕНТНОСТІ: мітка «зроблено сьогодні» ставиться ЛИШЕ після
// успіху (напр. dispatchBrief), інакше транзієнтний збій GitHub блокував би
// повтор на цілу добу.

import { COMMANDS, buildMiniAppButton } from './tg-core.mjs';
import {
  dueReminders,
  markFired,
  formatReminderFired,
  buildSnoozeRow,
  buildSleepStartCallbackData,
} from './reminders-core.mjs';
import {
  checkinDateKey,
  recordReliability,
  shouldSendCheckinNudge,
  isCheckinSlotFilled,
  matchCheckinNudgeWindow,
  inSleepNudgeWindow,
  staleSleepNudges,
  shouldSendSleepNudge,
  SLEEP_NUDGE_TEXT,
} from './stats-core.mjs';
import { themeOfWeek } from './mastery-core.mjs';
import {
  monthlyRollup,
  mergeArchive,
  ARCHIVE_KEY,
  weeklyRollup,
  mergeWeekly,
  WEEKLY_ARCHIVE_KEY,
} from './stats-archive.mjs';
import { isQuietMinute } from './settings-core.mjs';
import { shouldAutoDispatchBrief } from './tg-core.mjs';
import { kyivHour, kyivDateKey, kyivMinuteOfDay } from './kyiv-time.mjs';
import { loadState, loadStats, loadSettings, updateStats } from './kv-store.mjs';
import { tgCall, trackSentMessage } from './telegram-client.mjs';

// Dead-man перевіряє день ПІСЛЯ того, як вікно ретраїв закрилось (BRIEF_WINDOW_
// END_HOUR=11 + кілька хвилин на сам ран). Раніше стояв о 10:00 — тепер це було б
// усередині вікна ретраїв: збій GitHub, що минув об 10:30, дав би хибний алерт
// «не доставлено» й хибний промах у reliability за день, який зрештою доставили.
const DEAD_MAN_HOUR = 12;

/**
 * Слаг репозиторію для workflow_dispatch.
 *
 * Env ПЕРЕКРИВАЄ, а не вимагає: форк чи перейменування не має означати правку
 * коду, але й новий обовʼязковий секрет тут завів би прод у стан, де брифінг
 * не диспатчиться, доки власник не поставить змінну у двох місцях. Дефолт —
 * рівно те значення, що стояло зашитим.
 */
const DEFAULT_GH_REPO = 'yushkonazar/svitanok';
const ghDispatchUrl = (/** @type {Env} */ env) =>
  `https://api.github.com/repos/${env.GH_REPO?.trim() || DEFAULT_GH_REPO}` +
  '/actions/workflows/brief.yml/dispatches';

/**
 * Знайти прострочені нагадування, надіслати + позначити спрацьованими.
 * Пише KV ПІСЛЯ КОЖНОГО надісланого — якщо tgCall впаде посеред циклу (мережа),
 * уже надіслані не втратять firedTs і не задублюються наступним тіком.
 */
// Фаза B2: профіль бота (setMyDescription/setMyShortDescription) — те, що
// власник бачить ДО першого /start (порожній чат) і в прев'ю/шарінгу. Разом
// із розширеним REPLY_KEYBOARD (tg-core.mjs) компенсує видалену тему
// «Команди» (та ніколи не мала прив'язки в коді, суто організаційна).
const BOT_DESCRIPTION =
  'Персональний ранковий брифінг: погода, курс, новини, вакансії, IT-роадмеп. ' +
  'Плюс асистент — нагадування, календар, план дня. Напиши /help, щоб побачити всі команди.';

const BOT_SHORT_DESCRIPTION = 'Ранковий брифінг + асистент для пошуку роботи в IT.';

// Одноразове закріплене вітальне повідомлення (фідбек власника, п.2) — «одна
// стала точка входу» в Mini App у форум-супергрупі. Раніше цю роль намагався
// грати ЩОДЕННИЙ брифінг (unpin учорашнього -> pin сьогоднішнього), але сам
// брифінг більше не несе кнопку (вона — тут), тож churn був без сенсу: щодня
// відкріпити й закріпити ТЕ САМЕ повідомлення про наявність апки. Тепер —
// один текст, закріплений один раз, ensureAppWelcomePin (нижче) лише
// підтверджує/відновлює закріплення на кожен /api/telegram/setup.
const APP_WELCOME_TEXT =
  '🌅 <b>Світанок</b> — твій персональний Mini App.\n\n' +
  'Погода, курс, новини, вакансії, чек-ін, статистика, IT-роадмеп — усе в ' +
  'одному місці. Це повідомлення закріплене, щоб кнопка нижче завжди була ' +
  'під рукою.';

export async function checkReminders(/** @type {Env} */ env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const now = Date.now();
  const due = dueReminders((await loadState(env)).reminders, now);
  if (due.length === 0) return;

  // Тихі години (F2): не шлемо — і НЕ позначаємо спрацьованими. dueReminders —
  // чистий фільтр, що переобчислюється кожні 5 хв, тож прострочені просто
  // лишаються в черзі й підуть першим тіком після кінця вікна. Саме це й
  // означає «відкладаються на ранок»: нічого не губиться, лише зсувається.
  const settings = await loadSettings(env);
  if (isQuietMinute(settings, kyivMinuteOfDay(new Date(now)))) return;

  for (const r of due) {
    /* Доставка ЗА АДРЕСОЮ створення (B12). Раніше кожне нагадування летіло в
       захардкоджені TELEGRAM_CHAT_ID + TOPIC_ASSISTANT: попросив у приватному
       чаті — відповідь приходила в тему супергрупи (а якщо тем немає взагалі,
       message_thread_id мовчки ігнорувався). Фолбек лишаємо для legacy-записів,
       створених до цієї зміни, — у них адреси просто немає. */
    const chatId = r.chatId ?? env.TELEGRAM_CHAT_ID;
    const threadId =
      r.chatId != null ? (r.threadId ?? undefined) : (env.TOPIC_ASSISTANT ?? undefined);
    const res = await tgCall(env, 'sendMessage', {
      chat_id: chatId,
      message_thread_id: threadId,
      text: formatReminderFired(r.text),
      parse_mode: 'HTML',
      // Розширений snooze (extra b): рядок пресетів, не одна фіксована +10 хв.
      // Старий rm:<id> (одна кнопка) лишається ЖИВИМ обробником — уже надіслані
      // повідомлення з ним не можна переписати заднім числом.
      reply_markup: { inline_keyboard: [buildSnoozeRow(r.id)] },
    });
    // §C5: трекаємо для /clear — cron-контекст, немає вхідного parsed, тож
    // chatId/threadId явні (той самий trackSentMessage, що й sendTo()).
    await trackSentMessage(env, res, chatId, threadId);
    const fresh = await loadState(env); // перечитати — попередня ітерація вже писала
    fresh.reminders = markFired(fresh.reminders, r.id, now);
    await env.BRIEFING.put('state', JSON.stringify(fresh));
  }
}

/**
 * Ядро реєстрації бота (вебхук + меню команд + профіль + кнопка-меню +
 * вітальний пін) — спільне для ручного POST /api/telegram/setup і автоматичного
 * щоденного самозапуску (autoTelegramSetup, нижче). origin — БЕЗ кінцевого
 * слеша (URL.origin це гарантує; env.MINI_APP_URL перевіряємо явно, бо туди
 * значення вводить власник руками).
 */
export async function runTelegramSetup(/** @type {Env} */ env, /** @type {string} */ origin) {
  const res = await tgCall(env, 'setWebhook', {
    url: `${origin}/api/telegram`,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  });
  // "/" меню команд + menu-button (кнопка біля поля вводу) -> запуск Mini App (Блок P4).
  await tgCall(env, 'setMyCommands', { commands: COMMANDS });
  // Фаза B2: профіль бота видно ДО /start (порожній чат) і в прев'ю — не
  // потребує окремої теми «Команди» для пояснення «що це».
  await tgCall(env, 'setMyDescription', { description: BOT_DESCRIPTION });
  await tgCall(env, 'setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
  await tgCall(env, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Mini App', web_app: { url: origin } },
  });
  await ensureAppWelcomePin(env, origin);
  return res.ok;
}

/**
 * Щоденний самозапуск runTelegramSetup — власник більше НЕ мусить руками
 * викликати curl після зміни команд/опису/кнопки-меню чи якщо вебхук/пін
 * загубився. Усі кроки runTelegramSetup — ідемпотентні виклики Telegram API
 * (перевстановлюють те саме значення), тож щоденний повтор безпечний і сам є
 * формою self-healing (той самий мотив, що ensureAppWelcomePin усередині).
 *
 * Гейт на MINI_APP_URL — Worker-секрет (wrangler secret put), ТЕ САМЕ значення,
 * що вже є в оркестраторі (.env.example): поза HTTP-запитом (тут — крон) немає
 * request.url, з якого можна взяти origin. Без секрету функція тихо
 * пропускається — ручний curl (README) лишається робочим фолбеком.
 *
 * Раз на добу — той самий "остання дата" ідіом, що dispatch.lastAutoDate.
 */
export async function autoTelegramSetup(/** @type {Env} */ env) {
  if (!env.MINI_APP_URL || !env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return;
  const today = kyivDateKey();
  const state = await loadState(env);
  if (state.telegramSetupDate === today) return;
  const origin = env.MINI_APP_URL.replace(/\/+$/, '');
  await runTelegramSetup(env, origin);
  const fresh = await loadState(env); // перечитати — попередні кроки могли писати state (пін)
  fresh.telegramSetupDate = today;
  await env.BRIEFING.put('state', JSON.stringify(fresh));
}

/**
 * Одноразове закріплене вітальне повідомлення з кнопкою Mini App (фідбек
 * власника, п.2) — «одна стала точка входу», не залежна від того, куди
 * прогорнута стрічка чату. Ідемпотентно: getChat каже, яке повідомлення
 * закріплене ЗАРАЗ — якщо це вже наше (id збігається зі стором) -> no-op,
 * повторний /api/telegram/setup нічого не дублює. Якщо власник зняв
 * закріплення вручну чи видалив повідомлення (pinnedId не збігається/відсутній)
 * -> шлемо нове й закріплюємо знову (self-healing замість «закріпилось один
 * раз і забули»).
 */
export async function ensureAppWelcomePin(
  /** @type {Env} */ env,
  /** @type {string} */ miniAppUrl,
) {
  if (!env.TELEGRAM_CHAT_ID) return;
  const chatId = env.TELEGRAM_CHAT_ID;

  // Резонний-за-замовчуванням: пересилаємо/переприкріплюємо ЛИШЕ якщо getChat
  // ПОЗИТИВНО підтвердив, що поточний пін не наш (не збігається зі стором) чи
  // взагалі відсутній. Транзієнтний збій getChat (мережа/таймаут) НЕ повинен
  // тлумачитись як «пін загублено» — інакше одна флуктуація що дня давала б
  // ще один дубль вітального повідомлення (крон викликає це раз на добу
  // безумовно). Замість цього просто пропускаємо цикл: завтрашній getChat
  // або підтвердить пін (no-op), або справді покаже втрату (і полагодить).
  let pinnedId;
  try {
    const chatRes = await tgCall(env, 'getChat', { chat_id: chatId });
    const chatJson = await chatRes.json();
    pinnedId = chatJson?.result?.pinned_message?.message_id;
  } catch (/** @type {any} */ e) {
    console.error('ensureAppWelcomePin: getChat не вдався — пропускаємо цикл', e?.message);
    return;
  }
  const state = await loadState(env);
  if (typeof state.appWelcomePinMsgId === 'number' && pinnedId === state.appWelcomePinMsgId) {
    return;
  }

  const button = buildMiniAppButton(
    '📊 Відкрити Mini App',
    miniAppUrl,
    chatId,
    env.TELEGRAM_BOT_USERNAME,
  );
  const sendRes = await tgCall(env, 'sendMessage', {
    chat_id: chatId,
    message_thread_id: env.TOPIC_BRIEFING ?? undefined,
    text: APP_WELCOME_TEXT,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[button]] },
  });
  const sendJson = await sendRes.json().catch(() => null);
  const newId = sendJson?.result?.message_id;
  if (typeof newId !== 'number') return;

  await tgCall(env, 'pinChatMessage', {
    chat_id: chatId,
    message_id: newId,
    disable_notification: true,
  });
  // Перечитати — між першим loadState (вище) і тепер минуло 2 await Telegram-
  // виклики, конкурентний писар того ж блоба (checkReminders/вебхук на тому
  // самому 5-хвилинному тіку) міг оновити щось інше в 'state' за цей час.
  const fresh = await loadState(env);
  fresh.appWelcomePinMsgId = newId;
  await env.BRIEFING.put('state', JSON.stringify(fresh));
}

/** A4: перед ранковим dispatch зафіксувати «тему тижня» у state.masteryFocus —
 *  оркестратор (src/modules/mock.ts) читає її як готові рядки й СІДИТЬ наступний
 *  mock-батч темою з роадмепу (web-код у src/ не імпортується — межа src/↔web/).
 *  Ротація детермінована за тижнем, тож щоденний перезапис безпечний;
 *  оркестратор masteryFocus не пише -> merge-гонок класу H2 нема. */
export async function updateMasteryFocus(/** @type {Env} */ env) {
  try {
    const state = await loadState(env);
    const focus = themeOfWeek(state.roadmapProgress ?? {}, kyivDateKey());
    // Тема детермінована на тиждень -> 6/7 щоденних записів були б ідентичні.
    // Пропускаємо no-op: кожен зайвий read-modify-write усього state-блоба —
    // дармове вікно клобберу конкурентних писарів (вебхук/події).
    const cur = state.masteryFocus;
    const same =
      (focus === null && cur === null) ||
      (focus && cur && cur.week === focus.week && cur.topicId === focus.topicId);
    if (same) return;
    state.masteryFocus = focus; // null коли роадмеп завершено — теж валідний стан
    await env.BRIEFING.put('state', JSON.stringify(state));
  } catch (/** @type {any} */ e) {
    console.error('updateMasteryFocus failed', e); // не блокує dispatch
  }
}

/**
 * Тригер brief-воркфлоу. Повертає true, якщо workflow_dispatch прийнято (SL2 —
 * /brief сіє кулдаун ЛИШЕ після успіху; ніколи не кидає — false при збої).
 *
 * force розділяє два РІЗНІ виклики, які доти йшли однаковим шляхом:
 *   • автоматичний (autoBriefDispatch, крон) — force=false, бо guard-
 *     ідемпотентність тут і є захистом: у вікні 08:00–12:00 крон стукає що
 *     5 хв, і без неї власник отримав би 48 брифінгів;
 *   • ручний /brief — force=true. Доти він теж ішов без force, тож УСЯ команда
 *     після ранкової доставки була тихим no-op: guard бачив lastSent===today,
 *     писав «send=false» і завершував воркфлоу успіхом, а бот уже відрапортував
 *     «Запустив генерацію — прийде за кілька хвилин». Ніщо не приходило й
 *     ніде не було помилки. Ручний виклик — це явний намір «хочу ЗАРАЗ», його
 *     квоту стереже власний годинний кулдаун (briefCooldownRemainingMs), а не
 *     добова ідемпотентність.
 */
/**
 * Дописати місячні згортки в холодний архів (раз на добу).
 *
 * ⚠️ НАВІЩО. Стор ріже історію капами — чек-іни й активність 365 діб,
 * надійність і сон 90, тижневі інтереси 26 тижнів, оцінки mock 60. Кожної доби
 * щось найстаріше зникає НАЗАВЖДИ, і місця, де воно лишалось би бодай
 * згорнутим, не було. Це задача про втрату даних, а не про майбутній графік.
 *
 * ⚠️ ОКРЕМИЙ KV-КЛЮЧ, а не поле в `stats`: гарячий блоб читається й
 * перезаписується на КОЖНУ подію, тож усе в ньому коштує на кожному тапі.
 * Архів пишеться раз на добу й читається лише під довгий період.
 *
 * No-op, якщо нічого не змінилось: зайвий read-modify-write — це дармове вікно
 * клобберу (той самий мотив, що в updateMasteryFocus вище).
 */
export async function archiveMonthly(/** @type {Env} */ env) {
  try {
    const store = await loadStats(env);
    const today = kyivDateKey();
    // ⚠️ ОДИН прогін — ДВА рівні. Стор читається один раз: тижнева згортка
    // працює на тих самих даних, і другий loadStats був би зайвим читанням KV
    // заради того самого обʼєкта.
    await writeRollup(env, ARCHIVE_KEY, monthlyRollup(store, today), mergeArchive, today);
    await writeRollup(env, WEEKLY_ARCHIVE_KEY, weeklyRollup(store, today), mergeWeekly, today);
  } catch (/** @type {any} */ e) {
    console.error('archiveMonthly failed', e); // не блокує решту крону
  }
}

/** Прочитати-злити-записати один рівень архіву. No-op, якщо нічого не змінилось:
 *  зайвий read-modify-write — дармове вікно клобберу. */
/**
 * @param {Env} env
 * @param {string} key
 * @param {KvBlob} fresh
 * @param {(prev: KvBlob, fresh: KvBlob, today: string) => KvBlob} merge
 * @param {string} today
 */
async function writeRollup(env, key, fresh, merge, today) {
  if (!Object.keys(fresh).length) return;
  const prev = await readArchive(env, key);
  const merged = merge(prev, fresh, today);
  const next = JSON.stringify(merged);
  if (next === JSON.stringify(prev)) return;
  await env.BRIEFING.put(key, next);
}

/** Архів; биття -> порожньо (краще дописати заново, ніж упасти). */
async function readArchive(/** @type {Env} */ env, key = ARCHIVE_KEY) {
  try {
    const raw = await env.BRIEFING.get(key);
    const parsed = JSON.parse(raw ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {Env} env
 * @param {{ forceWindow?: boolean }} [opts]
 */
export async function dispatchBrief(env, { forceWindow = false } = {}) {
  if (!env.GH_DISPATCH_TOKEN) {
    console.error('GH_DISPATCH_TOKEN відсутній — dispatch пропущено');
    return false;
  }
  try {
    const resp = await fetch(ghDispatchUrl(env), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'svitanok-scheduler',
        'content-type': 'application/json',
      },
      // inputs у workflow_dispatch — РЯДКИ, навіть для `type: boolean` (REST
      // API приймає лише string-значення, GitHub сам приводить до boolean перед
      // обчисленням inputs.* у brief.yml). Ключ узагалі не шлемо, коли прапорця
      // немає, — тоді працює default: false з опису воркфлоу.
      //
      // Саме force_window, а НЕ force (B2): бот просить «запусти зараз, поза
      // вікном», але ніколи не просить перезаписати вже опублікований брифінг.
      body: JSON.stringify({
        ref: 'main',
        ...(forceWindow ? { inputs: { force_window: 'true' } } : {}),
      }),
    });
    if (!resp.ok) {
      console.error('workflow_dispatch failed', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (/** @type {any} */ e) {
    console.error('workflow_dispatch error', e?.message);
    return false;
  }
}

/**
 * Мітки dispatch брифінгу — ОКРЕМИЙ KV-ключ, не блоб 'state' (ревʼю A; той самий
 * привід, що й у sentMessages вище). Було: recordBriefDispatch робив
 * read-modify-write усього 'state', тож конкурентний писар того ж блоба
 * (checkReminders на тому ж тіку крону, вебхук, багатохвилинний flush
 * оркестратора) міг просто затерти щойно поставлену денну мітку — і наступний
 * 5-хвилинний тік вистрілив би ДРУГИЙ workflow_dispatch. Тепер мітки живуть самі:
 *   {lastMs: <коли будь-який dispatch>, lastAutoDate: 'YYYY-MM-DD' | null}
 * Після деплою ключа ще немає -> кулдаун /brief один раз стартує «з нуля»
 * (нешкідливо: максимум один зайвий ручний запуск).
 */
export async function loadBriefDispatch(/** @type {Env} */ env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get('briefDispatch')) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Записати мітку dispatch — ЛИШЕ після підтвердженого workflow_dispatch (SL2).
 *  autoDate (A2) ставиться тільки з авто-гілки: ручний /brief може бути й поза
 *  вікном, тож «сьогодні вже диспатчили» — не про нього. Від дубля відразу після
 *  ручного /brief захищає lastMs (MIN_DISPATCH_GAP_MS, tg-core.mjs). */
export async function recordBriefDispatch(
  /** @type {Env} */ env,
  /** @type {string|null} */ autoDate = null,
) {
  const cur = await loadBriefDispatch(env);
  const next = { ...cur, lastMs: Date.now() };
  if (autoDate) next.lastAutoDate = autoDate;
  await env.BRIEFING.put('briefDispatch', JSON.stringify(next));
}

/**
 * A2: ранковий авто-dispatch із пʼятихвилинного крону, у вікні [08:00, 11:00)
 * Києва. Замінює єдину погодинну спробу (kyivHour()===8), яку 14.07 jitter крону
 * Cloudflare (Free) відсунув на ~50 хв — брифінг прийшов о 08:56 замість 08:0x.
 * Тепер до 36 спроб; помилка GitHub ретраїться за 15 хв, а не «завтра».
 * Умови дубля — shouldAutoDispatchBrief (tg-core.mjs, тестовано).
 */
export async function autoBriefDispatch(/** @type {Env} */ env) {
  const today = kyivDateKey();
  const [state, dispatch] = await Promise.all([loadState(env), loadBriefDispatch(env)]);
  const due = shouldAutoDispatchBrief({
    kyivHour: kyivHour(),
    todayKey: today,
    nowMs: Date.now(),
    lastAutoDate: dispatch.lastAutoDate,
    lastDispatchMs: dispatch.lastMs,
    lastSentDate: state.lastSentDate,
  });
  if (!due) return;
  // masteryFocus — ДО dispatch: брифінг (і можливий mock-батч) читає свіжу
  // «тему тижня» цього ж ранку (важливо на межі тижня — понеділок).
  await updateMasteryFocus(env);
  if (await dispatchBrief(env)) await recordBriefDispatch(env, today);
}

/**
 * П'ятихвилинний крон-гейт: вікно слоту (matchCheckinNudgeWindow) -> зібрати
 * три прапорці з KV (тихі години/вже нагадали/слот заповнено) -> чиста
 * shouldSendCheckinNudge (stats-core.mjs, тестована без KV/fetch) вирішує.
 * Ідемпотентно за добу — store.checkinNudgeDates[slot] (той самий "останню
 * дату записав" ідіом, що dispatch.lastAutoDate/reliability.lastCheckDate —
 * не зростаючий журнал, один рядок на слот).
 */
export async function checkinNudgeCheck(/** @type {Env} */ env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const minuteOfDay = kyivMinuteOfDay(new Date());
  const win = matchCheckinNudgeWindow(minuteOfDay);
  if (!win) return;

  const [settings, store] = await Promise.all([loadSettings(env), loadStats(env)]);
  const today = kyivDateKey();
  const dateKey = checkinDateKey(today, kyivHour());
  const due = shouldSendCheckinNudge({
    quiet: isQuietMinute(settings, minuteOfDay),
    alreadyNudgedToday: store.checkinNudgeDates?.[win.slot] === today,
    // ⚠️ НЕ Boolean(...): порожній обʼєкт істинний. Саме на цьому нагадування
    // й ламалось — відмітив відповідь, зняв повторним тапом, слот лишився як
    // `{}`, і нудж на добу зникав. Тепер предикат ОДИН на весь проєкт.
    slotFilled: isCheckinSlotFilled(store.checkins?.[dateKey], win.slot),
  });
  if (!due) return;

  await tgCall(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    message_thread_id: env.TOPIC_ASSISTANT ?? undefined,
    text: win.text,
  });

  // Позначаємо ПІСЛЯ надсилання, окремим безпечним patch на свіжий stats —
  // не тим самим `store`, що читали для рішення `due` (той міг устигнути
  // застаріти, поки лист Telegram); sendMessage (побічний ефект) уже
  // стався РАЗ вище, тож сам patch — чиста, спокійно повторювана мутація.
  // НЕ normalize() тут — воно не знає про checkinNudgeDates (ad-hoc поле
  // поза emptyStore-схемою) і мовчки прибрало б його; той самий контракт,
  // що мав ОРИГІНАЛЬНИЙ код (прямий спред store, без normalize).
  await updateStats(env, (curStore) => ({
    ...curStore,
    checkinNudgeDates: { ...(curStore.checkinNudgeDates ?? {}), [win.slot]: today },
  }));
}

/**
 * П'ятихвилинний крон-гейт для Блоку «Сон»: те саме вікно-мисливство, що
 * checkinNudgeCheck, ПЛЮС прибирання завислих кнопок з МИНУЛИХ ночей —
 * власник прямо попросив: сповіщення не мусить просто висіти, якщо тап так і
 * не стався. Обидва кроки в одній функції — обидва читають/пишуть один і той
 * самий store, зайвий проліт у KV не потрібен.
 */
export async function sleepNudgeCheck(/** @type {Env} */ env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const minuteOfDay = kyivMinuteOfDay(new Date());
  const store = await loadStats(env);
  const nightKey = checkinDateKey(kyivDateKey(), kyivHour());

  // Побічні ефекти (editMessageText/sendMessage) збираємо як ЧИСТІ дані
  // (dateKey-и/msgId), не мутуємо `store` напряму тут — сам запис у KV
  // робимо ОКРЕМО, нижче, через updateStats на свіжому знімку. Інакше цей
  // крон (мережеві виклики Telegram — секунди) переписав би своєю
  // застарілою до-заповнення копією щойно записане авто-заповнення сну з
  // ранкового 'open' (реальний кейс, що й привів до цього фіксу).
  /** @type {string[]} */
  const clearedDateKeys = [];

  // 1) Ночі з надісланим, але НЕ натиснутим нагадуванням — уже не поточна ніч
  // (checkinDateKey тримає ТУ САМУ ніч стабільною аж до 06:00, тож «минула» тут
  // означає справді минула, а не просто «перейшли за північ»).
  for (const { dateKey, nudgeMsgId } of staleSleepNudges(store.sleepLog, nightKey)) {
    await tgCall(env, 'editMessageText', {
      chat_id: env.TELEGRAM_CHAT_ID,
      message_id: nudgeMsgId,
      text: '🌙 Не встиг зафіксувати — нічого, вранці вкажеш час сну вручну.',
      reply_markup: { inline_keyboard: [] },
    });
    clearedDateKeys.push(dateKey);
  }

  // 2) Нове нагадування — лише у вікні (23:00–02:00) і лише раз за ніч.
  let newNudge = null;
  if (inSleepNudgeWindow(minuteOfDay)) {
    const settings = await loadSettings(env);
    const due = shouldSendSleepNudge({
      quiet: isQuietMinute(settings, minuteOfDay),
      alreadySentTonight: store.sleepLog?.[nightKey]?.nudgeMsgId != null,
    });
    if (due) {
      const res = await tgCall(env, 'sendMessage', {
        chat_id: env.TELEGRAM_CHAT_ID,
        message_thread_id: env.TOPIC_ASSISTANT ?? undefined,
        text: SLEEP_NUDGE_TEXT,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌙 Ліг спати', callback_data: buildSleepStartCallbackData() }],
          ],
        },
      });
      const sent = await res.json().catch(() => null);
      const msgId = sent?.result?.message_id;
      if (typeof msgId === 'number') newNudge = { nightKey, msgId };
    }
  }

  if (clearedDateKeys.length === 0 && !newNudge) return;

  // Усі Telegram-виклики вже сталися РАЗ вище; сам patch на sleepLog —
  // чиста, безпечно повторювана мутація (не normalize() — те саме
  // застереження, що в checkinNudgeCheck: ad-hoc поля поза emptyStore не
  // мають зникати).
  await updateStats(env, (curStore) => {
    const next = { ...curStore, sleepLog: { ...(curStore.sleepLog ?? {}) } };
    for (const dateKey of clearedDateKeys) {
      next.sleepLog[dateKey] = { ...next.sleepLog[dateKey], nudgeCleared: true };
    }
    if (newNudge) {
      next.sleepLog[newNudge.nightKey] = {
        ...next.sleepLog[newNudge.nightKey],
        nudgeMsgId: newNudge.msgId,
      };
    }
    return next;
  });
}

/** Dead-man's-switch: KV не оновлено сьогодні -> алерт у Telegram.
 *  Веде й облік надійності (reliability у stats). Ідемпотентний за добу — та сама
 *  мітка reliability.lastCheckDate гейтить і алерт (ревʼю A: перевірку перенесено
 *  на пʼятихвилинний крон, бо погодинний із гейтом kyivHour()===10 гинув від того
 *  самого jitter'а, від якого ми щойно врятували dispatch — зсув на годину, і
 *  сторож просто мовчав би цілий день). */
export async function deadMansCheck(/** @type {Env} */ env) {
  if (kyivHour() < DEAD_MAN_HOUR) return;
  const today = kyivDateKey();
  // Дешевий гейт «уже перевіряли сьогодні» ПЕРЕД будь-якою іншою роботою: без
  // нього алерт летів би на кожен 5-хвилинний тік до кінця доби.
  const store = await loadStats(env);
  if (store?.reliability?.lastCheckDate === today) return;

  const raw = await env.BRIEFING.get('latest');
  let fresh = false;
  try {
    const d = JSON.parse(raw ?? '{}');
    fresh = typeof d.generatedAt === 'string' && kyivDateKey(new Date(d.generatedAt)) === today;
  } catch {
    /* биття JSON -> вважаємо несвіжим -> алерт */
  }
  // Облік доставки — до гейта секретів (не потребує Telegram-крендів), але в
  // try/catch: транзієнтна KV-помилка НЕ сміє заблокувати алерт нижче (це його
  // день). updateStats — той самий безпечний read-modify-write, що й решта
  // писарів stats-блоба (recordReliability і так уже ідемпотентний за
  // lastCheckDate, тож повторне застосування при конфлікті — безпечне).
  try {
    await updateStats(env, (curStore) => recordReliability(curStore, today, fresh));
  } catch (/** @type {any} */ e) {
    console.error('reliability write failed', e);
  }
  if (fresh) return;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_* відсутні — dead-man пропущено');
    return;
  }

  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      // Фаза B: тема «⚠️ Система» (операційні алерти окремо від контенту
      // брифінгу). TOPIC_SYSTEM не заведено -> фолбек на стару поведінку
      // (TOPIC_BRIEFING), щоб алерт не «загубився» для власників, які ще
      // не створили нову тему. `||`, не `??` — порожній рядок (Cloudflare-
      // змінна заведена, але лишена пустою) теж має фолбечити, не «зʼїдати»
      // резервну тему мовчки.
      message_thread_id: env.TOPIC_SYSTEM || env.TOPIC_BRIEFING || undefined,
      text: '⚠️ Свiтанок: ранковий брифінг сьогодні не доставлено (KV не оновлено). Перевір GitHub Actions → workflow «brief».',
    }),
  });
  if (!resp.ok) {
    console.error('dead-man alert failed', resp.status, await resp.text());
  }
}
