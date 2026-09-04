// Задача `day-plan-kick` (07 §7, S-P-8/S-P-17): щодня о 00:05 Києва створити
// DayPlanChain на ЗАВТРА, якщо план дня увімкнено (facts.setting.day_plan),
// завтра - робочий день за weekdays і не день поїздки (trips). Ланцюг сам
// дочекається intent_at сьогодні ввечері, спитає «Що завтра?», а вранці
// завтра дасть план - тобто «створити на сьогодні» з 07 §7 читається як
// «на день, який планується сьогодні ввечері». Дедуп - workflow_id у
// day_plans на ту дату + добова мітка в KV.

import { kyivHour, kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { readDayPlanConfig, getDayPlan } from './store.mjs';
import { isoWeekday } from './slots.mjs';
import { startDayPlanChain } from './chain.mjs';

export const DAY_PLAN_KICK_MARKER_KEY = 'dayPlanKickDay';
export const DAY_PLAN_KICK_HOUR = 0;
export const DAY_PLAN_KICK_MINUTE = 5;

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function dayPlanKickTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== DAY_PLAN_KICK_HOUR || kyivMinuteOfDay(now) < DAY_PLAN_KICK_MINUTE) {
    return { skipped: 'hour' };
  }
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(DAY_PLAN_KICK_MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB) return { skipped: 'no-db' };

  const config = await readDayPlanConfig(env);
  if (!config.enabled) {
    await env.BRIEFING.put(DAY_PLAN_KICK_MARKER_KEY, today);
    return { skipped: 'disabled' };
  }
  const date = addDaysToDateKey(today, 1);
  if (!config.weekdays.has(isoWeekday(date))) {
    await env.BRIEFING.put(DAY_PLAN_KICK_MARKER_KEY, today);
    return { skipped: 'weekend', date };
  }
  if (await hasTrip(env, date)) {
    await env.BRIEFING.put(DAY_PLAN_KICK_MARKER_KEY, today);
    return { skipped: 'trip', date };
  }
  const existing = await getDayPlan(env, date);
  if (existing?.workflow_id) {
    await env.BRIEFING.put(DAY_PLAN_KICK_MARKER_KEY, today);
    return { skipped: 'exists', date };
  }
  const chainId = await startDayPlanChain(env, date, nowMs);
  // Мітка - після старту: збій create лишає день відкритим для наступного тіку
  // у вікні 00:05-00:59.
  await env.BRIEFING.put(DAY_PLAN_KICK_MARKER_KEY, today);
  return { started: true, date, chainId };
}

/** День поїздки (S-P-17): дата в межах trips.date_from..date_to, не скасована. @param {Env} env @param {string} date */
async function hasTrip(env, date) {
  const row = await /** @type {NonNullable<Env['DB']>} */ (env.DB)
    .prepare(
      `SELECT id FROM trips WHERE date_from <= ? AND COALESCE(date_to, date_from) >= ?
       AND (status IS NULL OR status NOT IN ('done', 'cancelled')) LIMIT 1`,
    )
    .bind(date, date)
    .first();
  return row != null;
}
