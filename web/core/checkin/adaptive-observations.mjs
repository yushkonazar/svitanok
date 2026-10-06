import { CHECKIN_CARDS_V3, FOLLOWUP_CARDS_V3 } from './adaptive.mjs';
import { observedMean, shiftCheckinDate } from './observations.mjs';
/** @param {unknown} v */
const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {KvBlob} record @param {string} slot */
const confirmed = (record, slot) =>
  record?.[slot]?.confirmed === true && record[slot].questionVersion === 3 ? record[slot] : {};
/** @param {string} date @param {KvBlob} raw @returns {KvBlob} */
export function adaptiveDay(date, raw) {
  const morning = confirmed(raw, 'morning'),
    afternoon = confirmed(raw, 'afternoon'),
    evening = confirmed(raw, 'evening');
  return {
    date,
    morning,
    afternoon,
    evening,
    sleepHours:
      morning.sleepModeV3 === 'none'
        ? 0
        : numeric(morning.sleepMinutesV3) == null
          ? null
          : morning.sleepMinutesV3 / 60,
    sleepQuality: numeric(morning.sleepQualityV3),
    satisfaction: numeric(evening.satisfactionV3),
  };
}
/** @param {KvBlob[]} days @param {string} slot @param {string} key */
export function frequenciesV3(days, slot, key) {
  /** @type {Record<string,number>} */ const counts = {};
  let n = 0;
  for (const d of days) {
    const value = d[slot][key];
    if (value == null || (Array.isArray(value) && !value.length)) continue;
    n++;
    for (const x of Array.isArray(value) ? value : [value])
      counts[String(x)] = (counts[String(x)] ?? 0) + 1;
  }
  return { n, counts };
}
/** @param {KvBlob[]} days @param {string} slot @param {string} key */
export function pointsV3(days, slot, key) {
  return days.flatMap((d) => {
    const value = numeric(d[slot][key]);
    return value == null ? [] : [{ date: d.date, value }];
  });
}
/** @param {KvBlob} records @param {string} to @param {number} [days] */
export function analyzeAdaptive(records, to, days = 7) {
  const length = Math.max(1, Math.min(90, Math.trunc(days)));
  const from = shiftCheckinDate(to, 1 - length),
    previousTo = shiftCheckinDate(from, -1);
  const collect = (/** @type {string} */ end) =>
    Array.from({ length }, (_, i) => {
      const date = shiftCheckinDate(end, i + 1 - length);
      return adaptiveDay(date, records?.[date]);
    });
  const current = collect(to),
    previous = collect(previousTo);
  /** @type {Record<string,{energy:{n:number,value:number|null},mood:{n:number,value:number|null}}>} */ const state =
    {};
  for (const slot of ['morning', 'afternoon', 'evening'])
    state[slot] = {
      energy: observedMean(current.map((d) => numeric(d[slot].energy))),
      mood: observedMean(current.map((d) => numeric(d[slot].mood))),
    };
  const recordedDays = current.filter((d) =>
    ['morning', 'afternoon', 'evening'].some((slot) => d[slot].confirmed),
  ).length;
  const pairs = current.filter(
    (d) => numeric(d.morning.energy) != null && numeric(d.evening.energy) != null,
  );
  const learning = current.filter((d) =>
    ['learn', 'both'].includes(d.evening.developmentActualV3),
  ).length;
  const reading = current.filter((d) =>
    ['read', 'both'].includes(d.evening.developmentActualV3),
  ).length;
  const planned = current.filter((d) =>
    ['learn', 'read', 'both'].includes(d.morning.developmentPlanV3),
  );
  const followThrough = planned.filter((d) => d.evening.developmentActualV3 != null);
  const met = followThrough.filter(
    (d) =>
      d.evening.developmentActualV3 === 'both' ||
      d.evening.developmentActualV3 === d.morning.developmentPlanV3,
  ).length;
  return {
    from,
    to,
    days: length,
    current,
    previous,
    recordedDays,
    state,
    sleep: observedMean(current.map((d) => d.sleepHours)),
    sleepQuality: observedMean(current.map((d) => d.sleepQuality)),
    satisfaction: observedMean(current.map((d) => d.satisfaction)),
    priorSleep: observedMean(previous.map((d) => d.sleepHours)),
    priorSatisfaction: observedMean(previous.map((d) => d.satisfaction)),
    confirmedSlots: current.reduce(
      (n, d) => n + ['morning', 'afternoon', 'evening'].filter((slot) => d[slot].confirmed).length,
      0,
    ),
    lowerEnergy: pairs.filter((d) => d.evening.energy < d.morning.energy).length,
    energyPairs: pairs.length,
    learning,
    reading,
    developmentAnswers: current.filter((d) => d.evening.developmentActualV3 != null).length,
    planned: planned.length,
    followThrough: followThrough.length,
    met,
    poorSleep: current.filter((d) => [1, 2].includes(d.morning.sleepQualityV3)).length,
    goodSleep: current.filter((d) => [4, 5].includes(d.morning.sleepQualityV3)).length,
  };
}
/** Bounded sums and categorical counts for assistant/archive consumers. @param {KvBlob[]} days */
export function adaptiveMetrics(days) {
  /** @type {KvBlob} */ const metrics = {};
  for (const slot of ['morning', 'afternoon', 'evening']) {
    const fields = new Map(
      [...(CHECKIN_CARDS_V3[slot] ?? []), ...FOLLOWUP_CARDS_V3]
        .flatMap((c) => c.fields)
        .map((f) => [f.id, f]),
    );
    for (const [id, f] of fields) {
      const values = days.map((d) => d[slot][id]).filter((v) => v != null);
      if (!values.length) continue;
      const numericValues = values.filter((v) => numeric(v) != null);
      metrics[`${slot}.${id}`] = {
        label: f.label,
        ...frequenciesV3(days, slot, id),
        ...(numericValues.length
          ? {
              average: observedMean(numericValues).value,
              sum: numericValues.reduce((n, v) => n + v, 0),
              numericN: numericValues.length,
            }
          : {}),
      };
    }
  }
  return metrics;
}
/** Demo-only observations; never used for private owner statistics. @param {string} to */
export function demoAdaptive(to) {
  /** @type {KvBlob} */ const records = {};
  for (let i = 0; i < 42; i++) {
    const date = shiftCheckinDate(to, i - 41),
      mood = 2 + (i % 4),
      energy = 2 + ((i * 3) % 4);
    const shared = { confirmed: true, questionVersion: 3, timezoneV3: 'Europe/Kyiv' };
    const slot = (/** @type {string} */ name, /** @type {number} */ hour) => ({
      ...shared,
      answeredAtV3: `${date}T${String(hour).padStart(2, '0')}:00:00+03:00`,
      confirmedAtV3: `${date}T${String(hour).padStart(2, '0')}:00:00+03:00`,
      activitiesV3: [
        name === 'morning' ? 'personal' : name === 'afternoon' ? 'work' : i % 2 ? 'rest' : 'learn',
      ],
      companyV3: [name === 'evening' ? 'partner' : 'alone'],
    });
    records[date] = {
      morning: {
        ...slot('morning', 10),
        energy,
        mood,
        sleepModeV3: 'main',
        sleepMinutesV3: 330 + (i % 5) * 35,
        sleepQualityV3: 2 + (i % 4),
        priorityV3: i % 3 ? 'work' : 'rest',
        developmentPlanV3: 'learn',
        bedtimeOutcomeV3: i % 3 ? 'later' : 'ontime',
        bedtimeReasonsV3: i % 3 ? ['work', 'phone'] : undefined,
        sleepBlockersV3: i % 4 === 0 ? ['time'] : undefined,
        sleepHelpersV3: i % 4 >= 2 ? ['calm'] : undefined,
      },
      afternoon:
        i % 7 === 0
          ? {}
          : {
              ...slot('afternoon', 18),
              energy: Math.max(1, energy - 1),
              mood: Math.max(1, mood - 1),
              priorityPaceV3: 'progress',
              moodFactorsV3: ['difficulty'],
            },
      evening:
        i % 6 === 0
          ? {}
          : {
              ...slot('evening', 23),
              energy: Math.max(1, energy - 1),
              mood: Math.min(5, mood + 1),
              satisfactionV3: 2 + (i % 4),
              priorityOutcomeV3: i % 3 ? 'finished' : 'changed',
              developmentActualV3: i % 2 ? 'none' : 'learn',
              freeTimeV3: i % 2 ? 'lt30' : '1_2h',
              learningRangeV3: i % 2 ? undefined : '30_60',
              comprehensionV3: i % 2 ? undefined : 3 + (i % 3),
              developmentBlockersV3: i % 2 ? ['late_work'] : undefined,
              bedtimePlanV3: '00:00',
              napV3: 'no',
              recoveryEffectV3: i % 2 ? 4 : undefined,
              workLoadV3: 3 + (i % 3),
              workBreaksV3: i % 2 ? 'no' : 'yes',
            },
    };
  }
  return records;
}
