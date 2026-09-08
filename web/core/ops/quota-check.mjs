// Задача `quota-check` (07 §7, 01 §7, етап 7 PR-5): раз на добу подивитись на
// платні лічильники й сказати вголос, якщо місяць іде до стелі.
//
// ⚠️ ЧИМ ЦЕ ВІДРІЗНЯЄТЬСЯ ВІД АЛЕРТІВ `bumpQuota`. Ті спрацьовують у момент
// ПЕРЕТИНУ 80 % і 100 % - рівно раз, з одного виклику API. Це добре, але має
// дві діри. Перша: якщо алерт не доїхав (черга, Telegram, деплой саме тоді),
// другого шансу вже не буде - точка перетину минула. Друга: перетин каже про
// минуле, а не про напрям - витративши 60 % за тиждень, власник дізнається
// про проблему аж на 80 %, коли міняти щось пізно.
//
// Тому тут - ЩОДЕННИЙ погляд і ПРОГНОЗ за темпом місяця: скільки вийде до
// кінця, якщо витрачати як досі. Прогноз рахується від київського місяця -
// того самого, за яким живуть лічильники (quotaPeriod).

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import { readQuotas } from '../quota/quota.mjs';

/** Година перевірки за Києвом. */
export const QUOTA_CHECK_HOUR = 9;
/** Мітка «сьогодні вже дивився». */
export const QUOTA_CHECK_MARKER = 'quotaCheckDay';
/** Частка, з якої мовчати вже не можна. */
export const QUOTA_WARN_SHARE = 0.8;
/** Прогноз понад стелю - привід сказати навіть на 40 % витраченого. */
export const QUOTA_FORECAST_SHARE = 1;
/**
 * Ключі, за якими платять ГРОШИМА у межах МІСЯЦЯ (01 §7). Решта лічильників -
 * безкоштовні квоти запитів: там перетину 80 % досить.
 *
 * ⚠️ `deepgram_min` сюди НЕ входить, і це не пропуск (ревʼю етапу 7).
 * Його стеля - 46 500 хв - це ЖИТТЄВИЙ кредит $200, а `quota_counters` живуть
 * київським місяцем: щоб перетнути 80 % за 30 діб, треба 620 годин аудіо -
 * більше, ніж хвилин у місяці. Тобто щоденна перевірка не сказала б про нього
 * нічого ніколи. Витрату кредиту видно у звіті `runs.query`; окремий
 * накопичувальний лічильник - рішення поза цим етапом.
 */
export const PAID_KEYS = ['gemini_usd'];

/**
 * @typedef {{ key: string, value: number, limit: number, share: number,
 *   forecast: number, reason: 'share' | 'forecast' }} QuotaFinding
 */

/**
 * Що сказати власнику. Чиста функція - день місяця й лічильники на вході.
 * @param {{ key: string, value: number, limit_value: number }[]} rows
 * @param {{ dayOfMonth: number, daysInMonth: number }} month
 * @returns {QuotaFinding[]}
 */
export function quotaFindings(rows, month) {
  /** @type {QuotaFinding[]} */
  const out = [];
  for (const row of rows) {
    if (!PAID_KEYS.includes(row.key)) continue;
    const limit = Number(row.limit_value);
    const value = Number(row.value);
    if (!(limit > 0) || !(value > 0)) continue;
    const share = value / limit;
    // Прогноз лінійний і чесно грубий: перший день місяця дає найбільшу
    // похибку, тому до третього дня прогноз не рахуємо взагалі - інакше одна
    // картинка 1-го числа «прогнозувала» б 30 картинок.
    const forecast = month.dayOfMonth >= 3 ? (value / month.dayOfMonth) * month.daysInMonth : 0;
    if (share >= QUOTA_WARN_SHARE) {
      out.push({ key: row.key, value, limit, share, forecast, reason: 'share' });
    } else if (forecast > limit * QUOTA_FORECAST_SHARE) {
      out.push({ key: row.key, value, limit, share, forecast, reason: 'forecast' });
    }
  }
  return out;
}

/** @param {QuotaFinding[]} findings */
export function quotaText(findings) {
  const lines = findings.map((f) =>
    f.reason === 'share'
      ? `• ${f.key}: ${f.value.toFixed(2)} із ${f.limit} (${Math.round(f.share * 100)} %)`
      : `• ${f.key}: ${f.value.toFixed(2)} із ${f.limit}; таким темпом вийде ~${f.forecast.toFixed(2)} до кінця місяця`,
  );
  return `💳 Витрати місяця:\n${lines.join('\n')}`;
}

/** Скільки діб у київському місяці дати. @param {string} dateKey */
export function daysInMonthOf(dateKey) {
  const [y, m] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
}

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function quotaCheckTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== QUOTA_CHECK_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(QUOTA_CHECK_MARKER)) === today) return { skipped: 'done' };
  if (!env.DB) {
    console.error('quota-check: привʼязки DB немає - лічильники недоступні');
    return { skipped: 'no-db' };
  }

  /** @type {{ key: string, value: number, limit_value: number }[]} */
  let rows;
  try {
    rows = /** @type {any[]} */ (await readQuotas(env, nowMs));
  } catch (/** @type {any} */ e) {
    console.error('quota-check: лічильники не прочитались', e?.message);
    return { skipped: 'read-failed' };
  }
  const findings = quotaFindings(rows, {
    dayOfMonth: Number(today.slice(8, 10)),
    daysInMonth: daysInMonthOf(today),
  });
  if (findings.length) await sendSystemAlert(env, quotaText(findings), nowMs);
  // Мітка ПІСЛЯ відправки: збій алерту не має рахуватись «сьогодні вже
  // дивився», інакше єдина спроба на добу згоряє мовчки.
  await env.BRIEFING.put(QUOTA_CHECK_MARKER, today);
  return { findings: findings.length };
}
