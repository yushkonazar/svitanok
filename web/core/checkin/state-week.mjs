import { minuteOf } from './catalog.mjs';
import { shiftCheckinDate } from './observations.mjs';
import { stateDistribution } from './state-analysis.mjs';
import {
  recordedStateRating,
  stateRatingBand,
  stateRatingDirection,
  STATE_RATING_LABELS,
} from './state-ratings.mjs';

/** @typedef {import('./adaptive-observations.mjs').AdaptiveDay} Day */
/** @typedef {{date:string, value:number|null, label:string}} Point */
/** @typedef {{kind:'reported'|'observed', text:string, dates:string[], examples?:{date:string,text:string}[], idea?:string}} Evidence */
export const STATE_SLEEP_REFERENCE = 420;
const slots = /** @type {const} */ (['evening', 'morning', 'afternoon']);
const lateReturn = 22 * 60;
const planLevels = /** @type {Record<string,[number,string]>} */ ({
  finished: [3, 'Завершив'],
  progress: [2, 'Зробив частину'],
  changed: [1, 'Змінив план'],
  external: [1, 'План змінився через обставини'],
  notstarted: [0, 'Не почав'],
});
/** @param {number} minutes */
function duration(minutes) {
  const n = Math.round(minutes),
    hours = Math.floor(n / 60),
    rest = n % 60;
  return hours ? `${hours} год${rest ? ` ${rest} хв` : ''}` : `${rest} хв`;
}
/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length
    ? ((sorted[i] ?? 0) + (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0)) / 2
    : null;
}
/** @param {Day} day */
function sleepMinutes(day) {
  const mode = day.morning.sleepModeV4 ?? day.morning.sleepModeV3;
  const hours = day.sleepHours;
  return (mode == null || mode === 'main' || mode === 'none') &&
    hours != null &&
    Number.isFinite(hours) &&
    hours >= 0 &&
    hours <= 24
    ? Math.round(hours * 60)
    : null;
}
/** @param {Day[]} days @param {string} slot @param {string[]} stems @returns {Evidence[]} */
function explanations(days, slot, stems) {
  const candidates = stems.flatMap((stem) => {
    const data = stateDistribution(days, slot, stem);
    return data.items
      .filter(
        (item) => !['unknown', 'none', 'other', 'private'].includes(item.id) && item.count >= 2,
      )
      .map((item) => ({ ...item, n: data.n }));
  });
  const top = candidates.sort((a, b) => b.count - a.count || b.n - a.n)[0];
  return top
    ? [
        {
          kind: 'reported',
          text: `«${top.label.split(' :: ').at(-1)}» згадується у ${top.count} із ${top.n} відповідей на це уточнення.`,
          dates: top.dates,
        },
      ]
    : [];
}
/** Compare only adjacent dates and preserve local day offsets for times after midnight.
 * Duration comes from the recorded sleep answer. @param {Day[]} days @returns {Evidence[]} */
function arrivalEvidence(days) {
  const chains = days.flatMap((day, index) => {
    const prior = days[index - 1];
    if (
      !prior ||
      prior.date !== shiftCheckinDate(day.date, -1) ||
      day.morning.sleepModeV4 !== 'main'
    )
      return [];
    const night = day.morning,
      evening = prior.evening;
    const sleep = sleepMinutes(day),
      arrival = minuteOf(evening.homeArrivalTimeV4);
    const bed = minuteOf(night.sleepBedtimeV4),
      wake = minuteOf(night.sleepWakeV4);
    if (
      sleep == null ||
      arrival == null ||
      bed == null ||
      wake == null ||
      !['same', 'next'].includes(evening.homeArrivalStatusV4) ||
      !['previous', 'same'].includes(night.sleepBedtimeDayV4)
    )
      return [];
    const a = arrival + (evening.homeArrivalStatusV4 === 'next' ? 1440 : 0);
    const b = bed + (night.sleepBedtimeDayV4 === 'same' ? 1440 : 0);
    if (a > b || b >= wake + 1440) return [];
    const mood = recordedStateRating(night, 'mood');
    return [
      {
        date: day.date,
        late: a >= lateReturn,
        sleep,
        text: `Додому о ${evening.homeArrivalTimeV4} · ліг о ${night.sleepBedtimeV4} · підйом о ${night.sleepWakeV4} · ${duration(sleep)}${mood ? ` · настрій ${ratingLabel(mood, 'mood').toLowerCase()}` : ''}`,
      },
    ];
  });
  const late = chains.filter((item) => item.late),
    early = chains.filter((item) => !item.late);
  const short = late.filter((item) => item.sleep < STATE_SLEEP_REFERENCE);
  if (late.length >= 3 && early.length >= 3) {
    const difference =
      (median(early.map((row) => row.sleep)) ?? 0) - (median(late.map((row) => row.sleep)) ?? 0);
    if (difference >= 30)
      return [
        {
          kind: 'observed',
          text: `Після повернення о 22:00 або пізніше типовий сон був коротший на ${duration(difference)}. ${late.length} пізніх і ${early.length} раніших повернень із записом сну.`,
          dates: chains.map((item) => item.date),
          examples: [...late.slice(-3), ...early.slice(-3)].map(({ date, text }) => ({
            date,
            text,
          })),
          idea: 'Спробуй кілька разів повернутися раніше й порівняй ці ночі з наступними пізніми поверненнями.',
        },
      ];
  }
  return short.length >= 2
    ? [
        {
          kind: 'observed',
          text: `${short.length} із ${late.length} ночей після пізнього повернення тривали менше 7 год. Пізні повернення тут — о 22:00 або згодом.`,
          dates: short.map((item) => item.date),
          examples: short.slice(-3).map(({ date, text }) => ({ date, text })),
        },
      ]
    : [];
}
/** @param {Day[]} days */
function sleepSignal(days) {
  const minutes = days.map(sleepMinutes);
  const actual = minutes.filter((n) => n != null);
  const short = days.filter((_, i) => (minutes[i] ?? Infinity) < STATE_SLEEP_REFERENCE);
  const mid = Math.floor(days.length / 2);
  const early = minutes.slice(0, mid).filter((n) => n != null);
  const late = minutes.slice(mid).filter((n) => n != null);
  const delta =
    early.length >= 2 && late.length >= 2 ? (median(late) ?? 0) - (median(early) ?? 0) : 0;
  const lower = delta <= -30;
  const higher = delta >= 30;
  const repeatedShort = actual.length >= 3 && short.length > actual.length / 2;
  const title = lower
    ? 'Сон скоротився'
    : repeatedShort
      ? 'Більшість ночей коротші за орієнтир'
      : higher
        ? 'Сон став довшим'
        : actual.length
          ? 'Тривалість сну за тиждень'
          : 'Ще немає записів про основний сон';
  const coverage = `Менше 7 год · ${short.length} із ${actual.length} ночей.`;
  const text = !actual.length
    ? 'Тривалість з’явиться після ранкового чек-іну.'
    : lower || higher
      ? `На ${duration(Math.abs(delta))} ${lower ? 'коротше' : 'довше'} в другій половині. ${coverage}`
      : actual.length >= 3
        ? `Типова ніч — ${duration(median(actual) ?? 0)}. ${coverage}`
        : coverage;
  return {
    key: /** @type {const} */ ('sleep'),
    title,
    text,
    priority:
      lower && repeatedShort ? 4 : lower || repeatedShort ? 3 : higher ? 2 : actual.length ? 1 : 0,
    samples: actual.length,
    max: Math.max(480, ...actual),
    reference: STATE_SLEEP_REFERENCE,
    dates: days.filter((_, i) => minutes[i] != null).map((day) => day.date),
    points: days.map((day, i) => ({
      date: day.date,
      value: minutes[i] ?? null,
      label: minutes[i] == null ? 'Немає тривалості' : duration(minutes[i] ?? 0),
    })),
    context: [
      ...arrivalEvidence(days),
      ...sleepMoodEvidence(days),
      ...explanations(short.length ? short : days, 'morning', [
        'sleepBlockers',
        'bedtimeReasons',
        'sleepAbsence',
      ]),
    ],
  };
}
const legacyLabels = {
  mood: ['Складний', 'Змішаний', 'Хороший'],
  energy: ['Мало сил', 'Помірно сил', 'Багато сил'],
};
/** @param {{value:number,scale:number}} rating @param {'mood'|'energy'} metric */
function ratingLabel(rating, metric) {
  return rating.scale === 8
    ? (STATE_RATING_LABELS[metric][rating.value - 1]?.split(' · ')[0] ?? '')
    : (legacyLabels[metric][stateRatingBand(rating)] ?? '');
}
/** @typedef {{value:number,scale:number}} Rating */
/** @param {Rating[]} first @param {Rating[]} second */
function ordinalChange(first, second) {
  if (first.length < 2 || second.length < 2) return 0;
  const mixed = new Set([...first, ...second].map((r) => r.scale)).size > 1;
  const signs = first.flatMap((a) =>
    second.map((b) =>
      mixed ? Math.sign(stateRatingBand(b) - stateRatingBand(a)) : stateRatingDirection(a, b),
    ),
  );
  const clear = Math.ceil((signs.length * 2) / 3);
  if (signs.filter((sign) => sign < 0).length >= clear) return -1;
  return signs.filter((sign) => sign > 0).length >= clear ? 1 : 0;
}
/** @typedef {{date:string,mood:Rating}} MoodPoint */
/** @param {MoodPoint[]} first @param {MoodPoint[]} second @param {string} intro
 * @param {string} denominator @param {string} part @returns {Evidence[]} */
function compareMood(first, second, intro, denominator, part) {
  if (first.length < 3 || second.length < 3) return [];
  const change = ordinalChange(
    first.map((item) => item.mood),
    second.map((item) => item.mood),
  );
  return change
    ? [
        {
          kind: 'observed',
          text: `${intro} настрій ${part} частіше був ${change > 0 ? 'кращим' : 'складнішим'}. ${denominator}`,
          dates: [...first, ...second].map((item) => item.date).sort(),
        },
      ]
    : [];
}
/** @param {Day[]} days @returns {Evidence[]} */
function sleepMoodEvidence(days) {
  const nights = days.flatMap((day) => {
    const mood = recordedStateRating(day.morning, 'mood');
    const minutes = sleepMinutes(day);
    return mood && minutes != null ? [{ date: day.date, mood, minutes }] : [];
  });
  const short = nights.filter((night) => night.minutes < STATE_SLEEP_REFERENCE);
  const longer = nights.filter((night) => night.minutes >= STATE_SLEEP_REFERENCE);
  return compareMood(
    longer,
    short,
    'Після сну коротшого за 7 год',
    `Зіставлено ночі до 7 год (${short.length}) і від 7 год (${longer.length}).`,
    'зранку',
  );
}
/** @param {Day[]} days @returns {Evidence[]} */
function activityMoodEvidence(days) {
  const known = days.flatMap((day) => {
    const actual = day.evening.developmentActualV4,
      mood = recordedStateRating(day.evening, 'mood');
    return Array.isArray(actual) && actual.length > 0 && !actual.includes('unknown') && mood
      ? [{ date: day.date, actual, mood }]
      : [];
  });
  const direction = [
    ['study', 'навчанням'],
    ['course', 'курсом'],
    ['read', 'читанням'],
  ];
  for (const [key, label] of direction) {
    const withActivity = known.filter((item) => item.actual.includes(key));
    const without = known.filter((item) => !item.actual.includes(key));
    const evidence = compareMood(
      without,
      withActivity,
      `У дні з ${label}`,
      `Зіставлено дні із заняттям (${withActivity.length}) і без нього (${without.length}).`,
      'увечері',
    );
    if (evidence.length) return evidence;
  }
  return [];
}
/** @param {Day[]} days @returns {Evidence[]} */
function dailyEnergyEvidence(days) {
  const pairs = days.flatMap((day) => {
    const morning = recordedStateRating(day.morning, 'energy');
    const evening = recordedStateRating(day.evening, 'energy');
    return morning && evening
      ? [{ date: day.date, direction: stateRatingDirection(morning, evening) }]
      : [];
  });
  if (pairs.length < 3) return [];
  const lower = pairs.filter((item) => item.direction < 0);
  const higher = pairs.filter((item) => item.direction > 0);
  const group = lower.length >= Math.ceil((pairs.length * 2) / 3) ? lower : higher;
  if (group.length < Math.ceil((pairs.length * 2) / 3)) return [];
  return [
    {
      kind: 'observed',
      text: `У ${group.length} із ${pairs.length} днів із двома оцінками сил увечері було ${group === lower ? 'менше' : 'більше'}, ніж зранку.`,
      dates: group.map((item) => item.date),
    },
  ];
}
/** @param {Day[]} days @param {'mood'|'energy'} metric */
function ratingSignal(days, metric) {
  const mid = Math.floor(days.length / 2);
  const series = slots.map((slot) => {
    const points = days.map((day) => recordedStateRating(day[slot], metric));
    const early = points.slice(0, mid).filter((n) => n != null);
    const late = points.slice(mid).filter((n) => n != null);
    return { slot, points, early, late, n: early.length + late.length };
  });
  const chosen =
    series.find(({ early, late }) => early.length >= 2 && late.length >= 2) ??
    series.reduce((best, entry) => (entry.n > best.n ? entry : best));
  const { slot, points, early, late, n } = chosen;
  const name = metric === 'mood' ? 'Настрій' : 'Енергія';
  const part = { morning: 'зранку', afternoon: 'вдень', evening: 'увечері' }[slot];
  const change = ordinalChange(early, late);
  const bands = [...early, ...late].map(stateRatingBand);
  const low = bands.filter((band) => band === 0).length;
  const high = bands.filter((band) => band === 2).length;
  const oftenLow = n >= 3 && low > n / 2;
  const oftenHigh = n >= 3 && high > n / 2;
  const varied = low >= 2 && high >= 2;
  const mixed = new Set([...early, ...late].map((r) => r.scale)).size > 1;
  let title = n ? `${name} ${part}` : `Ще немає оцінок · ${name.toLowerCase()}`;
  let text = n
    ? `${n} із ${days.length} днів мають оцінку ${part}`
    : 'Оцінка з’явиться після підтвердженого чек-іну.';
  if (change) {
    title =
      metric === 'mood'
        ? `Настрій ${part} ${change > 0 ? 'покращився' : 'погіршився'}`
        : `${change > 0 ? 'Більше' : 'Менше'} сил ${part}`;
    text = `Друга половина тижня · ${late.length} оцінок ${part} проти ${early.length} у першій`;
  } else if (varied) {
    title = `${name} ${part} ${metric === 'mood' ? 'коливався' : 'коливалася'}`;
    text = `Із ${n} оцінок ${part} · ${low} на нижніх рівнях, ${high} на верхніх`;
  } else if (oftenLow) {
    title = metric === 'mood' ? `Часто складний настрій ${part}` : `Часто бракувало сил ${part}`;
    text = `${low} із ${n} оцінок ${part} на нижніх рівнях`;
  } else if (oftenHigh) {
    title =
      metric === 'mood' ? `Переважно хороший настрій ${part}` : `Зазвичай було багато сил ${part}`;
    text = `${high} із ${n} оцінок ${part} на верхніх рівнях`;
  }
  const contextDays = days.filter((_, i) => points[i] != null);
  const explanationsFor =
    oftenLow || change < 0
      ? contextDays.filter((day) => {
          const rating = recordedStateRating(day[slot], metric);
          return rating && stateRatingBand(rating) < 2;
        })
      : contextDays;
  return {
    key: metric,
    title,
    text,
    slot,
    priority: change < 0 || oftenLow ? 3 : change > 0 ? 2 : n ? 1 : 0,
    samples: n,
    max: mixed ? 3 : ((early[0] ?? late[0])?.scale ?? 5),
    dates: contextDays.map((day) => day.date),
    points: days.map((day, i) => {
      const value = points[i];
      return {
        date: day.date,
        value: value ? (mixed ? stateRatingBand(value) + 1 : value.value) : null,
        label: value ? ratingLabel(value, metric) : 'Немає оцінки',
      };
    }),
    context: [
      ...(metric === 'energy'
        ? dailyEnergyEvidence(days)
        : slot === 'morning'
          ? sleepMoodEvidence(days)
          : slot === 'evening'
            ? activityMoodEvidence(days)
            : []),
      ...explanations(
        explanationsFor,
        slot,
        metric === 'mood' ? ['moodFactors'] : ['energyFactors', 'energyHelpers'],
      ),
    ],
  };
}
/** @param {Day[]} days */
function plansSignal(days) {
  const results = days.map((day) => {
    const plan = day.morning.priorityV4 ?? day.morning.priorityV3;
    const result = day.evening.priorityOutcomeV4 ?? day.evening.priorityOutcomeV3;
    if (!plan || plan === 'noplan' || !planLevels[result]) return undefined;
    const revised = day.afternoon.priorityPaceV4 ?? day.afternoon.priorityPaceV3;
    return ['changed', 'external'].includes(revised) ? planLevels[revised] : planLevels[result];
  });
  const samples = results.filter(Boolean).length;
  const done = results.filter((row) => row?.[0] === 3).length;
  const changed = results.filter((row) => row?.[0] === 1).length;
  const dates = days.filter((_, i) => results[i]).map((day) => day.date);
  return {
    key: /** @type {const} */ ('plans'),
    title: samples ? 'Що вийшло з головних справ' : 'Ще немає пар «план і результат»',
    text: samples
      ? `Головне завершено у ${done} з ${samples} днів із планом і підсумком${changed ? ` · план змінився ${changed} разів` : ''}`
      : 'Тут зійдуться ранковий напрям і вечірня відповідь про результат.',
    priority: samples >= 3 ? 2 : samples ? 1 : 0,
    samples,
    max: 3,
    dates,
    points: days.map((day, i) => ({
      date: day.date,
      value: results[i]?.[0] ?? null,
      label: results[i]?.[1] ?? 'Немає пари записів',
    })),
    context: explanations(
      days.filter((day) => dates.includes(day.date)),
      'evening',
      ['priorityReasons', 'priorityChanges', 'priorityHelpers'],
    ),
  };
}

/** Shared by the rolling overview and the calendar week in the saved report.
 * @param {Day[]} days */
export function stateWeek(days) {
  const signals = {
    sleep: sleepSignal(days),
    mood: ratingSignal(days, 'mood'),
    energy: ratingSignal(days, 'energy'),
    plans: plansSignal(days),
  };
  const ranked = Object.values(signals).sort(
    (a, b) => b.priority - a.priority || b.samples - a.samples,
  );
  const focus = ranked[0]?.key ?? 'sleep';
  const highlights = ranked
    .filter((signal) => signal.priority >= 2 || signal.samples >= 3)
    .slice(0, 3)
    .map(({ key, title, text, samples, dates, context }) => ({
      key,
      title,
      text,
      samples,
      dates,
      context,
    }));
  return { signals, focus, highlights };
}
