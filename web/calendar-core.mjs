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

function kyivHhMm(iso) {
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(new Date(iso));
}

/** Google Calendar events.list JSON -> [{id,title,time}]. Без items -> []. */
export function parseEvents(json) {
  const items = json?.items;
  if (!Array.isArray(items)) return [];
  return items.map((e) => ({
    id: typeof e.id === 'string' ? e.id : null,
    title: e.summary?.trim() || '(без назви)',
    time: e.start?.dateTime ? kyivHhMm(e.start.dateTime) : null,
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

/** Компактний текст подій дня для наступного раунду LLM-промпту (бюджет MAX_PROMPT_LEN). */
export function formatEventsForPrompt(events) {
  if (!Array.isArray(events) || events.length === 0) return 'подій немає';
  return events.map((e) => (e.time ? `${e.time} ${e.title}` : `увесь день: ${e.title}`)).join('; ');
}
