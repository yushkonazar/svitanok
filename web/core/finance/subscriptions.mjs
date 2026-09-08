// Облік підписок (07 §1 `subscriptions`, S-4-6, ADR-029).
//
// Запис веде ЯДРО детерміновано: та сама сума від того самого мерчанта з
// кроком 7/30/91/182/365 діб (±2) - підписка, і рядок зʼявляється сам. Модель
// сюди не втручається: її справа - `subscriptions.update` на прохання власника
// («скасуй підписку в обліку»).
//
// `period` у схемі - лише month·year, тож точний крок живе не в ньому, а в
// `next_at`: саме дата наступного списання потрібна нагадуванню, а month/year
// - грубий ярлик для людини.
//
// Скасована підписка НЕ воскресає: власник прибрав її з обліку свідомо, і
// наступне списання того ж мерчанта не має мовчки повертати рядок в active.

import { kyivDateKey, kyivHour } from '../../kyiv-time.mjs';
import { formatMoney, cleanSource } from '../format.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { merchantKey } from './rules.mjs';

/** Година нагадування за Києвом (окремо від підказки о 10:00 - S-4-6). */
export const REMIND_HOUR = 11;
/** За скільки діб до списання нагадуємо (S-4-6). */
export const REMIND_DAYS = 2;
/** Мітка «сьогодні вже нагадували» (одна на добу, як у решти задач). */
export const REMIND_MARKER_KEY = 'subscriptionRemindDay';
/** Скільки підписок називаємо в одному повідомленні. */
export const REMIND_MAX = 5;
/** Статуси рядка. */
export const SUBSCRIPTION_STATUSES = ['active', 'paused', 'cancelled'];
/** Префікс кнопки «Скасувати підписку в обліку» у просторі `m:` (07 §9). */
export const FS_CB = 'm:fs:';

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - підписки недоступні');
  return env.DB;
}

/** month·year за кроком у добах: рік - лише справжній річний крок.
 *  @param {number} stepDays */
export function periodLabel(stepDays) {
  return stepDays >= 300 ? 'year' : 'month';
}

/**
 * Крок між операцією і найближчою попередньою з тією самою сумою (доби,
 * округлено). null - попередніх немає.
 * @param {number} atMs @param {number[]} prevMs - новіші перші
 */
export function stepDaysOf(atMs, prevMs) {
  const prev = (prevMs ?? []).filter((ms) => ms < atMs).sort((a, b) => b - a)[0];
  if (prev == null) return null;
  return Math.round((atMs - prev) / 86_400_000);
}

/**
 * Записати або оновити підписку за повторним списанням (S-4-6). Викликається
 * з `ingestTransaction`, коли прапорець `subscription` уже порахований.
 *
 * @param {Env} env
 * @param {{ id: string, at: string, amount: number, currency: string, merchant: string }} tx
 * @param {number} stepDays
 * @param {number} nowMs
 * @returns {Promise<{ created: boolean } | null>} null - рядок скасований власником
 */
export async function upsertSubscription(env, tx, stepDays, nowMs) {
  const key = merchantKey(tx.merchant);
  if (!key || !(stepDays > 0)) return null;
  const existing = await findSubscriptionByMerchant(env, key, { includeCancelled: true });
  const nextAt = nextChargeAt(tx.at, stepDays);
  if (existing) {
    // Скасоване власником лишається скасованим (інакше кожне списання
    // повертало б рядок, який він щойно прибрав).
    if (existing.status === 'cancelled') return null;
    await db(env)
      .prepare(
        `UPDATE subscriptions SET amount = ?, currency = ?, period = ?, next_at = ?, last_tx_id = ?
         WHERE id = ?`,
      )
      .bind(Math.abs(tx.amount), tx.currency, periodLabel(stepDays), nextAt, tx.id, existing.id)
      .run();
    return { created: false };
  }
  await db(env)
    .prepare(
      `INSERT INTO subscriptions (id, merchant, period, amount, currency, next_at, last_tx_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .bind(
      crypto.randomUUID(),
      tx.merchant,
      periodLabel(stepDays),
      Math.abs(tx.amount),
      tx.currency,
      nextAt,
      tx.id,
      new Date(nowMs).toISOString(),
    )
    .run();
  return { created: true };
}

/**
 * Підписка за ключем мерчанта. Ключ рахується в JS (нормалізація складніша за
 * LIKE), тому читаємо список і порівнюємо тут.
 * @param {Env} env @param {string} key @param {{ includeCancelled?: boolean }} [opts]
 */
export async function findSubscriptionByMerchant(env, key, opts = {}) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, merchant, period, amount, currency, next_at, last_tx_id, status
       FROM subscriptions${opts.includeCancelled ? '' : " WHERE status != 'cancelled'"} LIMIT 500`,
    )
    .bind()
    .all();
  return /** @type {any} */ ((results ?? []).find((r) => merchantKey(r.merchant) === key) ?? null);
}

/**
 * Активні підписки (для finance.query і нагадування).
 * @param {Env} env @param {number} [limit]
 */
export async function listSubscriptions(env, limit = 50) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, merchant, period, amount, currency, next_at, status FROM subscriptions
       WHERE status != 'cancelled' ORDER BY next_at LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(200, limit)))
    .all();
  return (results ?? []).map((r) => ({
    id: String(r.id),
    merchant: String(r.merchant),
    period: r.period == null ? null : String(r.period),
    amount: r.amount == null ? null : Number(r.amount),
    currency: r.currency == null ? null : String(r.currency),
    next_at: r.next_at == null ? null : String(r.next_at),
    status: String(r.status),
  }));
}

/**
 * `subscriptions.update` (07 §4, T0): статус і/або дата наступного списання.
 * `next_at`: `undefined` - не чіпати, `null` - стерти (саме так «↩» повертає
 * підписку, у якої дати не було; `?? before` тут дав би 2026-10-01 замість NULL).
 * @param {Env} env @param {{ id: string, status?: string, next_at?: string | null }} args
 */
export async function updateSubscription(env, args) {
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('subscriptions.update: потрібен id');
  if (args.status != null && !SUBSCRIPTION_STATUSES.includes(args.status)) {
    throw new Error(
      `subscriptions.update: статус лише ${SUBSCRIPTION_STATUSES.join('·')}, не «${args.status}»`,
    );
  }
  if (args.next_at != null && !Number.isFinite(Date.parse(args.next_at))) {
    throw new Error('subscriptions.update: next_at має бути датою ISO-8601');
  }
  const before = /** @type {any} */ (
    await db(env)
      .prepare('SELECT id, merchant, status, next_at FROM subscriptions WHERE id = ?')
      .bind(id)
      .first()
  );
  if (!before) throw new Error(`subscriptions.update: підписки ${id} немає`);
  const status = args.status ?? String(before.status);
  const nextAt =
    args.next_at !== undefined
      ? args.next_at
      : before.next_at == null
        ? null
        : String(before.next_at);
  await db(env)
    .prepare('UPDATE subscriptions SET status = ?, next_at = ? WHERE id = ?')
    .bind(status, nextAt, id)
    .run();
  return {
    id,
    merchant: String(before.merchant),
    status,
    next_at: nextAt,
    // «↩» повертає рівно те, що було (policy бере це полем undo).
    before: { status: String(before.status), next_at: before.next_at ?? null },
  };
}

/** Кнопка «Скасувати підписку в обліку» (S-4-6). @param {string} id */
export function subscriptionButtons(id) {
  if (!/^[A-Za-z0-9_-]{1,44}$/.test(id)) return [];
  return [[{ text: 'Скасувати підписку в обліку', callback_data: `${FS_CB}${id}:cancel` }]];
}

/**
 * Задача `subscription-remind` (07 §7, S-4-6): за два дні до списання - один
 * рядок з кнопкою. Тиша, коли нічого не наближається, - штатний результат.
 * @param {Env} env @param {number} [nowMs]
 */
export async function subscriptionRemindTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== REMIND_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(REMIND_MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB) {
    console.error('subscription-remind: привʼязки DB немає - нагадувань не буде');
    return { skipped: 'no-db' };
  }
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('subscription-remind: TELEGRAM_CHAT_ID немає - нікуди слати');
    return { skipped: 'no-chat' };
  }

  const target = addDays(today, REMIND_DAYS);
  const { results } = await db(env)
    .prepare(
      `SELECT id, merchant, amount, currency, next_at FROM subscriptions
       WHERE status = 'active' AND next_at IS NOT NULL AND substr(next_at, 1, 10) = ?
       ORDER BY merchant LIMIT ?`,
    )
    .bind(target, REMIND_MAX)
    .all();
  const rows = results ?? [];
  // Мітку ставимо в будь-якому разі: «нічого не наближається» - теж результат
  // дня, і крутитись до 12:00 задачі нема сенсу.
  await env.BRIEFING.put(REMIND_MARKER_KEY, today);
  if (!rows.length) return { sent: false };

  for (const row of rows) {
    const amount =
      row.amount == null
        ? ''
        : ` ${formatMoney(Number(row.amount), String(row.currency ?? 'UAH'))}`;
    await enqueueOutbox(
      env,
      {
        chatId: env.TELEGRAM_CHAT_ID,
        threadId: env.TOPIC_ASSISTANT ?? null,
        kind: 'send',
        payload: {
          text: `Післязавтра ${cleanSource(String(row.merchant), 40)}${amount}.`,
          reply_markup: { inline_keyboard: subscriptionButtons(String(row.id)) },
        },
      },
      nowMs,
    );
  }
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
    console.error('subscription-remind: драйн outbox впав, добере sweeper', e?.message),
  );
  return { sent: true, count: rows.length };
}

/**
 * Дата наступного списання: КИЇВСЬКИЙ день операції + крок, і опівдні UTC.
 * Час доби тут не знання, а сміття: майбутнє списання прийде коли завгодно.
 * А опівдні - тому, що і нагадування, і підказка порівнюють `substr(next_at,
 * 1, 10)` з київським ключем доби: збережений UTC-час вечірньої операції
 * (22:30 UTC = 01:30 Києва) давав би дату на добу меншу, і «за два дні»
 * приходило б за три.
 * @param {string} atIso - час операції @param {number} stepDays
 */
export function nextChargeAt(atIso, stepDays) {
  const day = kyivDateKey(new Date(Date.parse(atIso) + stepDays * 86_400_000));
  return `${day}T12:00:00.000Z`;
}

/** YYYY-MM-DD + n діб. @param {string} dateKey @param {number} days */
export function addDays(dateKey, days) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
