// One overview on Monday 08:00 Kyiv, for the completed previous week.
// A quiet retry at noon is conditional on recovered core evidence, not partiality.
import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import { startOrQueueThreadText, THREAD_DM } from '../prerouter.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import { completedWeekPeriod } from '../report-period.mjs';
import { kyivInstant } from '../finance/planning.mjs';
import { runDataRead } from '../tools/read.mjs';
import { weeklyPacketQuality } from './weekly-report-quality.mjs';
import { latestWeeklyReport } from './weekly-review.mjs';
import { weeklyClaim, weeklyComplete, weeklyRelease } from '../weekly-review-state/client.mjs';
import {
  WEEKLY_REVIEW_LEASE_MS,
  WEEKLY_REVIEW_STATE_KEY,
} from '../weekly-review-state/contract.mjs';

export { WEEKLY_REVIEW_STATE_KEY };
export const WEEKLY_REVIEW_HOUR = 8;
export const WEEKLY_REVIEW_RETRY_HOUR = 12;
export const WEEKLY_REVIEW_RETRY_END_HOUR = 13;
export const WEEKLY_REVIEW_MAX_ATTEMPTS = 2;
/** @typedef {{date:string,attempts:number,runIds:string[],alerted:boolean}} WeeklyState */

/** @param {Env} env @param {number} [nowMs] */
export async function weeklyReviewTask(env, nowMs = Date.now()) {
  const today = kyivDateKey(new Date(nowMs));
  if (new Date(`${today}T12:00:00Z`).getUTCDay() !== 1) return { skipped: 'not-monday' };
  const hour = kyivHour(new Date(nowMs));
  if (hour < WEEKLY_REVIEW_HOUR) return { skipped: 'hour' };
  const period = completedWeekPeriod(nowMs);
  const dayStart = new Date(kyivInstant(today, 0)).toISOString();
  const runs = await weeklyRunsSince(env, dayStart, nowMs);
  const claim = await weeklyClaim(
    env,
    await readState(env, period.dateFrom),
    nowMs,
    WEEKLY_REVIEW_LEASE_MS,
  );
  if (!claim.ok) return { skipped: claim.reason ?? 'busy' };
  const original = normalizeState(claim.state, period.dateFrom);
  const state =
    runs.length > original.attempts || (original.runIds.includes('queued') && runs.length > 0)
      ? {
          ...original,
          attempts: Math.max(original.attempts, Math.min(runs.length, WEEKLY_REVIEW_MAX_ATTEMPTS)),
          runIds:
            original.runIds.length > runs.length
              ? original.runIds.map((id, i) => runs[i]?.id ?? id)
              : runs.map((r) => r.id),
        }
      : original;
  let completed = false;
  /** @param {WeeklyState} next */
  const writeState = async (next) => {
    if (!(await weeklyComplete(env, claim.token, next)))
      throw new Error('weekly-review lease втрачено');
    completed = true;
  };
  const finish = async (/** @type {string} */ reason) => {
    await writeState({ ...state, alerted: true });
    return { skipped: reason };
  };
  try {
    if (JSON.stringify(state) !== JSON.stringify(original)) {
      await writeState(state);
      return { skipped: 'state-reconciled' };
    }
    if (state.alerted) return { skipped: 'done' };
    const report = await latestWeeklyReport(env, period.dateFrom, period.dateTo);
    if (report?.status === 'ready') return await finish('ok');
    if (!state.attempts) {
      if (report) return await finish('period-already-reviewed');
      if (hour !== WEEKLY_REVIEW_HOUR) return { skipped: 'outside-window' };
      return await start(env, state, nowMs, writeState);
    }
    const verdict = await runVerdict(env, state.runIds.at(-1));
    if (verdict === 'running') return { skipped: 'running' };
    if (verdict === 'queued') return { skipped: 'queued' };
    const quality = parseQuality(report?.quality_json);
    if (report?.status === 'partial' && !quality.retryable?.length)
      return await finish('non-retryable-gaps');
    if (state.attempts >= WEEKLY_REVIEW_MAX_ATTEMPTS) {
      if (!report && hour >= WEEKLY_REVIEW_RETRY_END_HOUR)
        await sendSystemAlert(
          env,
          'Тижневий огляд не надійшов. Потрібна перевірка роботи звітів; твої дані збережені.',
          nowMs,
        );
      if (hour < WEEKLY_REVIEW_RETRY_END_HOUR && !report) return { skipped: 'wait-retry' };
      return await finish('done');
    }
    if (await isPermanentModelAccessFailure(env, state.runIds[0])) {
      if (!report)
        await sendSystemAlert(
          env,
          'Тижневий огляд не сформовано: немає доступу до генерації. Потрібна перевірка доступу.',
          nowMs,
        );
      return await finish('model-access-disabled');
    }
    if (!report && !/timeout|unavailable|network|fetch|temporar|http.?5\d\d/iu.test(verdict))
      return await finish('non-retryable-failure');
    if (
      report?.status === 'failed' &&
      !quality.retryable?.length &&
      !/timeout|unavailable|network|fetch|temporar|http.?5\d\d/iu.test(verdict)
    )
      return await finish('non-retryable-failure');
    if (hour < WEEKLY_REVIEW_RETRY_HOUR) return { skipped: 'wait-first' };
    if (hour >= WEEKLY_REVIEW_RETRY_END_HOUR) return await finish('retry-window-missed');
    if (report?.status === 'partial') {
      try {
        const fresh = weeklyPacketQuality(
          JSON.parse((await runDataRead(env, { scope: 'weekly' }, nowMs)).result),
        );
        if (!quality.retryable.some((/** @type {string} */ code) => !fresh.missing.includes(code)))
          return await finish('sources-not-recovered');
      } catch {
        return await finish('sources-not-recovered');
      }
    }
    return await start(env, state, nowMs, writeState);
  } finally {
    if (!completed && claim.canonical) await weeklyRelease(env, claim.token);
  }
}

/** @param {Env} env @param {WeeklyState} state @param {number} nowMs
 * @param {(state:WeeklyState)=>Promise<void>} writeState */
async function start(env, state, nowMs, writeState) {
  const target = assistantHomeTarget(env);
  if (!target) return { skipped: 'no-chat' };
  const runId = await startOrQueueThreadText(
    env,
    { chatId: target.chatId, threadId: target.threadId },
    target.threadId == null ? THREAD_DM : String(target.threadId),
    'звіт зараз',
    'weekly-review',
    nowMs,
  );
  await writeState({
    ...state,
    attempts: state.attempts + 1,
    runIds: [...state.runIds, runId ?? 'queued'],
  });
  return { started: runId != null, queued: runId == null };
}
/** @param {unknown} value */
function parseQuality(value) {
  try {
    return JSON.parse(String(value ?? '{}'));
  } catch {
    return {};
  }
}
/** @param {Env} env @param {string|undefined} runId */
async function runVerdict(env, runId) {
  if (!runId || runId === 'queued') return 'queued';
  if (!env.DB) return 'storage-unavailable';
  const row = await env.DB.prepare('SELECT finished_at,error FROM runs WHERE id=?')
    .bind(runId)
    .first();
  if (row?.error) {
    const step = await env.DB.prepare(
      "SELECT note FROM run_steps WHERE run_id=? AND kind='error' ORDER BY n DESC LIMIT 1",
    )
      .bind(runId)
      .first()
      .catch(() => null);
    if (/timeout|timed.out|таймаут|abort/iu.test(String(step?.note ?? ''))) return 'timeout';
    if (/network|fetch failed|temporar|http.?5\d\d/iu.test(String(step?.note ?? '')))
      return 'network-unavailable';
  }
  return row?.error
    ? String(row.error)
    : row && !row.finished_at
      ? 'running'
      : 'finished-without-report';
}
/** @param {Env} env @param {string} since @param {number} nowMs */
async function weeklyRunsSince(env, since, nowMs) {
  if (!env.DB) return [];
  try {
    const result = await env.DB.prepare(
      `SELECT id FROM runs WHERE profile='weekly-review'
      AND started_at>=? AND started_at<=? ORDER BY started_at ASC LIMIT ?`,
    )
      .bind(since, new Date(nowMs).toISOString(), WEEKLY_REVIEW_MAX_ATTEMPTS)
      .all();
    return (result.results ?? []).map((row) => ({ id: String(row.id) }));
  } catch {
    return [];
  }
}
/** @param {Env} env @param {string|undefined} runId */
async function isPermanentModelAccessFailure(env, runId) {
  if (!env.DB || !runId || runId === 'queued') return false;
  const row = await env.DB.prepare(
    `SELECT note FROM run_steps WHERE run_id=? AND kind='error' ORDER BY n DESC LIMIT 1`,
  )
    .bind(runId)
    .first()
    .catch(() => null);
  return /disabled\s+claude\s+subscription\s+access|use\s+an\s+anthropic\s+api\s+key/iu.test(
    String(row?.note ?? ''),
  );
}
/** @param {Env} env @param {string} week */
async function readState(env, week) {
  try {
    return normalizeState(
      JSON.parse((await env.BRIEFING.get(WEEKLY_REVIEW_STATE_KEY)) ?? 'null'),
      week,
    );
  } catch {
    return normalizeState(null, week);
  }
}
/** @param {any} raw @param {string} week @returns {WeeklyState} */
function normalizeState(raw, week) {
  return !raw || raw.date !== week
    ? { date: week, attempts: 0, runIds: [], alerted: false }
    : {
        date: week,
        attempts: Number(raw.attempts) || 0,
        runIds: Array.isArray(raw.runIds) ? raw.runIds.map(String) : [],
        alerted: Boolean(raw.alerted),
      };
}
