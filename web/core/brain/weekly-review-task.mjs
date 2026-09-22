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
import { weeklyClaim, weeklyComplete, weeklyRelease } from '../weekly-review-state/client.mjs';
import {
  WEEKLY_REVIEW_LEASE_MS,
  WEEKLY_REVIEW_STATE_KEY,
} from '../weekly-review-state/contract.mjs';

export { WEEKLY_REVIEW_STATE_KEY };
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

  // Стан у DO є канонічним, але він не може бути єдиним запобіжником від
  // повторного зовнішнього ефекту. Якщо старий стан пошкоджено/втрачено під
  // час деплою, журнал runs вже знає про старт цього тижневого звіту. Без
  // такого звіряння кожен 5-хвилинний тік вважав би себе «першою» спробою і
  // знову викликав би модель. Відновлюємо лічильник з durable D1 перед будь-
  // яким новим стартом; максимум дві спроби лишається тим самим.
  const dayStartIso = new Date(nowMs - kyivMinuteOfDay(now) * 60_000).toISOString();
  const persistedRuns = await weeklyRunsSince(env, dayStartIso);

  const legacy = await readState(env, today);
  const claim = await weeklyClaim(env, legacy, nowMs, WEEKLY_REVIEW_LEASE_MS);
  if (!claim.ok) return { skipped: claim.reason ?? 'busy' };
  const state = reconcileState(normalizeState(claim.state, today), today, persistedRuns);
  let completed = false;
  /** @param {WeeklyState} next */
  const writeState = async (next) => {
    const ok = await weeklyComplete(env, claim.token, next);
    if (!ok) throw new Error('weekly-review lease втрачено під час commit');
    completed = true;
  };
  try {
    // Записати відновлений стан одразу. Це зупиняє цикл навіть коли наступний
    // крок нижче повернеться раннім `skipped`.
    if (!sameState(state, normalizeState(claim.state, today))) {
      await writeState(state);
      // `complete` навмисно відпускає lease. Не можна після цього в тому ж
      // тіку перейти до start() і вдруге комітити старим token: наступний
      // 5-хвилинний тік уже побачить відновлений стан і діятиме один раз.
      return { skipped: 'state-reconciled' };
    }
    if (state.attempts === 0) return start(env, state, nowMs, writeState);

    // Київська північ сьогодні в ISO: звіт, доставлений сьогодні, і є успіх.
    if (state.attempts === 1) {
      if (hour < WEEKLY_REVIEW_RETRY_HOUR) return { skipped: 'wait-first' };
      if (await reportExistsSince(env, dayStartIso)) return { skipped: 'ok' };
      const verdict = await runVerdict(env, /** @type {string} */ (state.runIds[0]));
      if (verdict === 'running') return { skipped: 'running' };
      if (await isPermanentModelAccessFailure(env, /** @type {string} */ (state.runIds[0]))) {
        await sendSystemAlert(
          env,
          'Тижневий звіт зупинено: доступ Claude Code вимкнено. Повторювати не буду, доки доступ не відновлять.',
          nowMs,
        );
        await writeState({ ...state, attempts: WEEKLY_REVIEW_MAX_ATTEMPTS, alerted: true });
        return { skipped: 'model-access-disabled' };
      }
      await sendSystemAlert(
        env,
        `weekly-review о 09:00 не дав звіту (${verdict}) - повторюю о 12:00.`,
        nowMs,
      );
      return start(env, state, nowMs, writeState);
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
    await writeState({ ...state, alerted: true });
    return { alerted: !delivered };
  } finally {
    if (!completed && claim.canonical) await weeklyRelease(env, claim.token);
  }
}

/**
 * @param {Env} env
 * @param {WeeklyState} state
 * @param {number} nowMs
 * @param {(state: WeeklyState) => Promise<void>} writeState
 */
async function start(env, state, nowMs, writeState) {
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
  await writeState({
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
 * Два незалежні джерела стану: DO захищає звичайний хід, а D1 переживає
 * втрату/міграцію DO. Беремо лише два перші старти дня — саме стільки дозволяє
 * контракт weekly-review; старі зайві рядки не можуть відкрити третю спробу.
 * @param {Env} env
 * @param {string} sinceIso
 * @returns {Promise<{ id: string }[]>}
 */
async function weeklyRunsSince(env, sinceIso) {
  if (!env.DB) return [];
  try {
    const result = await env.DB.prepare(
      `SELECT id FROM runs
       WHERE profile = 'weekly-review' AND started_at >= ?
       ORDER BY started_at ASC
       LIMIT ?`,
    )
      .bind(sinceIso, WEEKLY_REVIEW_MAX_ATTEMPTS)
      .all();
    return Array.isArray(result.results)
      ? result.results
          .filter((row) => row && typeof row.id === 'string')
          .map((row) => ({ id: /** @type {string} */ (row.id) }))
      : [];
  } catch (/** @type {any} */ error) {
    // D1 лишається додатковим safety net: збій журналу не має блокувати
    // штатний тижневий звіт, DO/KV усе ще тримає його звичайний стан.
    console.error('weekly-review: не вдалося звірити запуски дня', error?.message);
    return [];
  }
}

/** @param {WeeklyState} state @param {string} today @param {{ id: string }[]} runs */
function reconcileState(state, today, runs) {
  if (runs.length <= state.attempts) return state;
  return {
    date: today,
    attempts: Math.min(runs.length, WEEKLY_REVIEW_MAX_ATTEMPTS),
    runIds: runs.map((run) => run.id),
    alerted: state.alerted,
  };
}

/** @param {WeeklyState} left @param {WeeklyState} right */
function sameState(left, right) {
  return (
    left.date === right.date &&
    left.attempts === right.attempts &&
    left.alerted === right.alerted &&
    left.runIds.join('\u0000') === right.runIds.join('\u0000')
  );
}

/**
 * Це не тимчасовий збій моделі: Anthropic прямо вимкнув доступ організації.
 * Повтор через п'ять хвилин гарантовано дасть той самий результат, тому
 * weekly-review завершується після одного повідомлення замість другого запуску.
 * @param {Env} env
 * @param {string} runId
 */
async function isPermanentModelAccessFailure(env, runId) {
  if (!env.DB || !runId || runId === 'queued') return false;
  try {
    const row = await env.DB.prepare(
      `SELECT note FROM run_steps
       WHERE run_id = ? AND kind = 'error'
       ORDER BY n DESC
       LIMIT 1`,
    )
      .bind(runId)
      .first();
    const note = String(row?.note ?? '');
    return /disabled\s+claude\s+subscription\s+access|use\s+an\s+anthropic\s+api\s+key/i.test(note);
  } catch (/** @type {any} */ error) {
    console.error('weekly-review: не вдалося класифікувати помилку моделі', error?.message);
    return false;
  }
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
    return normalizeState(parsed, today);
  } catch {
    return fresh;
  }
}

/** @param {unknown} value @param {string} today @returns {WeeklyState} */
function normalizeState(value, today) {
  const fresh = { date: today, attempts: 0, runIds: [], alerted: false };
  const parsed = /** @type {any} */ (value);
  if (!parsed || parsed.date !== today) return fresh;
  return {
    date: today,
    attempts: Number(parsed.attempts) || 0,
    runIds: Array.isArray(parsed.runIds) ? parsed.runIds.map(String) : [],
    alerted: Boolean(parsed.alerted),
  };
}
