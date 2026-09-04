// Задача `daily-hint` (07 §7, S-0-16, етап 3 PR-7): ≤ 1 проактивна підказка
// на добу о 10:00 Києва - один кандидат за пріоритетом trips → subscriptions
// → chains → ideas → facts. Дедуп на добу (KV-мітка ставиться і тоді, коли
// кандидата немає: тиша - теж рішення на сьогодні). facts.setting.hint_mute_json
// вимикає теми: «не нагадуй про X» модель кладе туди через facts.set.
//
// Відхилення від 07 §7 названо: «якщо того дня є вечірній рядок - підказка
// додається до нього» - вечірній рядок (finance-evening) приїде на етапі 6,
// доти підказка йде о 10:00 окремим повідомленням.
//
// Джерела етапів 5-6 (trips, subscriptions, chains) читаються вже зараз: поки
// таблиці порожні - кандидатів немає, а коли наповняться - підказки підуть
// без правок тут.

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { runFactsGet, runFactsSet } from '../tools/facts.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { escapeHtml } from '../../tg-core.mjs';

export const DAILY_HINT_MARKER_KEY = 'dailyHintDay';
export const DAILY_HINT_HOUR = 10;
/** Теми підказок - ключі для hint_mute_json (S-0-16). */
export const HINT_TOPICS = ['trips', 'subscriptions', 'chains', 'ideas', 'security'];
/** Пороги (07 §7 / S-0-16): поїздка ≤ 7 днів, списання ≤ 3 дні, ланцюг без
 *  руху ≥ 3 доби, ідея без руху ≥ 30 діб, Security Checkup раз на квартал. */
export const TRIP_DAYS_AHEAD = 7;
export const SUBSCRIPTION_DAYS_AHEAD = 3;
export const CHAIN_STALE_DAYS = 3;
export const IDEA_STALE_DAYS = 30;
export const SECURITY_CHECKUP_DAYS = 90;
/** Нагадування про checkup - не частіше, ніж раз на місяць (факт з датою
 *  останнього нагадування пише сама задача). */
export const SECURITY_HINT_EVERY_DAYS = 30;
export const SECURITY_HINT_KEY = 'security_hint_at';

/**
 * @typedef {{ topic: string, text: string }} Hint
 */

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function dailyHintTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== DAILY_HINT_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(DAILY_HINT_MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB) {
    console.error('daily-hint: привʼязки DB немає - задача не виконується');
    return { skipped: 'no-db' };
  }
  if (!env.TELEGRAM_CHAT_ID) return { skipped: 'no-chat' };

  const muted = await readMuted(env);
  const hint = await pickHint(env, today, nowMs, muted);
  if (hint) {
    await enqueueOutbox(
      env,
      {
        chatId: env.TELEGRAM_CHAT_ID,
        threadId: env.TOPIC_ASSISTANT ?? null,
        kind: 'send',
        payload: { text: formatHint(hint), parse_mode: 'HTML' },
      },
      nowMs,
    );
    await drainOutbox(env, { nowMs }).catch(() => {});
    if (hint.topic === 'security') {
      await runFactsSet(
        env,
        { kind: 'setting', key: SECURITY_HINT_KEY, value: today, source: 'inferred' },
        nowMs,
      );
    }
  }
  // Мітка - після відправки (або після рішення «нема чого»): збій enqueue
  // лишає день відкритим, і наступний тік у вікні 10:00 повторить.
  await env.BRIEFING.put(DAILY_HINT_MARKER_KEY, today);
  return hint ? { sent: true, topic: hint.topic } : { sent: false, muted };
}

/**
 * Перший кандидат за пріоритетом серед не вимкнених тем.
 * @param {Env} env
 * @param {string} today
 * @param {number} nowMs
 * @param {string[]} muted
 * @returns {Promise<Hint | null>}
 */
export async function pickHint(env, today, nowMs, muted) {
  const finders = [
    ['trips', () => tripHint(env, today)],
    ['subscriptions', () => subscriptionHint(env, today)],
    ['chains', () => chainHint(env, nowMs)],
    ['ideas', () => ideaHint(env, nowMs)],
    ['security', () => securityHint(env, nowMs)],
  ];
  for (const [topic, find] of finders) {
    if (muted.includes(/** @type {string} */ (topic))) continue;
    const text = await /** @type {() => Promise<string | null>} */ (find)();
    if (text) return { topic: /** @type {string} */ (topic), text };
  }
  return null;
}

/** @param {Env} env */
function db(env) {
  return /** @type {NonNullable<Env['DB']>} */ (env.DB);
}

/** @param {Env} env @param {string} today */
async function tripHint(env, today) {
  const until = addDaysToDateKey(today, TRIP_DAYS_AHEAD);
  const row = /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT to_text, date_from FROM trips
         WHERE date_from >= ? AND date_from <= ? AND (status IS NULL OR status NOT IN ('done', 'cancelled'))
         ORDER BY date_from LIMIT 1`,
      )
      .bind(today, until)
      .first()
  );
  if (!row) return null;
  const days = daysBetween(today, String(row.date_from));
  return `Поїздка «${String(row.to_text ?? '')}» ${days === 0 ? 'сьогодні' : `через ${days} ${pluralDays(days)}`} - перевір чеклист.`;
}

/** @param {Env} env @param {string} today */
async function subscriptionHint(env, today) {
  const until = addDaysToDateKey(today, SUBSCRIPTION_DAYS_AHEAD);
  const row = /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT merchant, amount, currency, next_at FROM subscriptions
         WHERE status = 'active' AND next_at IS NOT NULL AND substr(next_at, 1, 10) >= ? AND substr(next_at, 1, 10) <= ?
         ORDER BY next_at LIMIT 1`,
      )
      .bind(today, until)
      .first()
  );
  if (!row) return null;
  const date = String(row.next_at).slice(0, 10);
  const amount =
    row.amount != null
      ? ` ${(Number(row.amount) / 100).toFixed(2)} ${String(row.currency ?? '')}`
      : '';
  return `Списання ${String(row.merchant)}${amount} - ${ddmm(date)}.`;
}

/** @param {Env} env @param {number} nowMs */
async function chainHint(env, nowMs) {
  const before = new Date(nowMs - CHAIN_STALE_DAYS * 86_400_000).toISOString();
  const row = /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT kind, updated_at FROM chains WHERE status = 'waiting' AND updated_at <= ?
         ORDER BY updated_at LIMIT 1`,
      )
      .bind(before)
      .first()
  );
  if (!row) return null;
  const days = Math.floor((nowMs - Date.parse(String(row.updated_at))) / 86_400_000);
  return `Ланцюг «${String(row.kind)}» чекає на тебе ${days} ${pluralDays(days)} - продовжити чи скасувати?`;
}

/** @param {Env} env @param {number} nowMs */
async function ideaHint(env, nowMs) {
  const before = new Date(nowMs - IDEA_STALE_DAYS * 86_400_000).toISOString();
  const row = /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT rowid AS number, title, status, updated_at FROM ideas
         WHERE status IN ('нова', 'план готовий', 'погоджено', 'у роботі') AND updated_at <= ?
         ORDER BY updated_at LIMIT 1`,
      )
      .bind(before)
      .first()
  );
  if (!row) return null;
  const days = Math.floor((nowMs - Date.parse(String(row.updated_at))) / 86_400_000);
  return `Ідея #${row.number} «${String(row.title)}» (${String(row.status)}) без руху ${days} ${pluralDays(days)} - відкласти, відхилити чи в роботу?`;
}

/**
 * Security Checkup Google раз на квартал (01 §4.1): дата останньої перевірки
 * - facts.setting.security_checkup_at (власник каже «пройшов checkup»).
 * @param {Env} env @param {number} nowMs
 */
async function securityHint(env, nowMs) {
  const { result } = await runFactsGet(env, { kind: 'setting', key: 'security_checkup_at' });
  const last = Date.parse(String(result[0]?.value ?? ''));
  if (Number.isFinite(last) && nowMs - last < SECURITY_CHECKUP_DAYS * 86_400_000) return null;
  // Нагадали - не повторюємо щодня: раз на SECURITY_HINT_EVERY_DAYS, доки
  // власник не скаже дату (security_checkup_at) або не вимкне тему.
  const hinted = await runFactsGet(env, { kind: 'setting', key: SECURITY_HINT_KEY });
  const lastHint = Date.parse(String(hinted.result[0]?.value ?? ''));
  if (Number.isFinite(lastHint) && nowMs - lastHint < SECURITY_HINT_EVERY_DAYS * 86_400_000) {
    return null;
  }
  return 'Security Checkup Google - раз на квартал (myaccount.google.com/security-checkup). Пройшов - скажи, запишу дату.';
}

/** @param {Env} env @returns {Promise<string[]>} */
async function readMuted(env) {
  try {
    const { result } = await runFactsGet(env, { kind: 'setting', key: 'hint_mute_json' });
    const value = result[0]?.value;
    /** @type {unknown[]} */
    const topics = Array.isArray(value) ? value : Array.isArray(value?.topics) ? value.topics : [];
    return topics.map((t) => String(t)).filter((t) => HINT_TOPICS.includes(t));
  } catch (/** @type {any} */ e) {
    console.error(
      'daily-hint: hint_mute_json не прочитано - вважаю, нічого не вимкнено',
      e?.message,
    );
    return [];
  }
}

/** @param {Hint} hint */
export function formatHint(hint) {
  return `💡 ${escapeHtml(hint.text)}\n<i>«не нагадуй про ${hint.topic}» - вимкне цю тему</i>`;
}

/** @param {string} a @param {string} b - обидві YYYY-MM-DD */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** @param {number} n */
function pluralDays(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дні';
  return 'днів';
}

/** @param {string} dateKey */
function ddmm(dateKey) {
  const [, m, d] = dateKey.split('-');
  return `${d}.${m}`;
}
