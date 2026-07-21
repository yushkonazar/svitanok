// Чиста логіка Google Calendar для Worker-агента (Блок P2b): межі дня (DST-safe,
// той самий трюк що src/modules/calendar.ts — окремий порт, Worker і orchestrator
// різні рантайми без спільного бандлера, той самий патерн що tg-core.mjs/telegram.ts),
// парс подій, будівники тіл запиту на створення/зміну події, компактне
// форматування для LLM-промпту й для інтерактивного /agenda. Без I/O — Worker
// робить OAuth/fetch (googleAccessToken/readCalendarRange/createCalendarEvent/
// updateCalendarEvent/deleteCalendarEvent/getCalendarEvent у worker.js).

import { escapeHtml } from './tg-core.mjs';

/** Зсув TZ у мс для конкретного інстанту (через toLocaleString-трюк). */
function tzOffsetMs(timeZone, date) {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tz = new Date(date.toLocaleString('en-US', { timeZone }));
  return tz.getTime() - utc.getTime();
}

/** Межі київської доби dateKey як UTC-інстанти (RFC3339, DST-коректно). */
export function kyivDayBoundsUtc(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
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
export function kyivRangeBoundsUtc(startKey, endKey) {
  return {
    timeMin: kyivDayBoundsUtc(startKey).timeMin,
    timeMax: kyivDayBoundsUtc(endKey).timeMax,
  };
}

function kyivHhMm(iso) {
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(new Date(iso));
}

/** Київська дата "YYYY-MM-DD" інстанту (для date-поля timed-подій). */
function kyivDateKeyOf(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** "YYYY-MM-DD" -> "DD.MM" (компактна дата для багатоденного промпту). */
function ddmm(dateKey) {
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
function cleanTitle(summary) {
  const t = String(summary ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
  return t ? t.slice(0, MAX_EVENT_TITLE) : '(без назви)';
}

/** Інстант початку/кінця Google-подій — timed через dateTime, all-day через
 *  date (kyivDayBoundsUtc: `end.date` у Google ЕКСКЛЮЗИВНИЙ — «день ПІСЛЯ
 *  останнього дня події» — тож його ж 00:00 і є коректним кінцем інтервалу). */
function eventInstantMs(part) {
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
  }));
}

/**
 * Тіло events.insert — одноразова подія (без RRULE), Європа/Київ.
 * `reminderMinutes` (опційно) — popup-сповіщення за N хвилин до події
 * (доналаштування пропозиції). Не задано -> календар бере власний дефолт.
 */
export function buildCreateEventBody({ title, startIso, endIso, reminderMinutes }) {
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
  return body;
}

/**
 * Тіло events.patch — ЛИШЕ надані поля (часткове оновлення). На практиці
 * worker завжди резолвить title/startIso/endIso до повних значень (мерджить
 * із свіжопрочитаною подією) ще ДО виклику — тут лишається захисно-опційним,
 * щоб не вимагати зайвого від викликача/тестів.
 */
export function buildUpdateEventBody({ title, startIso, endIso }) {
  const body = {};
  if (title != null) body.summary = title;
  if (startIso != null) body.start = { dateTime: startIso, timeZone: 'Europe/Kyiv' };
  if (endIso != null) body.end = { dateTime: endIso, timeZone: 'Europe/Kyiv' };
  return body;
}

/**
 * Події з `events`, що ПЕРЕТИНАЮТЬСЯ з [startMs,endMs) — для попередження про
 * накладку в пропозиції (звичайний напівінтервал: суміжні події НЕ накладаються).
 * `excludeId` — id самої події, що редагується (updateEvent інакше сам на себе
 * «накладався» б).
 */
export function findOverlaps(events, startMs, endMs, excludeId = null) {
  if (!Array.isArray(events) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  return events.filter(
    (e) =>
      e &&
      e.id !== excludeId &&
      Number.isFinite(e.startMs) &&
      Number.isFinite(e.endMs) &&
      e.startMs < endMs &&
      e.endMs > startMs,
  );
}

/** Компактний текст подій ОДНОГО дня для наступного раунду LLM-промпту (бюджет MAX_PROMPT_LEN). */
export function formatEventsForPrompt(events) {
  if (!Array.isArray(events) || events.length === 0) return 'подій немає';
  return events.map((e) => (e.time ? `${e.time} ${e.title}` : `увесь день: ${e.title}`)).join('; ');
}

/**
 * Компактний текст подій ДІАПАЗОНУ днів (CC1) — кожна з префіксом "DD.MM",
 * щоб LLM розрізняла дні при запиті на кшталт «що цього тижня». Порожньо ->
 * "подій немає". Події вже відсортовані Google (orderBy=startTime).
 *
 * Кап (рев'ю CC1): діапазон до 7 днів може дати десятки подій — без обмеження
 * transcript ризикує перевищити MAX_PROMPT_LEN=4000 хоста (-> prompt-too-long
 * -> тихий фолбек замість відповіді). Тому ≤MAX_RANGE_EVENTS подій і ≤MAX_RANGE_LEN
 * символів; надлишок -> маркер «…(ще N)».
 */
export function formatRangeEventsForPrompt(events) {
  if (!Array.isArray(events) || events.length === 0) return 'подій немає';
  const shown = events.slice(0, MAX_RANGE_EVENTS);
  const hidden = events.length - shown.length;
  let out = shown
    .map((e) => {
      const prefix = e.date ? `${ddmm(e.date)} ` : '';
      return e.time ? `${prefix}${e.time} ${e.title}` : `${prefix}увесь день: ${e.title}`;
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
 *  тексту й порядок кнопок завжди збігались). */
function upcomingAgendaEvents(events, nowMs) {
  const upcoming = (Array.isArray(events) ? events : []).filter(
    (e) => e?.id && Number.isFinite(e.startMs) && e.startMs >= nowMs,
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

/** Telegram-текст /agenda (HTML) — нумерований список, «…ще N» за капом. */
export function formatAgendaMessage(events, nowMs) {
  const { shown, hiddenCount } = upcomingAgendaEvents(events, nowMs);
  if (shown.length === 0) return '📅 Найближчим часом подій немає.';
  const lines = ['📅 <b>Найближчі події:</b>', ''];
  shown.forEach((e, i) => {
    lines.push(`${i + 1}. ${agendaTimeFmt.format(new Date(e.startMs))} — ${escapeHtml(e.title)}`);
  });
  if (hiddenCount > 0) lines.push(`\n…ще ${hiddenCount}`);
  return lines.join('\n');
}

// Окремий простір callback_data від pd:/rm:/rc:/rd: (жоден не колізить —
// той самий мотив, що reminders-core.mjs документує для rc:/rm:).
export const AGENDA_CB_PREFIX = 'ev:';
// v=деталі пункту, e=стейджити редагування, d=стейджити видалення, b=назад до списку.
const AGENDA_ACTIONS = new Set(['v', 'e', 'd', 'b']);

/** `ev:<action>:<id>`; ≤64 байти (Telegram-ліміт, той самий guard, що pd:). */
export function buildAgendaCallbackData(action, id) {
  if (!AGENDA_ACTIONS.has(action)) return null;
  const s = `${AGENDA_CB_PREFIX}${action}:${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** Розібрати `ev:...` callback_data -> {action:'v'|'e'|'d'|'b', id}|null. */
export function parseAgendaCallbackData(data) {
  if (typeof data !== 'string' || !data.startsWith(AGENDA_CB_PREFIX)) return null;
  const [action, id] = data.slice(AGENDA_CB_PREFIX.length).split(':');
  if (!AGENDA_ACTIONS.has(action) || !id) return null;
  return { action, id };
}

/** Одна кнопка на подію (`ev:v:<id>`) — той самий зріз/порядок, що текст. */
export function buildAgendaKeyboard(events, nowMs) {
  const { shown } = upcomingAgendaEvents(events, nowMs);
  const rows = shown
    .map((e, i) => {
      const cb = buildAgendaCallbackData('v', e.id);
      if (!cb) return null;
      const label =
        e.title.length > MAX_AGENDA_BUTTON_LEN
          ? `${e.title.slice(0, MAX_AGENDA_BUTTON_LEN - 1)}…`
          : e.title;
      return [{ text: `${i + 1}. ${label}`, callback_data: cb }];
    })
    .filter(Boolean);
  return { inline_keyboard: rows };
}
