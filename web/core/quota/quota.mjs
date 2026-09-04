// Лічильники квот (07-schema §1 `quota_counters`, 01-architecture §7): рядок
// на (key, period=YYYY-MM за Києвом), bump інкрементує і САМ шле алерт при
// перетині 80 % і 100 % - рівно один раз на перетин (точка перетину відома
// лише тут, у момент інкременту; окремій задачі-обхіднику нема чого ловити).
//
// Споживачі bump - адаптери платних API: Places/Routes/Gemini (етап 5/7),
// Deepgram (етап 2). Етап 1 постачає механізм і довідник лімітів; задача
// `quota-check` (щоденні КРЕДИТИ, не лічильники) прийде разом з адаптерами.

import { kyivDateKey } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';

/**
 * Місячні стелі з 01 §7 - довідник для адаптерів (передається в bump явно,
 * щоб виклик без ліміту було видно на код-ревʼю, а не щоб bump «сам знав»).
 * @type {Record<string, number>}
 */
export const QUOTA_LIMITS = {
  places_text: 5_000,
  places_details: 1_000,
  routes: 10_000,
  geocoding: 10_000,
  gemini_usd: 10,
  deepgram_min: 46_500, // кредит $200 / $0.0043 за хв
  actions_min: 2_000,
  workflow_steps: 500_000,
};

/** Період лічильника - київський місяць (доба власника, не UTC-зсув).
 *  @param {number} nowMs */
export function quotaPeriod(nowMs) {
  return kyivDateKey(new Date(nowMs)).slice(0, 7);
}

/**
 * Інкремент лічильника. Повертає {value, limit, crossed80, crossed100};
 * при перетині порогу шле алерт у TOPIC_SYSTEM через outbox (drain -
 * best-effort, добере sweeper). Збій алерту не валить облік.
 * @param {Env} env
 * @param {{ key: string, amount: number, limit: number, nowMs?: number }} input
 */
export async function bumpQuota(env, input) {
  if (!env.DB) throw new Error('привʼязки DB немає - quota_counters недоступні');
  if (!(input.amount > 0)) throw new Error('amount має бути додатним');
  if (!(input.limit > 0)) throw new Error('limit має бути додатним');
  const nowMs = input.nowMs ?? Date.now();
  const period = quotaPeriod(nowMs);
  const iso = new Date(nowMs).toISOString();

  // RETURNING, а не окремий SELECT: інакше конкурентний bump між INSERT і
  // читанням давав би обом викликам «пізнє» value, і перетин 80 % міг не
  // зафіксуватись ЖОДНИМ із них (before рахується від власного amount).
  const { results } = await env.DB.prepare(
    `INSERT INTO quota_counters (key, period, value, limit_value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key, period) DO UPDATE SET
       value = quota_counters.value + excluded.value,
       limit_value = excluded.limit_value,
       updated_at = excluded.updated_at
     RETURNING value`,
  )
    .bind(input.key, period, input.amount, input.limit, iso)
    .all();
  const value = Number(/** @type {{ value?: number } | undefined} */ (results?.[0])?.value ?? 0);
  const before = value - input.amount;
  const crossed80 = before < input.limit * 0.8 && value >= input.limit * 0.8;
  const crossed100 = before < input.limit && value >= input.limit;

  if (crossed80 || crossed100) {
    const pct = crossed100 ? '100 %' : '80 %';
    await sendQuotaAlert(
      env,
      `⚠️ Квота ${input.key} (${period}): ${pct} - ${value} із ${input.limit}`,
      nowMs,
    );
  }
  return { value, limit: input.limit, crossed80, crossed100 };
}

/**
 * Лічильники поточного періоду - для /api/assistant-status і звітів.
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function readQuotas(env, nowMs = Date.now()) {
  if (!env.DB) throw new Error('привʼязки DB немає - quota_counters недоступні');
  const { results } = await env.DB.prepare(
    'SELECT key, value, limit_value, updated_at FROM quota_counters WHERE period = ? ORDER BY key',
  )
    .bind(quotaPeriod(nowMs))
    .all();
  return results ?? [];
}

/**
 * @param {Env} env
 * @param {string} text
 * @param {number} nowMs
 */
async function sendQuotaAlert(env, text, nowMs) {
  // Спільний алерт (outbox.sendSystemAlert): збій черги не кидає - алерт не
  // привід втратити сам облік виклику API.
  await sendSystemAlert(env, text, nowMs);
}
