// Вимірювані SLO критичної доставки. Це не «кількість спроб»: нагадування
// вважається порушеним, коли його due_at минув понад допустиме вікно і воно
// досі pending/snoozed; ранковий briefing - коли після дедлайну немає
// підтвердженого lastSentDate за сьогодні.

import { loadState } from '../../kv-store.mjs';
import { kyivDateKey, kyivHour } from '../../kyiv-time.mjs';

/** Нагадування має бути взяте scheduler-ом і передане в outbox за один tick. */
export const REMINDER_DELIVERY_SLO_MS = 5 * 60_000;
/** До цієї київської години ранковий briefing має бути підтверджено доставленим. */
export const BRIEFING_DELIVERY_DEADLINE_HOUR = 11;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає — delivery SLO недоступний');
  return env.DB;
}

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function readDeliverySlo(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const [reminders, state] = await Promise.all([readReminderSlo(env, nowMs), loadState(env)]);
  const today = kyivDateKey(now);
  const hour = kyivHour(now);
  const sentToday = state.lastSentDate === today;
  const briefing = {
    target: { deadline_hour_kyiv: BRIEFING_DELIVERY_DEADLINE_HOUR },
    date: today,
    last_sent_date: typeof state.lastSentDate === 'string' ? state.lastSentDate : null,
    status: sentToday
      ? 'ok'
      : hour < BRIEFING_DELIVERY_DEADLINE_HOUR
        ? 'pending_window'
        : 'breached',
  };
  return { reminders, briefing };
}

/** @param {Env} env @param {number} nowMs */
async function readReminderSlo(env, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const breachIso = new Date(nowMs - REMINDER_DELIVERY_SLO_MS).toISOString();
  const row = /** @type {{ due: number, breached: number, oldest_due_at: string|null } | null} */ (
    await db(env)
      .prepare(
        `SELECT COUNT(*) AS due,
                  SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS breached,
                  MIN(due_at) AS oldest_due_at
           FROM reminders
           WHERE status IN ('pending', 'snoozed') AND due_at <= ?`,
      )
      .bind(breachIso, nowIso)
      .first()
  );
  const due = Number(row?.due ?? 0);
  const breached = Number(row?.breached ?? 0);
  return {
    target: { max_lateness_ms: REMINDER_DELIVERY_SLO_MS },
    due,
    breached,
    oldest_due_at: typeof row?.oldest_due_at === 'string' ? row.oldest_due_at : null,
    status: breached > 0 ? 'breached' : due > 0 ? 'within_grace' : 'ok',
  };
}
