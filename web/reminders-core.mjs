// Чиста логіка нагадувань (Блок P2a, частина 1 — rule-based, без LLM-фолбеку):
// парс українського часу з тексту ("через 20 хв", "завтра о 10", "о 15:30"),
// стор у state.reminders, вибірка «на видачу», snooze. Без I/O — Worker робить
// KV/HTTP; cron у Worker кличе dueReminders/markFired кожні 5 хв.
// LLM-фолбек для складніших формулювань — наступна фаза (потребує
// ANTHROPIC_API_KEY, свідомо не додано в цій частині — менший, безпечніший PR).

import { escapeHtml } from './tg-core.mjs';

const MINUTE = 60_000;
const HOUR = 3_600_000;
export const SNOOZE_MINUTES = 10;

/** UTC-офсет Києва (хв) у момент nowMs — DST-aware через Intl shortOffset. */
function kyivOffsetMinutes(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(nowMs));
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+2';
  const m = tz.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return 120;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** Київська дата "YYYY-MM-DD" у момент nowMs. */
function kyivDateKeyOf(nowMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

function addDaysToDateKey(dateKey, days) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Київський "dateKey HH:MM" (місцевий час) -> мс UTC. */
function kyivHmToUtcMs(dateKey, hh, mm, nowMs) {
  const naiveUtc = Date.parse(
    `${dateKey}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`,
  );
  return naiveUtc - kyivOffsetMinutes(nowMs) * MINUTE;
}

// Прибрати тригер-фразу з початку ("нагадай/нагадати/нагадуй [мені] [про]") —
// спільна точка входу і для "/remind <args>" (де її вже нема), і для вільного
// тексту в чаті (де вона є).
function stripTrigger(text) {
  return text.replace(/^\s*нагад(ай|ати|уй)(\s+мені)?(\s+про)?\s*/i, '');
}

function cleanRemainder(text, matched) {
  const rest = text
    .replace(matched, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return rest || 'Нагадування';
}

/**
 * Розібрати текст на {whenMs, remainder} — rule-based час (укр) + залишок як
 * текст нагадування. Порядок патернів (перший влучний перемагає): відносний
 * ("через N хв/год") -> "завтра/сьогодні о HH[:MM]" -> голе "о HH[:MM]".
 * "сьогодні о HH" що вже минуло -> null (не вгадуємо мовчки замість юзера).
 * Немає влучного патерну -> null (виклик далі пробує LLM-фолбек або відмовляє).
 */
export function parseReminderTime(rawText, nowMs = Date.now()) {
  if (typeof rawText !== 'string') return null;
  const text = stripTrigger(rawText.trim());
  if (!text) return null;

  const rel = text.match(/через\s+(\d+)\s*(хвилин[иу]?|хв\.?|годин[иу]?|год\.?)/i);
  if (rel) {
    const n = Number(rel[1]);
    if (n > 0) {
      const isHours = /^год/i.test(rel[2]);
      return {
        whenMs: nowMs + n * (isHours ? HOUR : MINUTE),
        remainder: cleanRemainder(text, rel[0]),
      };
    }
  }

  const explicitDay = text.match(/(завтра|сьогодні)\s+о\s+(\d{1,2})(?::(\d{2}))?/i);
  if (explicitDay) {
    const isTomorrow = /завтра/i.test(explicitDay[1]);
    const hh = Number(explicitDay[2]);
    const mm = Number(explicitDay[3] || 0);
    if (hh <= 23 && mm <= 59) {
      const today = kyivDateKeyOf(nowMs);
      const dateKey = isTomorrow ? addDaysToDateKey(today, 1) : today;
      const whenMs = kyivHmToUtcMs(dateKey, hh, mm, nowMs);
      if (isTomorrow || whenMs > nowMs) {
        return { whenMs, remainder: cleanRemainder(text, explicitDay[0]) };
      }
    }
    return null; // явний день + минулий час -> не перегадуємо за юзера
  }

  // \b не працює з кирилицею в JS (не \w) — межі слова емулюємо lookaround'ом.
  const bare = text.match(/(?<![а-яіїєґ'])о\s+(\d{1,2})(?::(\d{2}))?(?![а-яіїєґ\d])/i);
  if (bare) {
    const hh = Number(bare[1]);
    const mm = Number(bare[2] || 0);
    if (hh <= 23 && mm <= 59) {
      const today = kyivDateKeyOf(nowMs);
      let whenMs = kyivHmToUtcMs(today, hh, mm, nowMs);
      if (whenMs <= nowMs) whenMs = kyivHmToUtcMs(addDaysToDateKey(today, 1), hh, mm, nowMs);
      return { whenMs, remainder: cleanRemainder(text, bare[0]) };
    }
  }

  return null;
}

/** Додати нагадування (id/nowMs — від виклику, щоб функція лишалась чистою). */
export function addReminder(reminders, { id, text, whenMs, nowMs }) {
  const list = Array.isArray(reminders) ? reminders : [];
  return [...list, { id, text, whenMs, createdMs: nowMs, firedTs: null }];
}

/** Нагадування «на видачу»: час настав і ще не спрацьовувало. */
export function dueReminders(reminders, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).filter(
    (r) => r && typeof r.whenMs === 'number' && r.whenMs <= nowMs && !r.firedTs,
  );
}

/** Позначити спрацьованим (ідемпотентно — уже виставлений firedTs не чіпаємо). */
export function markFired(reminders, id, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).map((r) =>
    r.id === id ? { ...r, firedTs: r.firedTs ?? nowMs } : r,
  );
}

/** Відкласти на SNOOZE_MINUTES: новий whenMs, скинути firedTs (спрацює знову). */
export function snoozeReminder(reminders, id, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).map((r) =>
    r.id === id ? { ...r, whenMs: nowMs + SNOOZE_MINUTES * MINUTE, firedTs: null } : r,
  );
}

/** Підтвердження одразу після створення нагадування ("/remind"-відповідь). */
export function formatReminderConfirm(whenMs, remainder) {
  const time = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(whenMs));
  return `✅ Нагадаю ${time}: ${escapeHtml(remainder)}`;
}

/** Текст самого нагадування, коли час настав. */
export function formatReminderFired(text) {
  return `⏰ <b>Нагадування</b>\n${escapeHtml(text)}`;
}
