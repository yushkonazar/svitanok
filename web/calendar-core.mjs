// Чиста логіка Google Calendar для Worker-агента (Блок P2b): межі дня (DST-safe,
// той самий трюк що src/modules/calendar.ts — окремий порт, Worker і orchestrator
// різні рантайми без спільного бандлера, той самий патерн що tg-core.mjs/telegram.ts),
// парс подій, будівники тіл запиту на створення/зміну події, компактне
// форматування для LLM-промпту й для інтерактивного /agenda. Без I/O — Worker
// робить OAuth/fetch (googleAccessToken/readCalendarRange/createCalendarEvent/
// updateCalendarEvent/deleteCalendarEvent/getCalendarEvent у worker.js).

import { escapeHtml } from './tg-core.mjs';

/**
 * Подія календаря після parseEvents — саме ця форма ходить між усіма
 * функціями нижче, а не сирий JSON Google.
 * @typedef {{ id: string|null, title: string, time: string|null, date: string|null,
 *             startMs: number|null, endMs: number|null, location: string|null }} CalEvent
 */

/**
 * Мінімум, потрібний для перевірки перетину: лише межі (і `id`, щоб виключити
 * саму себе). `CalEvent` йому відповідає, зворотне не потрібне — тож функції
 * накладок беруть саме цей тип, а не повну подію. Так фікстура з двома полями
 * лишається легальним входом, а не приводом дописувати їй `title` і `date`.
 * @typedef {{ id?: string|null, title?: string, startMs?: number|null,
 *             endMs?: number|null }} EventSpan
 */

/** Зсув TZ у мс для конкретного інстанту (через toLocaleString-трюк).
 *  @param {string} timeZone
 *  @param {Date} date */
function tzOffsetMs(timeZone, date) {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tz = new Date(date.toLocaleString('en-US', { timeZone }));
  return tz.getTime() - utc.getTime();
}

/** Межі київської доби dateKey як UTC-інстанти (RFC3339, DST-коректно).
 *  @param {string} dateKey */
export function kyivDayBoundsUtc(dateKey) {
  // `?? NaN` замість деструктуризації з дефолтом: биту дату треба лишити NaN,
  // як було, а не підмінити нулем (той дав би реальну, але не ту дату).
  const parts = dateKey.split('-').map(Number);
  const y = parts[0] ?? NaN;
  const m = parts[1] ?? NaN;
  const d = parts[2] ?? NaN;
  const asUtcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = tzOffsetMs('Europe/Kyiv', new Date(asUtcMidnight));
  const startUtc = asUtcMidnight - offset; // київська 00:00 у реальному UTC
  const endUtc = startUtc + 24 * 3600 * 1000;
  return { timeMin: new Date(startUtc).toISOString(), timeMax: new Date(endUtc).toISOString() };
}

/**
 * Межі діапазону київських діб [startKey..endKey] як UTC-інстанти (Блок CC1):
 * timeMin — початок startKey, timeMax — кінець endKey. Google Calendar
 * events.list бере timeMin/timeMax в ОДНОМУ запиті, тож увесь тиждень читається
 * одним subrequest'ом (а не по дню в циклі). endKey МАЄ бути >= startKey
 * (гарантує викликач — extractAssistantAction клампить end до >= start).
 */
/**
 * @param {string} startKey
 * @param {string} endKey
 */
export function kyivRangeBoundsUtc(startKey, endKey) {
  return {
    timeMin: kyivDayBoundsUtc(startKey).timeMin,
    timeMax: kyivDayBoundsUtc(endKey).timeMax,
  };
}

function kyivHhMm(/** @type {string} */ iso) {
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(new Date(iso));
}

/** Київська дата "YYYY-MM-DD" інстанту (для date-поля timed-подій).
 *  @param {string} iso */
function kyivDateKeyOf(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** "YYYY-MM-DD" -> "DD.MM" (компактна дата для багатоденного промпту). */
function ddmm(/** @type {string} */ dateKey) {
  const [, m, d] = dateKey.split('-');
  return `${d}.${m}`;
}

const MAX_EVENT_TITLE = 80;
const MAX_RANGE_EVENTS = 30;
const MAX_RANGE_LEN = 900;

/** Назва події для промпту: сплющити переноси рядків (подія може бути
 *  третьосторонньою — спільна/запрошення — багаторядкова назва інакше могла б
 *  підробити розділювачі транскрипту «Користувач написав:»/«Твої дані:»,
 *  prompt-injection) і обрізати довжину. Порожня -> заглушка. */
function cleanTitle(/** @type {unknown} */ summary) {
  const t = String(summary ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
  return t ? t.slice(0, MAX_EVENT_TITLE) : '(без назви)';
}

const MAX_LOCATION_LEN = 200;

/** Місце події для промпту/показу: той самий анти-injection мотив, що
 *  cleanTitle (сплющити переноси, обрізати) — але БЕЗ заглушки «(без назви)»,
 *  бо порожнє місце — легітимний, частий стан (не всі події мають адресу). */
function cleanLocation(/** @type {unknown} */ location) {
  const t = String(location ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
  return t ? t.slice(0, MAX_LOCATION_LEN) : null;
}

/**
 * Google Maps «universal» пошук-URL (PR-12) — БЕЗ API-ключа й білінгу, просто
 * посилання, що Maps сам резолвить у найкращий збіг. null для порожнього
 * location (немає що показувати).
 * @param {unknown} location
 */
export function buildMapsUrl(location) {
  const loc = cleanLocation(location);
  return loc ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}` : null;
}

/** Інстант початку/кінця Google-подій — timed через dateTime, all-day через
 *  date (kyivDayBoundsUtc: `end.date` у Google ЕКСКЛЮЗИВНИЙ — «день ПІСЛЯ
 *  останнього дня події» — тож його ж 00:00 і є коректним кінцем інтервалу). */
function eventInstantMs(/** @type {KvBlob|null|undefined} */ part) {
  if (part?.dateTime) {
    const ms = Date.parse(part.dateTime);
    return Number.isFinite(ms) ? ms : null;
  }
  if (part?.date) {
    const ms = Date.parse(kyivDayBoundsUtc(part.date).timeMin);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Google Calendar events.list JSON -> [{id,title,time,date,startMs,endMs}].
 * Без items -> []. `date` ("YYYY-MM-DD" Київ, CC1) для багатоденних
 * діапазонів — timed-подія конвертується в київську дату, all-day
 * (start.date) береться дослівно (floating date без TZ — не зсуваємо).
 * `startMs`/`endMs` (CRUD: findOverlaps, /agenda now-фільтр, updateEvent —
 * обчислення нового endIso з durationMin) — додаткові, НЕ ламають наявних
 * споживачів (formatEventsForPrompt/formatRangeEventsForPrompt читають лише
 * .time/.title/.date).
 * @param {any} json сира відповідь events.list
 * @returns {CalEvent[]}
 */
export function parseEvents(json) {
  const items = json?.items;
  if (!Array.isArray(items)) return [];
  return items.map((e) => ({
    id: typeof e.id === 'string' ? e.id : null,
    title: cleanTitle(e.summary),
    time: e.start?.dateTime ? kyivHhMm(e.start.dateTime) : null,
    date: e.start?.date ? e.start.date : e.start?.dateTime ? kyivDateKeyOf(e.start.dateTime) : null,
    startMs: eventInstantMs(e.start),
    endMs: eventInstantMs(e.end),
    location: cleanLocation(e.location), // PR-12: null, якщо немає — Maps-лінк лише коли є що показати
  }));
}

/**
 * Тіло events.insert — одноразова подія (без RRULE), Європа/Київ.
 * `reminderMinutes` (опційно) — popup-сповіщення за N хвилин до події
 * (доналаштування пропозиції). Не задано -> календар бере власний дефолт.
 * `location` (PR-10, опційно) — нативне поле Google Calendar, простий рядок.
 * `attendees` (PR-10, опційно) — ВЖЕ РЕЗОЛЬВЛЕНІ email-адреси (worker резолвить
 * імена через People API ДО виклику цієї функції) — сюди нічого, крім готових
 * email, не потрапляє.
 * @param {{ title: string, startIso: string, endIso: string,
 *           reminderMinutes?: number|null, location?: string|null,
 *           attendees?: string[]|null }} opts
 * @returns {KvBlob}
 */
export function buildCreateEventBody({
  title,
  startIso,
  endIso,
  reminderMinutes,
  location,
  attendees,
}) {
  /** @type {KvBlob} */
  const body = {
    summary: title,
    start: { dateTime: startIso, timeZone: 'Europe/Kyiv' },
    end: { dateTime: endIso, timeZone: 'Europe/Kyiv' },
  };
  if (Number.isFinite(reminderMinutes)) {
    body.reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: reminderMinutes }],
    };
  }
  if (typeof location === 'string' && location) body.location = location;
  if (Array.isArray(attendees) && attendees.length) {
    body.attendees = attendees.map((email) => ({ email }));
  }
  return body;
}

/**
 * Тіло events.patch — ЛИШЕ надані поля (часткове оновлення). На практиці
 * worker завжди резолвить title/startIso/endIso до повних значень (мерджить
 * із свіжопрочитаною подією) ще ДО виклику — тут лишається захисно-опційним,
 * щоб не вимагати зайвого від викликача/тестів.
 * @param {{ title?: string|null, startIso?: string|null, endIso?: string|null,
 *           location?: string|null, attendees?: string[]|null }} opts
 * @returns {KvBlob}
 */
export function buildUpdateEventBody({ title, startIso, endIso, location, attendees }) {
  /** @type {KvBlob} */
  const body = {};
  if (title != null) body.summary = title;
  if (startIso != null) body.start = { dateTime: startIso, timeZone: 'Europe/Kyiv' };
  if (endIso != null) body.end = { dateTime: endIso, timeZone: 'Europe/Kyiv' };
  if (location != null) body.location = location;
  if (Array.isArray(attendees)) body.attendees = attendees.map((email) => ({ email }));
  return body;
}

/**
 * Події з `events`, що ПЕРЕТИНАЮТЬСЯ з [startMs,endMs) — для попередження про
 * накладку в пропозиції (звичайний напівінтервал: суміжні події НЕ накладаються).
 * `excludeId` — id самої події, що редагується (updateEvent інакше сам на себе
 * «накладався» б).
 * Узагальнено по типу події: усередині читаються лише межі й `id`, тож
 * викликач із повним CalEvent отримує назад CalEvent, а тест зі спрощеною
 * фікстурою — свою ж форму. Без цього фікстура дописувала б title/date лише
 * заради типу.
 * @template {EventSpan} T
 * @param {readonly T[]|null|undefined} events
 * @param {number} startMs
 * @param {number} endMs
 * @param {string|null} [excludeId]
 * @returns {T[]}
 */
export function findOverlaps(events, startMs, endMs, excludeId = null) {
  if (!Array.isArray(events) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  return events.filter(
    (e) =>
      e &&
      e.id !== excludeId &&
      Number.isFinite(e.startMs) &&
      Number.isFinite(e.endMs) &&
      (e.startMs ?? 0) < endMs &&
      (e.endMs ?? 0) > startMs,
  );
}

/** Компактний текст подій ОДНОГО дня для наступного раунду LLM-промпту (бюджет MAX_PROMPT_LEN). */
/**
 * Позначка `[id:…]` для події в промпті (U5).
 *
 * Без неї мутація подій була структурно неможливою: `sanitizeProposal` дропає
 * updateEvent/deleteEvent без `eventId`, а взяти той id моделі було НІЗВІДКИ —
 * промпт календаря його не показував. Обидві половини механізму існували, між
 * ними бракувало одного поля (перевірено власником наживо: асистент на «перенеси
 * всі завтрашні зустрічі» чесно відповів, що не має `[id:...]`).
 *
 * Той самий ID_RE, що й у sanitizeProposal: цей рядок модель ЕХОЄ назад, і він
 * іде в шлях URL Google Calendar API. Битий/відсутній id -> просто без позначки,
 * а не «[id:null]» — інакше модель радо скопіювала б слово «null».
 */
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const idMark = (/** @type {CalEvent} */ e) =>
  typeof e?.id === 'string' && EVENT_ID_RE.test(e.id) ? ` [id:${e.id}]` : '';

/**
 * `unknown`, бо перший рядок функції — це саме перевірка на сміття
 * (`Array.isArray(events) || … -> 'подій немає'`). Вужчий тип описував би не
 * контракт, а побажання.
 * @param {unknown} events
 */
export function formatEventsForPrompt(events) {
  if (!Array.isArray(events) || events.length === 0) return 'подій немає';
  return events
    .map((e) => `${e.time ? `${e.time} ${e.title}` : `увесь день: ${e.title}`}${idMark(e)}`)
    .join('; ');
}

/**
 * Компактний текст подій ДІАПАЗОНУ днів (CC1) — кожна з префіксом "DD.MM",
 * щоб LLM розрізняла дні при запиті на кшталт «що цього тижня». Порожньо ->
 * "подій немає". Події вже відсортовані Google (orderBy=startTime).
 *
 * Кап (рев'ю CC1): діапазон до 7 днів може дати десятки подій — без обмеження
 * transcript роздувається ще ДО першого кроку агента. Стелю хоста
 * MAX_PROMPT_LEN відтоді підняли, але далі її доїдають результати інструментів,
 * а переповнення ріже середину транскрипту. Тому ≤MAX_RANGE_EVENTS подій і
 * ≤MAX_RANGE_LEN символів; надлишок -> маркер «…(ще N)».
 * @param {unknown} events — той самий мотив, що formatEventsForPrompt
 */
export function formatRangeEventsForPrompt(events) {
  if (!Array.isArray(events) || events.length === 0) return 'подій немає';
  const shown = events.slice(0, MAX_RANGE_EVENTS);
  const hidden = events.length - shown.length;
  let out = shown
    .map((e) => {
      const prefix = e.date ? `${ddmm(e.date)} ` : '';
      const body = e.time ? `${prefix}${e.time} ${e.title}` : `${prefix}увесь день: ${e.title}`;
      return `${body}${idMark(e)}`;
    })
    .join('; ');
  if (out.length > MAX_RANGE_LEN) return out.slice(0, MAX_RANGE_LEN - 1).trimEnd() + '…';
  if (hidden > 0) out += `; …(ще ${hidden})`;
  return out;
}

/**
 * Чи кешований Google access-токен ще свіжий (SL3): є непорожній token-рядок і
 * expMs у майбутньому. Worker кешує токен у KV, щоб N раундів агента (кожен
 * читає календар) НЕ робили N окремих OAuth-обмінів. Биття/відсутність -> false
 * (перевидати). Час рахує викликач (чистота).
 * @param {KvBlob|null|undefined} cached
 * @param {number} nowMs
 */
export function isAccessTokenFresh(cached, nowMs) {
  return (
    !!cached &&
    typeof cached.token === 'string' &&
    cached.token.length > 0 &&
    typeof cached.expMs === 'number' &&
    cached.expMs > nowMs
  );
}

/* ══ /agenda — інтерактивний список найближчих подій ═══════════════════════
   readCalendarRange(startKey=сьогодні) читає від київської 00:00, НЕ від
   «зараз» (kyivRangeBoundsUtc — межі ДОБИ) — тому подія, що вже минула
   сьогодні, теж прийде від Google. Тут, і лише тут (не в readCalendar/
   formatRangeEventsForPrompt — той контекст для LLM може ще мати сенс),
   фільтруємо на «зараз», інакше /agenda показувала б вчорашній ранок. */

const MAX_AGENDA_ITEMS = 15;
const MAX_AGENDA_BUTTON_LEN = 30;

/** Майбутні (>= nowMs) події з .id, капнуто на MAX_AGENDA_ITEMS — той самий
 *  зріз ділять formatAgendaMessage і buildAgendaKeyboard (щоб нумерація
 *  тексту й порядок кнопок завжди збігались).
 *  @template {EventSpan} T
 *  @param {readonly T[]|null|undefined} events
 *  @param {number} nowMs
 *  @returns {{ shown: T[], hiddenCount: number }} */
function upcomingAgendaEvents(events, nowMs) {
  const upcoming = (Array.isArray(events) ? events : []).filter(
    (e) => e?.id && Number.isFinite(e.startMs) && (e.startMs ?? 0) >= nowMs,
  );
  return {
    shown: upcoming.slice(0, MAX_AGENDA_ITEMS),
    hiddenCount: Math.max(0, upcoming.length - MAX_AGENDA_ITEMS),
  };
}

const agendaTimeFmt = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Telegram-текст /agenda (HTML) — нумерований список, «…ще N» за капом.
 *  @param {readonly EventSpan[]|null|undefined} events
 *  @param {number} nowMs */
export function formatAgendaMessage(events, nowMs) {
  const { shown, hiddenCount } = upcomingAgendaEvents(events, nowMs);
  if (shown.length === 0) return '📅 Найближчим часом подій немає.';
  const lines = ['📅 <b>Найближчі події:</b>', ''];
  shown.forEach((e, i) => {
    // `?? 0` недосяжне: upcomingAgendaEvents лишає лише скінченні startMs.
    lines.push(
      `${i + 1}. ${agendaTimeFmt.format(new Date(e.startMs ?? 0))} — ${escapeHtml(e.title)}`,
    );
  });
  if (hiddenCount > 0) lines.push(`\n…ще ${hiddenCount}`);
  return lines.join('\n');
}

// Окремий простір callback_data від pd:/rm:/rc:/rd: (жоден не колізить —
// той самий мотив, що reminders-core.mjs документує для rc:/rm:).
export const AGENDA_CB_PREFIX = 'ev:';
// v=деталі пункту, e=стейджити редагування, d=стейджити видалення, b=назад до списку.
const AGENDA_ACTIONS = new Set(['v', 'e', 'd', 'b']);

/** `ev:<action>:<id>`; ≤64 байти (Telegram-ліміт, той самий guard, що pd:).
 *  @param {string} action
 *  @param {string} id
 *  @returns {string|null} */
export function buildAgendaCallbackData(action, id) {
  if (!AGENDA_ACTIONS.has(action)) return null;
  const s = `${AGENDA_CB_PREFIX}${action}:${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** Розібрати `ev:...` callback_data -> {action:'v'|'e'|'d'|'b', id}|null.
 *  @param {unknown} data */
export function parseAgendaCallbackData(data) {
  if (typeof data !== 'string' || !data.startsWith(AGENDA_CB_PREFIX)) return null;
  // Дефолт '' замість undefined: Set.has('') так само false, зате тип чистий.
  const [action = '', id] = data.slice(AGENDA_CB_PREFIX.length).split(':');
  if (!AGENDA_ACTIONS.has(action) || !id) return null;
  return { action, id };
}

/** Одна кнопка на подію (`ev:v:<id>`) — той самий зріз/порядок, що текст.
 *  @param {readonly EventSpan[]|null|undefined} events
 *  @param {number} nowMs */
export function buildAgendaKeyboard(events, nowMs) {
  const { shown } = upcomingAgendaEvents(events, nowMs);
  const rows = shown
    .map((e, i) => {
      // upcomingAgendaEvents уже відсіяв події без id.
      const cb = buildAgendaCallbackData('v', /** @type {string} */ (e.id));
      if (!cb) return null;
      // `?? ''` не змінює нічого для подій із parseEvents (там title завжди є,
      // хай і '(без назви)'), але робить кнопку стійкою до спрощеної події.
      const title = e.title ?? '';
      const label =
        title.length > MAX_AGENDA_BUTTON_LEN
          ? `${title.slice(0, MAX_AGENDA_BUTTON_LEN - 1)}…`
          : title;
      return [{ text: `${i + 1}. ${label}`, callback_data: cb }];
    })
    .filter(Boolean);
  return { inline_keyboard: rows };
}
