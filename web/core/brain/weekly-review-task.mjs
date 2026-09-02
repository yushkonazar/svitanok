// Задача планувальника `weekly-review` (07 §7, S-9-1/S-9-4): неділя 09:00
// Києва - старт прогону профілю weekly-review у тему «Асистент» тим самим
// шляхом, що й повідомлення власника (черга треду, статусник, ретраї при
// недоступному мозку). Поява щопʼять хвилин, ефект раз на тиждень: стан
// тижня лежить у KV (дата неділі, спроби, id прогонів).
//
// S-9-4: успіх - це ДОСТАВЛЕНИЙ звіт, тобто рядок у reports за сьогодні
// (deliver кладе його сам), а не доля конкретного прогону: звіт, що став у
// чергу треду за розмовою власника, стартує пізніше зі своїм id, і судити
// про нього за runs ми не можемо. Прогін упав і звіту немає - о 12:00 один
// повтор з алертом у TOPIC_SYSTEM; впав і повтор - о 13:00+ алерт «не
// вдався двічі», більше спроб немає.

import { kyivHour, kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import { startOrQueueThreadText, THREAD_DM } from '../prerouter.mjs';

export const WEEKLY_REVIEW_STATE_KEY = 'weeklyReviewState';
export const WEEKLY_REVIEW_HOUR = 9;
export const WEEKLY_REVIEW_RETRY_HOUR = 12;
/** Скільки спроб на тиждень: перша о 09:00 і один повтор о 12:00. */
export const WEEKLY_REVIEW_MAX_ATTEMPTS = 2;

/**
 * @typedef {{ date: string, attempts: number, runIds: string[], alerted: boolean }} WeeklyState
 */

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function weeklyReviewTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const today = kyivDateKey(now);
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 0) return { skipped: 'not-sunday' };
  const hour = kyivHour(now);
  if (hour < WEEKLY_REVIEW_HOUR) return { skipped: 'hour' };

  const state = await readState(env, today);
  if (state.attempts === 0) return start(env, state, nowMs);

  // Київська північ сьогодні в ISO: звіт, доставлений сьогодні, і є успіх.
  const dayStartIso = new Date(nowMs - kyivMinuteOfDay(now) * 60_000).toISOString();

  if (state.attempts === 1) {
    if (hour < WEEKLY_REVIEW_RETRY_HOUR) return { skipped: 'wait-first' };
    if (await reportExistsSince(env, dayStartIso)) return { skipped: 'ok' };
    const verdict = await runVerdict(env, /** @type {string} */ (state.runIds[0]));
    if (verdict === 'running') return { skipped: 'running' };
    await sendSystemAlert(
      env,
      `weekly-review о 09:00 не дав звіту (${verdict}) - повторюю о 12:00.`,
      nowMs,
    );
    return start(env, state, nowMs);
  }

  // Обидві спроби зроблено: лишилось перевірити другу і сказати вголос.
  if (state.alerted) return { skipped: 'done' };
  if (hour <= WEEKLY_REVIEW_RETRY_HOUR) return { skipped: 'wait-retry' };
  const delivered = await reportExistsSince(env, dayStartIso);
  if (!delivered) {
    const verdict = await runVerdict(env, /** @type {string} */ (state.runIds[1]));
    if (verdict === 'running') return { skipped: 'running' };
    await sendSystemAlert(
      env,
      `Тижневий звіт не вдався двічі (${verdict}) - цього тижня без нього.`,
      nowMs,
    );
  }
  await writeState(env, { ...state, alerted: true });
  return { alerted: !delivered };
}

/**
 * @param {Env} env
 * @param {WeeklyState} state
 * @param {number} nowMs
 */
async function start(env, state, nowMs) {
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('weekly-review: TELEGRAM_CHAT_ID відсутній - нікуди слати звіт');
    return { skipped: 'no-chat' };
  }
  const chatId = Number(env.TELEGRAM_CHAT_ID);
  const threadId = env.TOPIC_ASSISTANT ? Number(env.TOPIC_ASSISTANT) : null;
  const threadKey = threadId == null ? THREAD_DM : String(threadId);
  const runId = await startOrQueueThreadText(
    env,
    { chatId, threadId },
    threadKey,
    'звіт зараз',
    'weekly-review',
    nowMs,
  );
  // runId null = запит став у чергу треду (власник саме розмовляє) і стартує
  // після поточного прогону зі своїм id. Спробу рахуємо: успіх о 12:00
  // читається з reports, а не з runs, тож черга - не збій.
  await writeState(env, {
    ...state,
    attempts: state.attempts + 1,
    runIds: [...state.runIds, runId ?? 'queued'],
  });
  return { started: runId != null, queued: runId == null };
}

/**
 * Чи є сьогоднішній звіт у reports (deliver профілю weekly-review пише його).
 * @param {Env} env
 * @param {string} sinceIso
 */
async function reportExistsSince(env, sinceIso) {
  if (!env.DB) return false;
  const row = await env.DB.prepare(
    `SELECT id FROM reports WHERE kind = 'weekly' AND created_at >= ? LIMIT 1`,
  )
    .bind(sinceIso)
    .first();
  return row != null;
}

/**
 * Доля прогону за runs (D1) - для тексту алерту: running / ok / причина.
 * @param {Env} env
 * @param {string} runId
 * @returns {Promise<'ok' | 'running' | string>}
 */
async function runVerdict(env, runId) {
  if (runId === 'queued') return 'запит стояв у черзі треду, звіту немає';
  if (!env.DB) return 'DB недоступна';
  const row = /** @type {any} */ (
    await env.DB.prepare('SELECT finished_at, error FROM runs WHERE id = ?').bind(runId).first()
  );
  if (!row) return 'прогін не зареєстровано';
  if (row.error) return String(row.error);
  if (!row.finished_at) return 'running';
  return 'завершився без звіту';
}

/**
 * @param {Env} env
 * @param {string} today
 * @returns {Promise<WeeklyState>}
 */
async function readState(env, today) {
  const fresh = { date: today, attempts: 0, runIds: [], alerted: false };
  try {
    const raw = await env.BRIEFING.get(WEEKLY_REVIEW_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || parsed.date !== today) return fresh;
    return {
      date: today,
      attempts: Number(parsed.attempts) || 0,
      runIds: Array.isArray(parsed.runIds) ? parsed.runIds.map(String) : [],
      alerted: Boolean(parsed.alerted),
    };
  } catch {
    return fresh;
  }
}

/** @param {Env} env @param {WeeklyState} state */
async function writeState(env, state) {
  await env.BRIEFING.put(WEEKLY_REVIEW_STATE_KEY, JSON.stringify(state));
}
