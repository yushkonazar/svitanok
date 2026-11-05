import { adaptiveCatalog } from './model.mjs';
import { analyzeAdaptive, demoAdaptive } from './adaptive-observations.mjs';
import { choiceAnswerLabel } from './choices.mjs';
import { observedMean, shiftCheckinDate } from './observations.mjs';
/** @typedef {import('./adaptive-observations.mjs').AdaptiveDay} Day */
const slots = ['morning', 'afternoon', 'evening'];
const fields = new Map(adaptiveCatalog.flatMap((c) => c.fields).map((f) => [f.id, f]));
const numeric = (/** @type {unknown} */ v) =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const rating = (/** @type {unknown} */ v) =>
  numeric(v) != null && Number(v) >= 1 && Number(v) <= 5 ? Number(v) : null;
/** @param {KvBlob} record @param {string} stem */
export const stateValue = (record, stem) => record[`${stem}V${record.questionVersion}`];
/** @param {number[]} values */
const mean = (values) => observedMean(values).value;
const answers = (/** @type {number} */ n) =>
  `${n} ${n % 100 >= 11 && n % 100 <= 14 ? 'відповідей' : n % 10 === 1 ? 'відповідь' : n % 10 >= 2 && n % 10 <= 4 ? 'відповіді' : 'відповідей'}`;
/** @param {Day[]} days @param {string} slot @param {string} stem @param {number} [revision] */
export function stateDistribution(days, slot, stem, revision) {
  /** @type {Map<string,KvBlob>} */ const items = new Map();
  let n = 0;
  for (const day of days) {
    const r = /** @type {KvBlob} */ (day)[slot];
    if (!r.confirmed || (revision && r.questionVersion !== revision)) continue;
    const id = `${stem}V${r.questionVersion}`,
      f = fields.get(id),
      value = r[id];
    if (!f || value == null || (Array.isArray(value) && !value.length)) continue;
    n++;
    for (const v of Array.isArray(value) ? value : [value]) {
      const key = String(v),
        item = items.get(key) ?? {
          id: key,
          label: choiceAnswerLabel(f, v, r),
          count: 0,
          dates: [],
        };
      item.count++;
      item.label = choiceAnswerLabel(f, v, r);
      item.dates.push(day.date);
      items.set(key, item);
    }
  }
  return {
    n,
    items: [...items.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
  };
}
/** Only independent questions may define contrast groups. Gated mood/energy
 * reasons are deliberately absent. @type {[string,string][]} */
export const STATE_FACTORS = [
  ['Тривалість сну', 'sleep_duration'],
  ['Якість сну', 'sleep_quality'],
  ['Перерви на роботі', 'work_breaks'],
  ['Час для себе', 'personal_time'],
  ['Практика на курсі', 'course_practice'],
  ['Практика в навчанні', 'study_practice'],
  ['Компанія в момент запису', 'company'],
];
/** @param {string} factor @param {string} [slot] @returns {[string,string][]} */
export function stateOutcomes(factor, slot = 'evening') {
  if (factor === 'course_practice') return [['Розуміння матеріалу курсу', 'course_comprehension']];
  if (factor === 'study_practice')
    return [['Розуміння навчального матеріалу', 'study_comprehension']];
  if (factor === 'company')
    return [
      [
        `${slot === 'morning' ? 'Ранкова' : slot === 'afternoon' ? 'Денна' : 'Вечірня'} енергія`,
        `${slot}_energy`,
      ],
      [
        `${slot === 'morning' ? 'Ранковий' : slot === 'afternoon' ? 'Денний' : 'Вечірній'} настрій`,
        `${slot}_mood`,
      ],
    ];
  const evening = /** @type {[string,string][]} */ ([
    ['Вечірня енергія', 'evening_energy'],
    ['Вечірній настрій', 'evening_mood'],
    ['Оцінка дня', 'satisfaction'],
  ]);
  return factor.startsWith('sleep_')
    ? [['Ранкова енергія', 'morning_energy'], ['Ранковий настрій', 'morning_mood'], ...evening]
    : [...evening, ['Зміна енергії: ранок → вечір', 'energy_change']];
}
/** @param {Day} day @param {string} key @returns {number|null} */
function outcomeValue(day, key) {
  if (key === 'energy_change')
    return rating(day.morning.energy) != null && rating(day.evening.energy) != null
      ? day.evening.energy - day.morning.energy
      : null;
  if (key === 'satisfaction') return rating(day.satisfaction);
  if (key.endsWith('_comprehension'))
    return day.evening.questionVersion === 4
      ? rating(day.evening[`${key.split('_')[0]}ComprehensionV4`])
      : null;
  const [slot, metric] = key.split('_');
  return rating(/** @type {KvBlob} */ (day)[slot ?? '']?.[metric ?? '']);
}
/** @param {Day[]} days @param {string} [slot] */
export function stateCompanyOptions(days, slot = 'evening') {
  return stateDistribution(days, slot, 'company').items.filter(
    (x) => !['alone', 'private', 'other', 'unknown'].includes(x.id),
  );
}
/** @param {Day[]} days @param {string} factor @param {string} outcome @param {{slot?:string,company?:string}} [options] */
export function compareState(days, factor, outcome, options = {}) {
  const slot = options.slot ?? 'evening',
    company = options.company ?? 'partner';
  const available = stateOutcomes(factor, slot),
    allowed =
      STATE_FACTORS.some(([, id]) => id === factor) && available.some(([, id]) => id === outcome);
  const sleep = days
    .map((d) => d.sleepHours)
    .filter((v) => v != null)
    .sort((a, b) => a - b);
  const middle = Math.floor(sleep.length / 2),
    median = sleep.length
      ? sleep.length % 2
        ? sleep[middle]
        : ((sleep[middle - 1] ?? 0) + (sleep[middle] ?? 0)) / 2
      : null;
  const firstMention = company.startsWith('user_')
    ? [...days]
        .sort((a, b) => a.date.localeCompare(b.date))
        .find((d) => stateValue(/** @type {KvBlob} */ (d)[slot], 'company')?.includes(company))
        ?.date
    : null;
  const companyLabel =
    stateCompanyOptions(days, slot).find((x) => x.id === company)?.label ?? 'Обрана компанія';
  const labels =
    factor === 'sleep_duration'
      ? ['Коротший сон', 'Довший сон']
      : factor === 'sleep_quality'
        ? ['Мало відпочив після сну', 'Добре відпочив після сну']
        : factor === 'work_breaks'
          ? ['Бракувало перерв', 'Перерв вистачало']
          : factor === 'personal_time'
            ? ['Часу не вистачило', 'Часу вистачило']
            : factor.endsWith('_practice')
              ? ['Ще не застосовував', 'Застосовував самостійно']
              : ['Був сам', companyLabel];
  /** @type {[{label:string,n:number,value:number|null,dates:string[],values:number[]},{label:string,n:number,value:number|null,dates:string[],values:number[]}]} */
  const groups = [
    { label: labels[0] ?? '', n: 0, value: null, dates: [], values: [] },
    { label: labels[1] ?? '', n: 0, value: null, dates: [], values: [] },
  ];
  if (allowed)
    for (const day of days) {
      const value = outcomeValue(day, outcome);
      if (value == null) continue;
      let group = -1;
      if (factor === 'sleep_duration' && day.sleepHours != null && median != null)
        group = day.sleepHours > median ? 1 : 0;
      if (factor === 'sleep_quality' && day.morning.questionVersion === 4)
        group = [1, 2].includes(day.sleepQuality ?? 0)
          ? 0
          : [4, 5].includes(day.sleepQuality ?? 0)
            ? 1
            : -1;
      const e = day.evening;
      if (e.questionVersion === 4) {
        if (factor === 'work_breaks')
          group = ['none', 'not_enough'].includes(e.workBreaksV4)
            ? 0
            : e.workBreaksV4 === 'enough'
              ? 1
              : -1;
        if (factor === 'personal_time')
          group = [1, 2].includes(e.freeTimeEnoughV4)
            ? 0
            : [3, 4].includes(e.freeTimeEnoughV4)
              ? 1
              : -1;
        if (factor.endsWith('_practice')) {
          const v = e[`${factor.split('_')[0]}PracticeV4`];
          group = v === 'not_tried' ? 0 : v === 'self' ? 1 : -1;
        }
      }
      if (factor === 'company' && (!firstMention || day.date >= firstMention)) {
        const v = stateValue(/** @type {KvBlob} */ (day)[slot], 'company');
        group =
          Array.isArray(v) && v.includes('alone')
            ? 0
            : Array.isArray(v) && !v.includes('private') && v.includes(company)
              ? 1
              : -1;
      }
      if (group < 0) continue;
      const g = groups[/** @type {0|1} */ (group)];
      g.values.push(value);
      g.dates.push(day.date);
      g.n++;
    }
  for (const g of groups) g.value = mean(g.values);
  const ready = allowed && groups.every((g) => g.n >= 3),
    delta = ready
      ? /** @type {number} */ (groups[1].value) - /** @type {number} */ (groups[0].value)
      : null;
  return {
    factor,
    outcome,
    title: STATE_FACTORS.find(([, id]) => id === factor)?.[0] ?? '',
    outcomeLabel: available.find(([, id]) => id === outcome)?.[0] ?? '',
    groups,
    ready,
    delta,
    median: factor === 'sleep_duration' ? median : null,
    from: firstMention ?? null,
    domain: outcome === 'energy_change' ? [-4, 4] : [1, 5],
  };
}
/** @param {Day[]} days @param {'energy'|'mood'} metric */
function balancedState(days, metric) {
  const bySlot = Object.fromEntries(
    slots.map((slot) => [
      slot,
      days.flatMap((d) => {
        const value = rating(/** @type {KvBlob} */ (d)[slot][metric]);
        return value == null ? [] : [value];
      }),
    ]),
  );
  const active = slots.filter((slot) => bySlot[slot]?.length),
    n = active.reduce((count, slot) => count + (bySlot[slot]?.length ?? 0), 0);
  return {
    value: mean(active.map((slot) => /** @type {number} */ (mean(bySlot[slot] ?? [])))),
    n,
    active,
    bySlot,
  };
}
/** @param {KvBlob} records @param {string} to @param {number} [period] */
export function stateReport(records, to, period = 30) {
  const a = analyzeAdaptive(records, to, [7, 30, 90].includes(period) ? period : 30);
  /** @type {KvBlob[]} */ const overview = ['energy', 'mood'].map((metric) => {
    const key = /** @type {'energy'|'mood'} */ (metric),
      current = balancedState(a.current, key),
      prior = balancedState(a.previous, key);
    const comparable =
      current.active.join() === prior.active.join() &&
      current.active.length > 0 &&
      current.active.every(
        (slot) =>
          (current.bySlot[slot]?.length ?? 0) >= 3 && (prior.bySlot[slot]?.length ?? 0) >= 3,
      );
    return {
      id: key,
      label: key === 'energy' ? 'Енергія' : 'Настрій',
      value: current.value,
      n: current.n,
      previous: prior.value,
      previousN: prior.n,
      delta:
        comparable && current.value != null && prior.value != null
          ? current.value - prior.value
          : null,
      unit: 'score',
      slots: current.active,
      points: a.current.flatMap((d) => {
        const v = balancedState([d], key).value;
        return v == null ? [] : [{ date: d.date, value: v }];
      }),
    };
  });
  for (const [id, label, unit] of [
    ['sleep', 'Сон', 'hours'],
    ['satisfaction', 'Оцінка дня', 'score'],
  ]) {
    const property = id === 'sleep' ? 'sleepHours' : 'satisfaction';
    const c = a.current.flatMap((d) => {
      const v = d[/** @type {'sleepHours'|'satisfaction'} */ (property)];
      return v == null ? [] : [{ date: d.date, value: v }];
    });
    const p = a.previous
      .map((d) => d[/** @type {'sleepHours'|'satisfaction'} */ (property)])
      .filter((v) => v != null);
    const value = mean(c.map((v) => v.value)),
      previous = mean(p);
    overview.push({
      id,
      label,
      value,
      n: c.length,
      previous,
      previousN: p.length,
      delta:
        c.length >= 3 && p.length >= 3 && value != null && previous != null
          ? value - previous
          : null,
      unit,
      slots: [id === 'sleep' ? 'morning' : 'evening'],
      points: c,
    });
  }
  /** @type {KvBlob[]} */ const insights = [];
  const paired = a.current.filter(
      (d) => rating(d.morning.energy) != null && rating(d.evening.energy) != null,
    ),
    declines = paired.filter((d) => d.evening.energy < d.morning.energy);
  if (paired.length >= 3 && declines.length / paired.length >= 0.6)
    insights.push({
      id: 'daily-energy',
      title: 'Як вистачає сил протягом дня',
      text: `Вечірня енергія нижча за ранкову у ${declines.length} із ${paired.length} днів з обома записами.`,
      idea: 'Залиши коротку перерву на другу половину дня й перевір вечірній стан.',
      dates: paired.map((d) => d.date),
      n: paired.length,
      kind: 'observation',
    });
  const moodMetric = overview.find((item) => item.id === 'mood');
  if (moodMetric?.delta != null && Math.abs(moodMetric.delta) >= 0.5) {
    const dates = a.current
      .filter((day) => slots.some((slot) => rating(/** @type {KvBlob} */ (day)[slot].mood) != null))
      .map((day) => day.date);
    insights.push({
      id: 'mood-change',
      title: moodMetric.delta > 0 ? 'Настрій за період вищий' : 'Настрій за період нижчий',
      text: `Середня оцінка ${moodMetric.value.toFixed(1).replace('.', ',')}/5 проти ${moodMetric.previous.toFixed(1).replace('.', ',')}/5 за попередні ${a.days} днів. Основа: ${moodMetric.n} і ${moodMetric.previousN} оцінок відповідно.`,
      idea: 'Подивись, які обставини ти відзначав у ці дні, й обери одну справу, що зазвичай підтримує тебе.',
      dates,
      n: dates.length,
      kind: 'observation',
    });
  }
  for (const [factor, outcome, idea] of [
    [
      'sleep_duration',
      'morning_energy',
      'Продовжуй позначати сон і ранкові сили, щоб перевірити повторюваність.',
    ],
    [
      'work_breaks',
      'evening_energy',
      'Заплануй перерву в наступний робочий день і відзнач вечірній стан.',
    ],
    [
      'personal_time',
      'satisfaction',
      'Залиши час на одну приємну справу й перевір, чи цього вистачило.',
    ],
  ]) {
    const comparison = compareState(a.current, factor ?? '', outcome ?? '');
    if (!comparison.ready || Math.abs(comparison.delta ?? 0) < 0.5) continue;
    const [left, right] = comparison.groups;
    insights.push({
      id: factor,
      title:
        factor === 'sleep_duration'
          ? 'Сон поруч із ранковими силами'
          : factor === 'work_breaks'
            ? 'Перерви поруч із вечірнім станом'
            : 'Особистий час і оцінка дня',
      text: `${right.label}: ${right.value?.toFixed(1).replace('.', ',')}/5 (${answers(right.n)}); ${left.label.toLowerCase()}: ${left.value?.toFixed(1).replace('.', ',')}/5 (${answers(left.n)}).`,
      idea,
      comparison,
      dates: [...new Set([...left.dates, ...right.dates])].sort(),
      n: left.n + right.n,
      kind: 'comparison',
    });
  }
  const recovery = stateDistribution(a.current, 'evening', 'recoveryTarget', 4).items.map(
    (item) => {
      const rows = a.current.filter(
        (d) =>
          d.evening.recoveryTargetV4 === item.id &&
          [1, 2, 3, 4, 5].includes(d.evening.recoveryEffectV4),
      );
      return {
        id: item.id,
        label: item.label,
        n: rows.length,
        better: rows.filter((d) => d.evening.recoveryEffectV4 >= 4).length,
        dates: rows.map((d) => d.date),
      };
    },
  );
  const recovered = recovery
    .filter((r) => r.n >= 3 && r.better / r.n >= 0.6)
    .sort((a, b) => b.n - a.n)[0];
  if (recovered)
    insights.push({
      id: 'recovery',
      title: 'Що ти відзначаєш після відновлення',
      text: `${recovered.label}: у ${recovered.better} з ${recovered.n} описаних випадків ти почувався краще після цього заняття.`,
      idea: 'Повтори цей варіант відновлення й познач власне враження.',
      dates: recovered.dates,
      n: recovered.n,
      kind: 'self-report',
    });
  const enough = a.current.filter(
    (d) => d.evening.questionVersion === 4 && [1, 2, 3, 4].includes(d.evening.freeTimeEnoughV4),
  );
  const learning = Object.fromEntries(
    ['study', 'course', 'read'].map((id) => {
      const known = a.current.filter(
        (d) =>
          Array.isArray(d.evening.developmentActualV4) &&
          !d.evening.developmentActualV4.includes('unknown'),
      );
      const done = known.filter((d) => d.evening.developmentActualV4.includes(id));
      const planned = a.directionOutcomes[id];
      return [
        id,
        { known: known.length, done: done.length, dates: done.map((d) => d.date), ...planned },
      ];
    }),
  );
  return {
    ...a,
    overview,
    insights: insights.slice(0, 3),
    recovery,
    learning,
    personal: {
      n: enough.length,
      enough: enough.filter((d) => d.evening.freeTimeEnoughV4 >= 3).length,
      dates: enough.filter((d) => d.evening.freeTimeEnoughV4 >= 3).map((d) => d.date),
    },
    previousFrom: shiftCheckinDate(a.from, -a.days),
    previousTo: shiftCheckinDate(a.from, -1),
  };
}
/** Demo is explicit and never an authenticated fallback. @param {string} to */
export function demoStateRecords(to) {
  const records = demoAdaptive(to);
  for (let i = 0; i < 28; i++) {
    const date = shiftCheckinDate(to, -i),
      good = i % 4 < 2,
      breaks = i % 3 !== 0;
    const base = { confirmed: true, questionVersion: 4, timezoneV3: 'Europe/Kyiv' };
    const slot = (/** @type {number} */ hour) => ({
      ...base,
      confirmedAtV3: `${date}T${hour.toString().padStart(2, '0')}:00:00+02:00`,
    });
    records[date] = {
      morning: {
        ...slot(9),
        energy: good ? 4 : 2,
        mood: good ? 4 : 3,
        sleepModeV4: 'main',
        sleepMinutesV4: good ? 450 : 330,
        sleepQualityV4: good ? 4 : 2,
        priorityV4: i % 2 ? 'course' : 'work',
        developmentPlanV4: i % 2 ? ['read'] : ['study'],
      },
      afternoon: {
        ...slot(17),
        energy: good ? 3 : 2,
        mood: 4,
        activitiesV4: ['work'],
        companyV4: i % 2 ? ['partner'] : ['alone'],
        priorityPaceV4: 'progress',
      },
      evening: {
        ...slot(22),
        energy: breaks ? 3 : 1,
        mood: breaks ? 4 : 2,
        satisfactionV4: breaks ? 4 : 2,
        activitiesV4: ['work', i % 2 ? 'walk' : 'rest'],
        companyV4: i % 2 ? ['partner'] : ['alone'],
        workLoadV4: i % 3 ? 3 : 5,
        workRangeV4: '4_8h',
        workBreaksV4: breaks ? 'enough' : 'none',
        freeTimeV4: breaks ? '60_119' : '1_29',
        freeTimeEnoughV4: breaks ? 3 : 1,
        priorityOutcomeV4: i % 3 ? 'finished' : 'changed',
        developmentActualV4: i % 2 ? ['course', 'read'] : i % 3 ? ['study'] : ['none'],
        courseRangeV4: i % 2 ? '30_59' : undefined,
        courseComprehensionV4: i % 2 ? 4 : undefined,
        coursePracticeV4: i % 2 ? 'self' : undefined,
        studyRangeV4: i % 2 ? undefined : '15_29',
        studyComprehensionV4: i % 2 ? undefined : 3,
        studyPracticeV4: i % 2 ? undefined : 'not_tried',
        recoveryTargetV4: i % 2 ? 'walk' : 'rest',
        recoveryEffectV4: breaks ? 4 : 2,
        napV4: i % 5 ? 'no' : 'yes',
        napMinutesV4: i % 5 ? undefined : 25,
        moodFactorsV4: breaks ? ['partner_good', 'weather_good'] : ['fatigue'],
        energyHelpersV4: breaks ? ['rest'] : undefined,
        energyKindV4: breaks ? undefined : ['mental'],
        energyFactorsV4: breaks ? undefined : ['no_breaks'],
      },
    };
  }
  return records;
}
