// Знімок активних нагадувань для ранкового briefing-а.
//
// Джерело істини нагадувань після фліпа — D1, тоді як GitHub Actions, що
// формує ранковий briefing, свідомо не має D1 credentials. Цей вузький
// worker-side адаптер читає обидва підтримувані джерела, дедуплікує за id і
// кладе лише нагадування, актуальні до кінця поточної київської доби, у
// canonical state. Так ранковий run не отримує доступу до всього D1 і не
// показує вчорашній snapshot як сьогоднішні задачі.

import { kyivDateKey } from '../../kyiv-time.mjs';
import { loadState, updateState } from '../../kv-store.mjs';
import { listActive } from '../../reminders-core.mjs';
import { listActiveReminders } from '../reminders/store.mjs';

export const REMINDER_SNAPSHOT_KEY = 'remindersToday';
export const REMINDER_SNAPSHOT_HOUR = 7;
export const REMINDER_SNAPSHOT_CAP = 20;
export const REMINDER_SNAPSHOT_TEXT_MAX = 240;

/** @typedef {{ id: string, text: string, dueAt: string }} BriefReminder */
/** @typedef {{ date: string, ready: boolean, reminders: BriefReminder[], updatedAt: string,
 *   source: 'both'|'d1'|'legacy' }} ReminderSnapshot */

/** @param {unknown} value */
function snapshotText(value) {
  const text = String(value ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
  return text ? text.slice(0, REMINDER_SNAPSHOT_TEXT_MAX) : null;
}

/** @param {unknown} raw @returns {ReminderSnapshot|null} */
export function parseReminderSnapshot(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : null;
  if (!o || typeof o.date !== 'string' || !o.date) return null;
  const source =
    o.source === 'both' || o.source === 'd1' || o.source === 'legacy' ? o.source : 'legacy';
  return {
    date: o.date,
    ready: o.ready === true,
    reminders: Array.isArray(o.reminders)
      ? o.reminders
          .slice(0, REMINDER_SNAPSHOT_CAP)
          .filter(
            (/** @type {any} */ r) =>
              r &&
              typeof r === 'object' &&
              typeof r.id === 'string' &&
              snapshotText(r.text) !== null &&
              typeof r.dueAt === 'string' &&
              Number.isFinite(Date.parse(r.dueAt)),
          )
          .map((/** @type {any} */ r) => ({
            id: r.id,
            text: /** @type {string} */ (snapshotText(r.text)),
            dueAt: r.dueAt,
          }))
      : [],
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    source,
  };
}

/**
 * Межа поточної київської доби. `2026-07-02T00:00:00+03:00` не годиться як
 * ручне правило через DST, тож беремо локальну дату наступного моменту через
 * Intl і порівнюємо ключі — досить для відсіву майбутніх нагадувань.
 * @param {number} ms @param {string} today
 */
function isTodayOrOverdue(ms, today) {
  return Number.isFinite(ms) && kyivDateKey(new Date(ms)) <= today;
}

/** @param {any[]} legacy @param {any[]} d1 @param {string} today */
export function mergeBriefReminders(legacy, d1, today) {
  /** @type {Map<string, BriefReminder>} */
  const byId = new Map();
  // D1 перемагає legacy-копію того самого id: після міграції це canonical
  // запис; порядок також означає, що помилковий старий текст не потрапить у
  // ранковий сигнал.
  for (const r of legacy) {
    const whenMs = Number(r?.whenMs);
    const text = snapshotText(r?.text);
    if (!r?.id || !text || !isTodayOrOverdue(whenMs, today)) continue;
    byId.set(String(r.id), {
      id: String(r.id),
      text,
      dueAt: new Date(whenMs).toISOString(),
    });
  }
  for (const r of d1) {
    const whenMs = Date.parse(String(r?.dueAt ?? ''));
    const text = snapshotText(r?.text);
    if (!r?.id || !text || !isTodayOrOverdue(whenMs, today)) continue;
    byId.set(String(r.id), {
      id: String(r.id),
      text,
      dueAt: new Date(whenMs).toISOString(),
    });
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .slice(0, REMINDER_SNAPSHOT_CAP);
}

/**
 * One fresh snapshot per day, before the auto-dispatch window. We deliberately
 * refresh it until 08:00: a reminder added after 07:00 must still be able to
 * enter the same morning's briefing. After 08:00 the current daily briefing
 * has already been dispatched, so extra D1 reads add no decision value.
 * @param {Env} env @param {number} [nowMs]
 */
export async function refreshBriefReminders(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const today = kyivDateKey(now);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv',
      hour: '2-digit',
      hour12: false,
    }).format(now),
  );
  if (hour < REMINDER_SNAPSHOT_HOUR || hour >= 8) return { skipped: 'hour' };

  const state = await loadState(env);
  const legacy = listActive(state.reminders);
  /** @type {any[]} */
  let d1 = [];
  let d1Available = false;
  try {
    d1 = await listActiveReminders(env);
    d1Available = true;
  } catch (/** @type {any} */ error) {
    // Не вдаємо, що D1-перелік повний. Snapshot все одно може бути корисним
    // для rollback-інсталяції з legacy-only даними; source нижче робить цю
    // межу явною для decision layer.
    console.error('brief-reminders: D1 список недоступний', error?.message);
  }
  const reminders = mergeBriefReminders(legacy, d1, today);
  const source = d1Available && legacy.length > 0 ? 'both' : d1Available ? 'd1' : 'legacy';
  // Після migration фліпа D1 — єдине повне джерело. Legacy-фолбек тут був би
  // небезпечним: він має вигляд повного списку, але може не містити жодного
  // нагадування, створеного асистентом. Тож явно позначаємо snapshot
  // непридатним, і decision layer його не покаже.
  const ready = d1Available || env.ASSISTANT_V2 !== 'on';
  const previous = parseReminderSnapshot(state[REMINDER_SNAPSHOT_KEY]);
  if (
    previous?.date === today &&
    previous.ready === ready &&
    JSON.stringify(previous.reminders) === JSON.stringify(reminders) &&
    previous.source === source
  ) {
    return { skipped: 'unchanged' };
  }
  await updateState(env, (current) => ({
    ...current,
    [REMINDER_SNAPSHOT_KEY]: {
      date: today,
      ready,
      reminders: ready ? reminders : [],
      updatedAt: new Date(nowMs).toISOString(),
      source,
    },
  }));
  return ready ? { written: reminders.length, source } : { skipped: 'd1-unavailable' };
}
