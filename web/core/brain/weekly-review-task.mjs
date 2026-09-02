// Задача планувальника `weekly-review` (07 §7, S-9-1/S-9-4): неділя 09:00
// Києва - старт прогону профілю weekly-review у тему «Асистент» тим самим
// шляхом, що й повідомлення власника (черга треду, статусник, ретраї при
// недоступному мозку). Поява щопʼять хвилин, ефект раз на тиждень: стан
// тижня лежить у KV (дата неділі, спроби, id прогонів).
//
// S-9-4: прогін упав (runs.error) - о 12:00 один повтор з алертом у
// TOPIC_SYSTEM; впав і повтор - о 13:00+ алерт «звіт не вдався», більше
// спроб немає. Успіх - це доставлений звіт (runs.error порожній).

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
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

  if (state.attempts === 0) {
    return start(env, state, nowMs);
  }
  if (state.attempts === 1) {
    if (hour < WEEKLY_REVIEW_RETRY_HOUR) return { skipped: 'wait-first' };
    const first = /** @type {string} */ (state.runIds[0]);
    const verdict = await runVerdict(env, first);
    if (verdict === 'ok' || verdict === 'running') return { skipped: verdict };
    await alert(env, `weekly-review о 09:00 не вдався (${verdict}) - повторюю о 12:00.`, nowMs);
    return start(env, state, nowMs);
  }
  // Обидві спроби зроблено: лишилось перевірити другу і сказати вголос.
  if (state.alerted) return { skipped: 'done' };
  if (hour <= WEEKLY_REVIEW_RETRY_HOUR) return { skipped: 'wait-retry' };
  const second = /** @type {string} */ (state.runIds[1]);
  const verdict = await runVerdict(env, second);
  if (verdict === 'running') return { skipped: 'running' };
  if (verdict !== 'ok') {
    await alert(env, `Тижневий звіт не вдався двічі (${verdict}) - цього тижня без нього.`, nowMs);
  }
  await writeState(env, { ...state, alerted: true });
  return { alerted: verdict !== 'ok' };
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
  // runId null = запит став у чергу треду (власник саме розмовляє); прогін
  // стартує після поточного - з тим самим профілем. Спробу все одно рахуємо:
  // вердикт о 12:00 прочитає runs за id, а без id (черга) - дасть повтор.
  await writeState(env, {
    ...state,
    attempts: state.attempts + 1,
    runIds: [...state.runIds, runId ?? 'queued'],
  });
  return { started: runId != null, queued: runId == null };
}

/**
 * Доля прогону за runs (D1): ok / running / текст помилки.
 * @param {Env} env
 * @param {string} runId
 * @returns {Promise<'ok' | 'running' | string>}
 */
async function runVerdict(env, runId) {
  if (runId === 'queued') return 'не стартував (черга треду)';
  if (!env.DB) return 'DB недоступна';
  const row = /** @type {any} */ (
    await env.DB.prepare('SELECT finished_at, error FROM runs WHERE id = ?').bind(runId).first()
  );
  if (!row) return 'прогін не зареєстровано';
  if (row.error) return String(row.error);
  if (!row.finished_at) return 'running';
  return 'ok';
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

/**
 * Алерт у TOPIC_SYSTEM (як у quota.mjs): збій черги не валить задачу.
 * @param {Env} env @param {string} text @param {number} nowMs
 */
async function alert(env, text, nowMs) {
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('weekly-review: алерт нікуди слати:', text);
    return;
  }
  try {
    await enqueueOutbox(
      env,
      {
        chatId: env.TELEGRAM_CHAT_ID,
        threadId: env.TOPIC_SYSTEM ?? null,
        kind: 'send',
        payload: { text },
      },
      nowMs,
    );
    await drainOutbox(env, { nowMs }).catch(() => {});
  } catch (/** @type {any} */ e) {
    console.error('weekly-review: алерт не покладено в чергу', e?.message);
  }
}
