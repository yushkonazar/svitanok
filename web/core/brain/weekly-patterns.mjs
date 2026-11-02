import { adaptiveDay } from '../checkin/adaptive-observations.mjs';

const finite = (/** @type {unknown} */ value) =>
  typeof value === 'number' && Number.isFinite(value);
const mean = (/** @type {number[]} */ values) =>
  values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
/** Aggregate confirmed, same-version answers; no raw answers or dates leave this function.
 * @param {Record<string,any>} records */
export function weeklyPersonalPatterns(records) {
  const days = Object.entries(records).map(([date, record]) => adaptiveDay(date, record));
  const pairs = days.filter((d) => finite(d.morning.energy) && finite(d.evening.energy));
  /** @type {('morning'|'afternoon'|'evening')[]} */ const slots = [
    'morning',
    'afternoon',
    'evening',
  ];
  const low = days.filter((d) =>
    slots.some((slot) => finite(d[slot].energy) && d[slot].energy <= 2),
  );
  /** Count days explicitly mentioning each reason, not missing reasons as negative answers.
   * @param {any[]} selected @param {string} field @param {string[]} slots @param {(answer:any)=>boolean} [accept] */
  const reasons = (selected, field, slots, accept = () => true) => {
    /** @type {Record<string,number>} */ const counts = {};
    let answeredDays = 0;
    for (const day of selected) {
      const codes = new Set(
        slots.flatMap((slot) => {
          const answer = day[slot];
          const value = accept(answer) ? answer[field] : null;
          return Array.isArray(value)
            ? value.filter((v) => typeof v === 'string' && /^[a-z_]{1,40}$/.test(v))
            : [];
        }),
      );
      if (codes.size) answeredDays++;
      for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
    }
    return { answeredDays, counts };
  };
  const sleep = days.filter((d) => d.sleepHours != null);
  const recovery = days.filter((d) => finite(d.evening.recoveryEffectV3));
  return {
    energy: {
      pairs: pairs.length,
      lowerDays: pairs.filter((d) => d.evening.energy < d.morning.energy).length,
      higherDays: pairs.filter((d) => d.evening.energy > d.morning.energy).length,
      sameDays: pairs.filter((d) => d.evening.energy === d.morning.energy).length,
      morningAverage: mean(pairs.map((d) => d.morning.energy)),
      eveningAverage: mean(pairs.map((d) => d.evening.energy)),
      lowDays: low.length,
      factors: reasons(
        low,
        'energyFactorsV3',
        ['morning', 'afternoon', 'evening'],
        (a) => finite(a.energy) && a.energy <= 2,
      ),
    },
    sleep: {
      days: sleep.length,
      averageHours: mean(sleep.map((d) => Number(d.sleepHours))),
      poorDays: days.filter((d) => [1, 2].includes(d.morning.sleepQualityV3)).length,
      blockers: reasons(days, 'sleepBlockersV3', ['morning']),
    },
    recovery: {
      days: recovery.length,
      helpedDays: recovery.filter((d) => d.evening.recoveryEffectV3 >= 4).length,
      limitedDays: recovery.filter((d) => d.evening.recoveryEffectV3 <= 2).length,
      blockers: reasons(
        recovery,
        'recoveryBlockersV3',
        ['evening'],
        (a) => a.recoveryEffectV3 <= 2,
      ),
      helpers: reasons(recovery, 'recoveryHelpersV3', ['evening'], (a) => a.recoveryEffectV3 >= 4),
    },
  };
}

/** Whitelisted finite projection, also safe when re-projecting a stored report.
 * @param {any} input */
export function summarizeWeeklyPatterns(input) {
  if (!input || typeof input !== 'object') return null;
  const pick = (/** @type {any} */ row, /** @type {string[]} */ fields) =>
    Object.fromEntries(
      fields
        .filter((key) => row?.[key] === null || finite(row?.[key]))
        .map((key) => [key, row[key]]),
    );
  const reason = (/** @type {any} */ value) => ({
    ...pick(value, ['answeredDays']),
    counts: Object.fromEntries(
      Object.entries(value?.counts ?? {})
        .filter(([key, n]) => /^[a-z_]{1,40}$/.test(key) && finite(n) && Number(n) > 0)
        .slice(0, 20),
    ),
  });
  return {
    energy: {
      ...pick(input.energy, [
        'pairs',
        'lowerDays',
        'higherDays',
        'sameDays',
        'morningAverage',
        'eveningAverage',
        'lowDays',
      ]),
      factors: reason(input.energy?.factors),
    },
    sleep: {
      ...pick(input.sleep, ['days', 'averageHours', 'poorDays']),
      blockers: reason(input.sleep?.blockers),
    },
    recovery: {
      ...pick(input.recovery, ['days', 'helpedDays', 'limitedDays']),
      blockers: reason(input.recovery?.blockers),
      helpers: reason(input.recovery?.helpers),
    },
  };
}
