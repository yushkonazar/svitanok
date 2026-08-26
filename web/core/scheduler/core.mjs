// Чиста логіка планувальника (07-schema §7): що прострочене, коли наступний
// alarm, як рахується dedupe-ключ появи і статистика джитера. Платформна
// обгортка (Durable Object, SQL, alarm API) — у сусідньому do.mjs; тут нічого
// з workerd немає, і саме це тестується без платформи.

import { kyivDateKey } from '../../kyiv-time.mjs';

/**
 * Рядок таблиці `jobs` (07 §7). `period` — хвилини між появами; null = разова
 * задача (зникає після виконання). `dedupe_key` — ключ ОСТАННЬОЇ виконаної
 * появи: захист від подвійного виконання тієї самої появи (alarm і
 * cron-сторож можуть прийти по ту саму), а не від кількох появ на добу.
 *
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   due_at: string,
 *   period: number | null,
 *   payload_json: string | null,
 *   last_run_at: string | null,
 *   last_status: string | null,
 *   attempts: number,
 *   dedupe_key: string | null,
 * }} SchedulerJob
 */

/**
 * Скільки тиші після запланованого alarm сторож терпить, перш ніж тікнути сам.
 * 60 с: типовий джитер alarm — секунди, а подвійне виконання появи однаково
 * закрите dedupe-ключем, тож передчасний рятунок коштує лише зайвого тіку.
 * Більший грейс подовжував би найгірший простій задачі при втраченому alarm
 * (рятунок аж на другому крон-тіку — до ~7 хв замість ~6).
 */
export const WATCHDOG_GRACE_MS = 60_000;

/** Стеля вибірки джитера: доба 5-хвилинних появ. Старіше витісняється. */
const JITTER_SAMPLES_CAP = 288;

/**
 * Прострочені задачі, найдавніша перша: тік виконує їх послідовно, і порядок
 * за due_at означає «хто довше чекав — той перший».
 * @param {SchedulerJob[]} jobs
 * @param {number} nowMs
 */
export function dueJobs(jobs, nowMs) {
  return jobs
    .filter((j) => Date.parse(j.due_at) <= nowMs)
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
}

/**
 * Час наступного alarm — мінімальний due_at (07 §7: один alarm на DO).
 * null = задач немає, alarm не потрібен.
 * @param {SchedulerJob[]} jobs
 */
export function nextAlarmMs(jobs) {
  if (jobs.length === 0) return null;
  return Math.min(...jobs.map((j) => Date.parse(j.due_at)));
}

/**
 * Dedupe-ключ появи: `kind:YYYY-MM-DD:slot` (07 §7), де slot — UTC-час появи
 * (ISO). Той самий ключ у alarm'а і сторожа, що прийшли по одну появу; інший —
 * у наступної появи. Slot НАВМИСНО не київський: у день переведення годинника
 * назад київська хвилина доби повторюється двічі, і погодинна задача тихо
 * губила б одну появу на рік — UTC-момент унікальний завжди. Київська дата
 * лишається людським префіксом для логів і /status.
 * @param {string} kind
 * @param {string} dueAtIso
 */
export function occurrenceDedupeKey(kind, dueAtIso) {
  return `${kind}:${kyivDateKey(new Date(dueAtIso))}:${dueAtIso}`;
}

/**
 * Наступний due_at періодичної задачі: крок period уперед, ПРОПУСКАЮЧИ
 * пропущені появи. Після години простою worker'а задача з period=5 має
 * виконатись раз і чекати наступної появи, а не наздоганяти дванадцять —
 * той самий принцип «багато спроб, рівно один ефект», що в чинному кроні.
 * @param {string} dueAtIso
 * @param {number} periodMin
 * @param {number} nowMs
 */
export function advanceDueAt(dueAtIso, periodMin, nowMs) {
  const periodMs = periodMin * 60_000;
  const dueMs = Date.parse(dueAtIso);
  const missed = Math.max(0, Math.floor((nowMs - dueMs) / periodMs));
  return new Date(dueMs + (missed + 1) * periodMs).toISOString();
}

/**
 * Чи має cron-сторож тікнути сам: alarm відсутній (втрачений або ще не
 * ставився) або прострочений понад WATCHDOG_GRACE_MS (workerd його загубив чи
 * обробник упав). Свіжий чи майбутній alarm сторож не чіпає — інакше він
 * виконував би задачі замість alarm'а, і замір джитера мірив би сторожа.
 * @param {number | null} alarmMs
 * @param {number} nowMs
 */
export function shouldWatchdogTick(alarmMs, nowMs) {
  return alarmMs == null || alarmMs + WATCHDOG_GRACE_MS < nowMs;
}

/**
 * Додати замір джитера у вибірку зі стелею (нові в кінці, старі витісняються).
 * @param {number[]} samples
 * @param {number} jitterMs
 * @param {number} [cap]
 */
export function recordJitterSample(samples, jitterMs, cap = JITTER_SAMPLES_CAP) {
  return [...samples, jitterMs].slice(-cap);
}

/**
 * Зведення джитера для /status і приймання етапу (точність alarm — UNKNOWN у
 * 01 §2.1, цей замір її і закриває). p95 — верхня оцінка «звичайного» запізнення.
 * @param {number[]} samples
 * @returns {{ count: number, minMs: number, avgMs: number, p95Ms: number, maxMs: number } | null}
 */
export function jitterStats(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (/** @type {number} */ q) =>
    /** @type {number} */ (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return {
    count: sorted.length,
    minMs: /** @type {number} */ (sorted[0]),
    avgMs: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    p95Ms: at(0.95),
    maxMs: /** @type {number} */ (sorted[sorted.length - 1]),
  };
}
