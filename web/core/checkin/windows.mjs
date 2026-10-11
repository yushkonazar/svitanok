// Shared civil-time boundaries; server time, never a phone's clock, authorizes writes.
import { normalizeCheckinPreferences } from './catalog.mjs';
import { kyivParts, shiftDate } from '../finance/planning.mjs';

export const CHECKIN_WINDOW_SLOTS = ['morning', 'afternoon', 'evening'];
const MIN = 60000;
const civil = (/** @type {number} */ ms) => {
  const p = kyivParts(ms);
  return Date.parse(`${p.date}T00:00:00Z`) + (p.hour * 60 + p.minute) * MIN;
};
/** Kyiv civil boundary -> instant. At a DST fold close at the later occurrence;
 * at a skipped hour close at the first corresponding time after the gap.
 * @param {string} date @param {number} minutes */
export function checkinBoundary(date, minutes) {
  shiftDate(date, 0);
  const target = Date.parse(`${date}T00:00:00Z`) + minutes * MIN;
  const offsets = new Set([-86400000, 0, 86400000].map((d) => civil(target + d) - (target + d)));
  const candidates = [...offsets].map((offset) => target - offset);
  const exact = candidates.filter((ms) => civil(ms) === target);
  if (exact.length) return Math.max(...exact);
  return candidates.filter((ms) => civil(ms) > target).sort((a, b) => a - b)[0] ?? target;
}
/** @param {unknown} prefs */
export function checkinScheduleKey(prefs) {
  const p = normalizeCheckinPreferences(prefs);
  const text = `${p.version ?? 2}:${Object.values(p.schedule).join(':')}`;
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
/** @param {string} date @param {string} slot @param {unknown} prefs */
export function checkinWindow(date, slot, prefs) {
  if (!CHECKIN_WINDOW_SLOTS.includes(slot)) throw new Error('Невідомий чек-ін');
  const p = normalizeCheckinPreferences(prefs);
  const minute = (/** @type {string} */ value) =>
    Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const a = minute(p.schedule.morning),
    b = minute(p.schedule.afternoon),
    c = minute(p.schedule.evening),
    d = minute(p.schedule.end);
  const start = slot === 'morning' ? a : slot === 'afternoon' ? b : c;
  const end =
    slot === 'morning'
      ? p.version === 3 && a < 780 && b > 780
        ? 780
        : b
      : slot === 'afternoon'
        ? c
        : d <= a
          ? 1440 + d
          : d;
  const startAt = new Date(checkinBoundary(date, start)).toISOString();
  const baseEnd = new Date(checkinBoundary(date, end)).toISOString();
  return {
    dateKey: date,
    slot,
    key: checkinScheduleKey(p),
    startAt,
    baseEnd,
    endAt: baseEnd,
    extended: false,
  };
}
/** @param {{startAt:string,endAt:string}} window @param {number} nowMs */
export function checkinWindowOpen(window, nowMs) {
  return nowMs >= Date.parse(window.startAt) && nowMs < Date.parse(window.endAt);
}
/** A deep link is selection only: it never extends a slot or grants access.
 * @param {string} param */
export function checkinPathForStartParam(param) {
  const m = /^checkin_(\d{4}-\d{2}-\d{2})_(morning|afternoon|evening)$/.exec(param);
  if (!m?.[1] || !m[2]) return null;
  try {
    shiftDate(m[1], 0);
  } catch {
    return null;
  }
  return `/checkin?date=${m[1]}&slot=${m[2]}`;
}
/** @param {Env} env @param {string} date @param {string} slot @param {string|number|null} chatId */
export function checkinOpenButton(env, date, slot, chatId) {
  const param = `checkin_${date}_${slot}`,
    path = checkinPathForStartParam(param);
  if (!path) return null;
  const text = 'Відкрити чек-ін';
  const username = String(env.TELEGRAM_BOT_USERNAME ?? '')
    .trim()
    .replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(username))
    return { text, url: `https://t.me/${username}?startapp=${param}` };
  if (!env.MINI_APP_URL || chatId == null || Number(chatId) <= 0) return null;
  try {
    const url = new URL(env.MINI_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    if (url.pathname === '/' || url.pathname === '/index.html') url.pathname = '/app/';
    url.hash = path;
    return { text, web_app: { url: url.href } };
  } catch {
    return null;
  }
}
