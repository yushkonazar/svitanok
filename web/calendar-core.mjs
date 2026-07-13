// Чиста логіка Google Calendar для Worker-агента (Блок P2b): межі дня (DST-safe,
// той самий трюк що src/modules/calendar.ts — окремий порт, Worker і orchestrator
// різні рантайми без спільного бандлера, той самий патерн що tg-core.mjs/telegram.ts),
// парс подій, будівник тіла запиту на створення події, компактне форматування для
// LLM-промпту. Без I/O — Worker робить OAuth/fetch (googleAccessToken/
// readCalendarEvents/createCalendarEvent у worker.js).

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

/**
 * Google Calendar events.list JSON -> [{id,title,time,date}]. Без items -> [].
 * `date` ("YYYY-MM-DD" Київ) додано в CC1 для багатоденних діапазонів — timed-
 * подія конвертується в київську дату, all-day (start.date) береться дослівно
 * (floating date без TZ — не зсуваємо). Для однодневного readCalendar не
 * використовується (formatEventsForPrompt його ігнорує).
 */
export function parseEvents(json) {
  const items = json?.items;
  if (!Array.isArray(items)) return [];
  return items.map((e) => ({
    id: typeof e.id === 'string' ? e.id : null,
    title: cleanTitle(e.summary),
    time: e.start?.dateTime ? kyivHhMm(e.start.dateTime) : null,
    date: e.start?.date ? e.start.date : e.start?.dateTime ? kyivDateKeyOf(e.start.dateTime) : null,
  }));
}

/** Тіло events.insert — одноразова подія (без RRULE), Європа/Київ. */
export function buildCreateEventBody({ title, startIso, endIso }) {
  return {
    summary: title,
    start: { dateTime: startIso, timeZone: 'Europe/Kyiv' },
    end: { dateTime: endIso, timeZone: 'Europe/Kyiv' },
  };
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
