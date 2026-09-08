// Вечірній рядок про гроші (07 §7 `finance-evening`, S-4-7): о 21:00 Києва -
// один рядок про сьогоднішні витрати. Нуль покупок - ТИША (це не «0 грн», це
// «нема про що писати»).
//
// Рядок будує ядро з сум, без моделі: жодних оцінок, лише сума, кількість і
// найбільша покупка. Тестові транзакції (`/internal/test/mono`) у суму не
// входять - вона зріз для звітів (07 §3).

import { kyivDateKey, kyivHour, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { loadSettings } from '../../kv-store.mjs';
import { isQuietMinute } from '../../settings-core.mjs';
import { cleanSource, formatMoney } from '../format.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { kyivDayStartMs, selectSpending, summarize } from './query.mjs';

/** Година рядка за Києвом (07 §7). */
export const EVENING_HOUR = 21;
/** Мітка «сьогодні вже писали». */
export const EVENING_MARKER_KEY = 'financeEveningDay';

/**
 * Текст рядка за зведенням дня; null - писати нема про що.
 * Чиста функція: таблиця «скільки покупок → який рядок» перевіряється без бази.
 * @param {ReturnType<typeof summarize>} sum
 */
export function eveningText(sum) {
  if (!sum.n) return null;
  const parts = [`Сьогодні ${formatMoney(sum.total_uah, 'UAH')}`, purchasesWord(sum.n)];
  const top = sum.by_merchant[0];
  if (top && sum.n > 1) {
    parts.push(`найбільша ${cleanSource(top.name, 30)} ${formatMoney(top.total, 'UAH')}`);
  }
  const tail =
    sum.unconverted > 0 ? ` Ще ${sum.unconverted} у валюті - без гривневого еквівалента.` : '';
  return `${parts.join(' · ')}.${tail}`;
}

/** @param {number} n */
function purchasesWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} покупка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} покупки`;
  return `${n} покупок`;
}

/**
 * Задача `finance-evening`.
 * @param {Env} env @param {number} [nowMs]
 */
export async function financeEveningTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== EVENING_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(EVENING_MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB) {
    console.error('finance-evening: привʼязки DB немає - рядка не буде');
    return { skipped: 'no-db' };
  }
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('finance-evening: TELEGRAM_CHAT_ID немає - нікуди слати');
    return { skipped: 'no-chat' };
  }
  // Тиха зона власника - та сама, що для підказок і нагадувань.
  if (isQuietMinute(await loadSettings(env), kyivMinuteOfDay(now))) return { skipped: 'quiet' };

  const rows = await selectSpending(env, {
    from: new Date(kyivDayStartMs(nowMs)).toISOString(),
    to: new Date(nowMs).toISOString(),
  });
  const text = eveningText(summarize(rows));
  // Мітка стоїть у будь-якому разі: тиша - теж результат дня.
  await env.BRIEFING.put(EVENING_MARKER_KEY, today);
  if (!text) return { sent: false };
  await enqueueOutbox(
    env,
    {
      chatId: env.TELEGRAM_CHAT_ID,
      threadId: env.TOPIC_ASSISTANT ?? null,
      kind: 'send',
      payload: { text },
    },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
    console.error('finance-evening: драйн outbox впав, добере sweeper', e?.message),
  );
  return { sent: true, n: rows.length };
}
