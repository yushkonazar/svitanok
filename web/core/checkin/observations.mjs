import { ACTIVITIES } from './catalog.mjs';
/** Transparent v2 observations. Only confirmed explicit answers; no scores or imputation. */
/** @typedef {{date:string,morning:KvBlob,afternoon:KvBlob,evening:KvBlob,sleepHours:number|null,sleepApprox:boolean,napMinutes:number|null,napOverlap:boolean,sleepQuality:number|null,satisfaction:number|null,learningMinutes:number|null}} ObservationDay */
/** @param {unknown} v */
const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {string} date @param {number} n */
export function shiftCheckinDate(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** @param {Array<number|null>} values */
export function observedMean(values) {
  const a = /** @type {number[]} */ (values.filter((v) => v != null));
  return { n: a.length, value: a.length ? a.reduce((sum, v) => sum + v, 0) / a.length : null };
}
/** @param {KvBlob} record @param {string} slot */
function confirmed(record, slot) {
  const s = record?.[slot];
  return s?.confirmed === true && s.questionVersion === 2 ? s : {};
}
/** @param {string} date @param {KvBlob} raw @returns {ObservationDay} */
export function observationDay(date, raw) {
  const m = confirmed(raw, 'morning'),
    a = confirmed(raw, 'afternoon'),
    e = confirmed(raw, 'evening');
  const sleepHours =
    m.sleepModeV2 === 'none' ? 0 : number(m.sleepMinutesV2) == null ? null : m.sleepMinutesV2 / 60;
  const napStart = typeof e.napStartV2 === 'string' ? Date.parse(e.napStartV2) : NaN;
  const wake = typeof m.sleepWakeV2 === 'string' ? Date.parse(m.sleepWakeV2) : NaN;
  const attempt = typeof m.sleepAttemptV2 === 'string' ? Date.parse(m.sleepAttemptV2) : NaN;
  const duration = number(e.napMinutesV2);
  const napOverlap =
    Number.isFinite(napStart) &&
    Number.isFinite(attempt) &&
    Number.isFinite(wake) &&
    duration != null &&
    napStart < wake &&
    napStart + duration * 60000 > attempt;
  return {
    date,
    morning: m,
    afternoon: a,
    evening: e,
    sleepHours,
    sleepApprox: m.sleepPrecisionV2 === 'approx',
    sleepQuality: m.sleepModeV2 === 'none' ? null : number(m.sleepQualityV2),
    napMinutes: e.extraNapV2 === 'yes' && !napOverlap ? duration : null,
    napOverlap,
    satisfaction: number(e.satisfactionV2),
    learningMinutes: number(e.learningMinutesV2),
  };
}
/** @param {ObservationDay[]} days @param {string} slot @param {string} metric */
export function observationPoints(days, slot, metric) {
  return days.flatMap((d) => {
    const v = number(/** @type {KvBlob} */ (d)[slot]?.[metric]);
    return v == null ? [] : [{ date: d.date, value: v }];
  });
}
/** Consistent threshold, groups require an explicit factor response in both groups.
 * @param {ObservationDay[]} days @param {string} field @param {string|number} value @param {string} metric */
export function compareObservedFactor(days, field, value, metric = 'satisfactionV2') {
  /** @type {number[]} */ const withFactor = [];
  /** @type {number[]} */ const withoutFactor = [];
  for (const d of days) {
    const v = d.evening[field],
      outcome = number(d.evening[metric]);
    if (
      v == null ||
      outcome == null ||
      v === 'unknown' ||
      v === 'notneeded' ||
      (Array.isArray(v) && v.includes('unknown'))
    )
      continue;
    const matches = Array.isArray(v) ? v.includes(value) : v === value;
    (matches ? withFactor : withoutFactor).push(outcome);
  }
  const yes = observedMean(withFactor),
    no = observedMean(withoutFactor);
  return {
    withFactor: yes,
    withoutFactor: no,
    eligible: yes.n >= 8 && no.n >= 8,
    difference:
      yes.n >= 8 && no.n >= 8 && yes.value != null && no.value != null
        ? yes.value - no.value
        : null,
  };
}
/** @param {ObservationDay[]} days @param {string} key */
export function clockRegularity(days, key) {
  const values = days.flatMap((d) => {
    const v = d.morning[key];
    if (typeof v !== 'string') return [];
    const m = /T(\d{2}):(\d{2})$/.exec(v);
    return m ? [Number(m[1]) * 60 + Number(m[2])] : [];
  });
  if (values.length < 2) return { n: values.length, spreadMinutes: null };
  const angle = values.map((v) => (v / 1440) * 2 * Math.PI),
    sin = angle.reduce((s, v) => s + Math.sin(v), 0) / values.length,
    cos = angle.reduce((s, v) => s + Math.cos(v), 0) / values.length;
  const centre = ((Math.atan2(sin, cos) / (2 * Math.PI)) * 1440 + 1440) % 1440;
  const offsets = values.map((v) => ((v - centre + 2160) % 1440) - 720);
  return {
    n: values.length,
    spreadMinutes: Math.sqrt(offsets.reduce((s, v) => s + v * v, 0) / offsets.length),
  };
}
/** @param {KvBlob} records @param {string} to @param {number} [days] */
export function analyzeObservations(records, to, days = 7) {
  const duration = Math.max(1, Math.min(90, Math.trunc(days))),
    from = shiftCheckinDate(to, 1 - duration),
    previousTo = shiftCheckinDate(from, -1);
  const collect = (/** @type {string} */ end) =>
    Array.from({ length: duration }, (_, i) => {
      const date = shiftCheckinDate(end, i + 1 - duration);
      return observationDay(date, records[date] ?? {});
    });
  const current = collect(to),
    previous = collect(previousTo);
  const paired = current.filter(
    (d) => number(d.morning.energy) != null && number(d.evening.energy) != null,
  );
  const lowerEnergy = paired.filter((d) => d.evening.energy < d.morning.energy).length;
  /** @type {Record<string,number>} */ const outcomes = {};
  /** @type {Record<string,number>} */ const activities = {};
  /** @type {Record<string,number>} */ const activityGroups = {};
  for (const d of current) {
    if (d.evening.priorityOutcomeV2)
      outcomes[d.evening.priorityOutcomeV2] = (outcomes[d.evening.priorityOutcomeV2] ?? 0) + 1;
    const ids = Array.isArray(d.evening.activitiesV2) ? d.evening.activitiesV2 : [];
    for (const id of ids) activities[id] = (activities[id] ?? 0) + 1;
    const groups = new Set(
      ids
        .map((id) => d.evening.activityGroupsV2?.[id] ?? ACTIVITIES.find((c) => c.id === id)?.group)
        .filter(Boolean),
    );
    for (const group of groups) activityGroups[group] = (activityGroups[group] ?? 0) + 1;
  }
  return {
    from,
    to,
    days: duration,
    current,
    previous,
    previousFrom: shiftCheckinDate(previousTo, 1 - duration),
    previousTo,
    recordedDays: current.filter(
      (d) => d.morning.confirmed || d.afternoon.confirmed || d.evening.confirmed,
    ).length,
    facts: {
      lowerEnergy,
      energyPairs: paired.length,
      learningDays: current.filter((d) => (d.learningMinutes ?? 0) > 0).length,
      learningMinutes: current.reduce((s, d) => s + (d.learningMinutes ?? 0), 0),
      confirmedSlots: current.reduce(
        (s, d) =>
          s +
          ['morning', 'afternoon', 'evening'].filter(
            (slot) => /** @type {KvBlob} */ (d)[slot].confirmed,
          ).length,
        0,
      ),
    },
    outcomes,
    activities,
    activityGroups,
    sleep: observedMean(current.map((d) => d.sleepHours)),
    sleepQuality: observedMean(current.map((d) => d.sleepQuality)),
    sleepRegularity: clockRegularity(current, 'sleepAttemptV2'),
    wakeRegularity: clockRegularity(current, 'sleepWakeV2'),
  };
}
/** Reproducible demo records; never used as owner observations. @param {string} to */
export function demoObservations(to) {
  /** @type {KvBlob} */ const records = {};
  for (let i = 0; i < 40; i++) {
    const date = shiftCheckinDate(to, i - 39),
      energy = 2 + (i % 4),
      mood = 2 + ((i * 3) % 4),
      learn = i % 3 !== 0;
    const shared = { questionVersion: 2, confirmed: true, timezoneV2: 'Europe/Kyiv' };
    records[date] = {
      morning: {
        ...shared,
        sleepModeV2: 'main',
        sleepMinutesV2: 360 + (i % 5) * 30,
        sleepPrecisionV2: i % 3 ? 'exact' : 'approx',
        sleepQualityV2: 2 + (i % 4),
        energy,
        mood,
        priorityV2: learn ? 'mate' : 'taxi',
        priorityStepV2: learn ? 'Закінчити практичне завдання' : 'Робоча зміна',
        sleepAttemptV2: `${shiftCheckinDate(date, -1)}T23:${i % 2 ? '30' : '00'}`,
        sleepWakeV2: `${date}T07:00`,
      },
      afternoon:
        i % 7 === 0
          ? {}
          : {
              ...shared,
              energy: Math.max(1, energy - 1),
              mood,
              tensionV2: i % 5,
              sleepinessV2: i % 4,
            },
      evening:
        i % 6 === 0
          ? {}
          : {
              ...shared,
              energy: Math.max(1, energy - (i % 3 === 0 ? 2 : 0)),
              mood: Math.min(5, mood + 1),
              tensionV2: i % 4,
              satisfactionV2: 2 + (i % 4),
              priorityOutcomeV2: ['finished', 'progress', 'changed', 'notstarted', 'noplan'][i % 5],
              activitiesV2: learn ? ['mate', 'taxi', 'rest'] : ['taxi', 'people'],
              movementRangeV2: ['0', '1_15', '16_30', '31_60', 'gt60'][i % 5],
              movementMinutesV2: [0, 15, 30, 60, 75][i % 5],
              learningMinutesV2: learn ? 45 + (i % 4) * 30 : 0,
              learningPrecisionV2: 'approx',
              comprehensionV2: learn ? 2 + (i % 4) : 'na',
              focusV2: learn ? 2 + (i % 4) : 'na',
              blockersV2: i % 2 ? ['fatigue'] : ['none'],
              helpersV2: i % 2 ? ['rest'] : ['nextstep'],
              recoveryV2: i % 2 ? 'well' : 'noeffect',
              supportV2: i % 3 ? 'yes' : 'no',
              extraNapV2: i % 4 ? 'no' : 'yes',
              napMinutesV2: i % 4 ? undefined : 20,
              napStartV2: i % 4 ? undefined : `${date}T15:00`,
              physicalV2: 3 + (i % 3),
              sleepinessV2: i % 4,
              momentNoteV2: 'Помітив, що коротка прогулянка дала паузу між справами.',
            },
    };
  }
  return records;
}
