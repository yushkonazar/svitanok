// Bounded, deterministic check-in aggregates for the assistant. Missing slots
// remain missing; no guessed sleep duration or LLM arithmetic enters totals.
import { addDaysToDateKey } from '../../reminders-core.mjs';

/** @param {unknown[]} values */
function mean(values) {
  const finite = /** @type {number[]} */ (
    values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  );
  if (!finite.length) return { n: 0, average: null };
  return {
    n: finite.length,
    average: Math.round((finite.reduce((sum, value) => sum + value, 0) / finite.length) * 10) / 10,
  };
}

/** @param {unknown} value */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {Record<string, any>} checkins @param {string} from @param {string} to @param {number} days */
function window(checkins, from, to, days) {
  /** @type {number[]} */
  const sleep = [];
  /** @type {number[]} */
  const dayScores = [];
  /** @type {number[]} */
  const energy = [];
  /** @type {[number, number][]} */
  const pairs = [];
  let recordedDays = 0;
  let sleeplessNights = 0;
  let napsWithoutDuration = 0;
  for (const [date, record] of Object.entries(checkins ?? {})) {
    if (date < from || date > to || !record || typeof record !== 'object') continue;
    recordedDays += 1;
    const morning = record.morning ?? {};
    const evening = record.evening ?? {};
    const sleepHours = morning.sleepKind === 'none' ? 0 : numberOrNull(morning.sleepH);
    if (morning.sleepKind === 'none') sleeplessNights += 1;
    if (morning.sleepKind === 'naps' && sleepHours == null) napsWithoutDuration += 1;
    const dayScore = numberOrNull(evening.dayScore);
    if (sleepHours != null) sleep.push(sleepHours);
    if (dayScore != null) dayScores.push(dayScore);
    if (sleepHours != null && dayScore != null) pairs.push([sleepHours, dayScore]);
    for (const slot of ['morning', 'afternoon', 'evening']) {
      const value = numberOrNull(record[slot]?.energy);
      if (value != null) energy.push(value);
    }
  }
  return {
    from,
    to,
    days,
    recordedDays,
    missingDays: Math.max(0, days - recordedDays),
    sleeplessNights,
    napsWithoutDuration,
    sleepHours: mean(sleep),
    dayScore: mean(dayScores),
    energy: mean(energy),
    pairedSleepAndDayScore: pairs.length,
    sleepDayCorrelation: pairs.length >= 14 ? pearson(pairs) : null,
  };
}

/** @param {[number, number][]} pairs */
function pearson(pairs) {
  const n = pairs.length;
  const sx = pairs.reduce((sum, pair) => sum + pair[0], 0);
  const sy = pairs.reduce((sum, pair) => sum + pair[1], 0);
  const mx = sx / n;
  const my = sy / n;
  const covariance = pairs.reduce((sum, pair) => sum + (pair[0] - mx) * (pair[1] - my), 0);
  const xx = pairs.reduce((sum, pair) => sum + (pair[0] - mx) ** 2, 0);
  const yy = pairs.reduce((sum, pair) => sum + (pair[1] - my) ** 2, 0);
  return xx > 0 && yy > 0 ? Math.round((covariance / Math.sqrt(xx * yy)) * 100) / 100 : null;
}

/**
 * @param {Record<string, any>} checkins
 * @param {string} todayKey
 * @param {number} days
 */
export function buildCheckinPeriod(checkins, todayKey, days) {
  const duration = Math.max(1, Math.min(366, Math.trunc(days)));
  const from = addDaysToDateKey(todayKey, -(duration - 1));
  const prevTo = addDaysToDateKey(from, -1);
  const prevFrom = addDaysToDateKey(prevTo, -(duration - 1));
  return {
    scope: 'checkin',
    current: window(checkins, from, todayKey, duration),
    previous: window(checkins, prevFrom, prevTo, duration),
    retentionDays: 365,
    sourceCoverage:
      duration * 2 > 365 ? 'previous_period_may_be_incomplete' : 'within_retention_window',
    rule: 'Missing values are excluded; explicit no sleep is 0 hours; naps without a duration are unknown. Correlation is reported only with at least 14 pairs and never implies causation.',
  };
}
