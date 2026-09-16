// Знімок «сьогодні в календарі» для брифінгу (ADR-027, етап 7 PR-2).
//
// Брифінг доти сам ходив у Google Calendar - і саме тому в GitHub Secrets
// лежав GOOGLE_REFRESH_TOKEN. Тепер події на добу читає ядро (у нього токен
// і так є) і кладе їх у canonical `state.calendarToday`; legacy KV бачить
// лише compatibility snapshot, модуль брифінгу читає готовий список.
//
// ⚠️ ЗНІМОК ЖИВЕ РІВНО ОДНУ ДОБУ. Він несе дату, за яку зроблений, і брифінг
// НЕ показує його, якщо дата не сьогоднішня. Це навмисно: вчорашній список
// подій, поданий як сьогоднішній, гірший за відсутній блок - за ним власник
// ухвалює рішення про день.
//
// Свіжість: знімок робиться на першій появі планувальника з київською 07:00,
// брифінг іде о 08:00, тобто вік знімка ≤ 1 год. Подія, створена між ними, у
// ранковому блоці не зʼявиться - названа межа, не баг: календар «на зараз»
// власник дивиться через асистента (`calendar.read`), який ходить у Google
// наживо.

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { loadState, updateState } from '../../kv-store.mjs';
import { readCalendarRange, googleGrantedScopes } from '../../google.mjs';
import { hasFeatureScope } from '../google-scopes.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';

/** Ключ у блобі `state`, який читає src/modules/calendar.ts. */
export const CALENDAR_SNAPSHOT_KEY = 'calendarToday';
/** Година Києва, з якої знімок має сенс: брифінг о 08:00. */
export const CALENDAR_SNAPSHOT_HOUR = 7;
/** Скільки спроб за добу, перш ніж сказати вголос і замовкнути до завтра. */
export const CALENDAR_SNAPSHOT_MAX_ATTEMPTS = 6;
/**
 * Пауза між спробами. ⚠️ Без неї весь денний бюджет згорав за 15 хвилин:
 * `brief-dispatch` тікає щопʼять, тож чотири спроби припадали на 07:00-07:15,
 * і двадцятихвилинне блимання Google лишало брифінг без блоку, хоч до 08:00
 * було ще девʼять безкоштовних тіків.
 *
 * Числа підібрані так, щоб шість спроб укладались рівно у вікно 07:00-08:00:
 * пауза в 15 хв (перша версія цього фіксу) робила невдачу о 07:50 непоправною
 * - її друга спроба випадала вже після брифінгу.
 */
export const CALENDAR_SNAPSHOT_RETRY_MS = 10 * 60_000;
/** Стеля подій у знімку: довший блок у брифінгу однаково не читається. */
export const CALENDAR_SNAPSHOT_CAP = 30;

/**
 * @typedef {{ date: string, ready: boolean, events: { title: string, time: string | null }[],
 *   updatedAt: string, attempts: number, attemptAt: number, alerted: boolean }} CalendarSnapshot
 */

/** Знімок із блоба; чужа/побита форма - null. @param {unknown} raw
 *  @returns {CalendarSnapshot | null} */
export function parseSnapshot(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : null;
  if (!o || typeof o.date !== 'string' || !o.date) return null;
  return {
    date: o.date,
    ready: o.ready === true,
    events: Array.isArray(o.events) ? o.events : [],
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    attempts: Number.isFinite(o.attempts) ? Number(o.attempts) : 0,
    attemptAt: Number.isFinite(o.attemptAt) ? Number(o.attemptAt) : 0,
    alerted: o.alerted === true,
  };
}

/**
 * Оновити знімок, якщо він не сьогоднішній і година вже настала. НІКОЛИ не
 * кидає: задача-власник (`brief-dispatch`) не має падати через календар.
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function refreshBriefCalendar(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) < CALENDAR_SNAPSHOT_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  const current = parseSnapshot((await readStateBlob(env))[CALENDAR_SNAPSHOT_KEY]);
  const sameDay = current?.date === today;
  if (sameDay && current?.ready) return { skipped: 'done' };
  const attempts = sameDay ? /** @type {CalendarSnapshot} */ (current).attempts : 0;
  if (attempts >= CALENDAR_SNAPSHOT_MAX_ATTEMPTS) return { skipped: 'attempts' };
  const attemptAt = sameDay ? /** @type {CalendarSnapshot} */ (current).attemptAt : 0;
  if (attempts > 0 && nowMs - attemptAt < CALENDAR_SNAPSHOT_RETRY_MS) return { skipped: 'wait' };

  // Без секретів Google знімка не буде ніколи - алертувати про це щодня
  // означало б плутати «не налаштовано» зі «зламалось» (той самий гейт, що в
  // mail-triage).
  if (!env.GOOGLE_REFRESH_TOKEN) return { skipped: 'no-google' };
  if (!hasFeatureScope(await googleGrantedScopes(env), 'calendar')) {
    return writeFailure(env, today, attempts, 'скоуп calendar не виданий', nowMs);
  }
  const events = await readCalendarRange(env, today, today);
  // null - джерело недоступне. Порожній масив - подій немає, і це ВІДПОВІДЬ:
  // її треба записати, інакше кожна поява стукала б у Google цілий день.
  if (events == null) {
    return writeFailure(env, today, attempts, 'Google Calendar не відповів', nowMs);
  }

  const trimmed = events.slice(0, CALENDAR_SNAPSHOT_CAP).map((e) => ({
    title: String(e.title ?? ''),
    time: typeof e.time === 'string' ? e.time : null,
  }));
  await writeSnapshot(env, {
    date: today,
    ready: true,
    events: trimmed,
    updatedAt: new Date(nowMs).toISOString(),
    attempts: attempts + 1,
    attemptAt: nowMs,
    alerted: false,
  });
  return { written: trimmed.length };
}

/**
 * @param {Env} env @param {string} today @param {number} attempts
 * @param {string} reason @param {number} nowMs
 */
async function writeFailure(env, today, attempts, reason, nowMs) {
  const next = attempts + 1;
  const alerted = next >= CALENDAR_SNAPSHOT_MAX_ATTEMPTS;
  await writeSnapshot(env, {
    date: today,
    ready: false,
    events: [],
    updatedAt: '',
    attempts: next,
    attemptAt: nowMs,
    alerted,
  });
  console.error(`calendar-snapshot: ${reason} (спроба ${next})`);
  if (alerted) {
    await sendSystemAlert(
      env,
      `Календар на ${today} не прочитався (${reason}) - брифінг сьогодні без блоку «Сьогодні в календарі».`,
      nowMs,
    );
  }
  return { failed: reason, attempts: next };
}

/** @param {Env} env @param {CalendarSnapshot} snapshot */
async function writeSnapshot(env, snapshot) {
  await updateState(env, (store) => ({ ...store, [CALENDAR_SNAPSHOT_KEY]: snapshot }));
}

/** @param {Env} env @returns {Promise<Record<string, unknown>>} */
async function readStateBlob(env) {
  return loadState(env);
}
