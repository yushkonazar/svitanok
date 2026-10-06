import { validFieldValue, normalizeCheckinPreferences } from './catalog.mjs';

/** @typedef {import('./catalog.mjs').Field} Field */
/** @typedef {import('./catalog.mjs').Card} Card */
/** @param {string} id @param {string} label @param {[string,string|number][]} options @param {Partial<Field>} [extra] @returns {Field} */
const one = (id, label, options, extra = {}) => ({ id, label, type: 'one', options, ...extra });
/** @param {string} id @param {string} label @param {[string,string|number][]} options @param {Partial<Field>} [extra] @returns {Field} */
const multi = (id, label, options, extra = {}) => ({
  id,
  label,
  type: 'multi',
  options,
  limit: 2,
  ...extra,
});
/** @param {string[]} labels @returns {[string,number][]} */
const levels = (labels) => labels.map((s, i) => [`${i + 1} · ${s}`, i + 1]);
/** @type {[string,string|number][]} */
export const ACTIVITY_OPTIONS_V3 = [
  ['Справи й розвиток :: Робота', 'work'],
  ['Справи й розвиток :: Навчання / курс', 'learn'],
  ['Справи й розвиток :: Читання', 'read'],
  ['Справи й розвиток :: Власний проєкт', 'project'],
  ['Повсякденне :: Побут', 'chores'],
  ['Повсякденне :: Особисті справи', 'personal'],
  ['Повсякденне :: Їжа / готування', 'food'],
  ['Повсякденне :: Дорога / поїздка', 'travel'],
  ['Відновлення :: Відпочинок', 'rest'],
  ['Відновлення :: Прогулянка', 'walk'],
  ['Відновлення :: Тренування', 'workout'],
  ['Відновлення :: Сон / дрімота', 'nap'],
  ['Люди й дозвілля :: Спілкування', 'people'],
  ['Люди й дозвілля :: Подія / зустріч', 'event'],
  ['Люди й дозвілля :: Ігри', 'games'],
  ['Люди й дозвілля :: Фільми / контент', 'content'],
  ['Люди й дозвілля :: Творчість', 'create'],
  ['Інше', 'other'],
  ['Не можу визначити', 'unknown'],
];
/** @type {[string,string|number][]} */
export const COMPANY_OPTIONS_V3 = [
  ['Сам', 'alone'],
  ['З коханою людиною', 'partner'],
  ['З родиною', 'family'],
  ['З друзями', 'friends'],
  ['Люди у робочому контексті', 'work'],
  ['З іншими людьми', 'other'],
  ['Не хочу вказувати', 'private'],
];
/** @type {[string,string|number][]} */
export const FACTOR_OPTIONS_V3 = [
  ['Люди :: Приємне спілкування', 'connection'],
  ['Люди :: Підтримка', 'support'],
  ['Люди :: Зустріч із близькими', 'meeting'],
  ['Люди :: Конфлікт', 'conflict'],
  ['Люди :: Неприємна взаємодія', 'interaction'],
  ['Люди :: Хотів більше часу разом', 'missed_connection'],
  ['Справи :: Успіх / поступ', 'success'],
  ['Справи :: Труднощі', 'difficulty'],
  ['Справи :: Перевантаження', 'overload'],
  ['Справи :: Невизначеність', 'uncertainty'],
  ['Тіло й відновлення :: Сонливість', 'sleepy'],
  ['Тіло й відновлення :: Фізична втома', 'fatigue'],
  ['Тіло й відновлення :: Дискомфорт', 'discomfort'],
  ['Тіло й відновлення :: Тренування', 'workout'],
  ['Тіло й відновлення :: Прогулянка', 'walk'],
  ['Тіло й відновлення :: Відпочинок', 'rest'],
  ['Тіло й відновлення :: Пропущена їжа', 'missed_food'],
  ['Увага й час :: Вдалось зосередитися', 'focus'],
  ['Увага й час :: Відволікання', 'distraction'],
  ['Увага й час :: Телефон / контент', 'phone'],
  ['Увага й час :: Нестача часу', 'time'],
  ['Увага й час :: Достатньо часу для себе', 'free_time'],
  ['Обставини :: Поїздка / подія', 'event'],
  ['Обставини :: Фінансові переживання', 'money'],
  ['Обставини :: Зовнішні умови', 'conditions'],
  ['Інше', 'other'],
  ['Нічого виразного', 'none'],
  ['Не знаю', 'unknown'],
];
/** @type {[string,string|number][]} */
export const PRIORITY_OPTIONS_V3 = [
  ['Робота', 'work'],
  ['Навчання', 'learn'],
  ['Особисті справи', 'personal'],
  ['Близькі люди', 'people'],
  ['Відпочинок', 'rest'],
  ['Подія / поїздка', 'event'],
  ['Інше', 'other'],
  ['Поки без пріоритету', 'noplan'],
];
/** @type {[string,string|number][]} */
const development = [
  ['Навчання / курс', 'learn'],
  ['Читання', 'read'],
  ['І те, й інше', 'both'],
  ['Ні', 'none'],
];
/** @type {[string,string|number][]} */
export const TIME_RANGES_V3 = [
  ['До 15 хв', 'lt15'],
  ['15–30 хв', '15_30'],
  ['30–60 хв', '30_60'],
  ['1–2 год', '1_2h'],
  ['Понад 2 год', 'gt2h'],
  ['Важко оцінити', 'unknown'],
];
/** @type {[string,string|number][]} */
const blockers = [
  ['Пізно закінчив справи', 'late_work'],
  ['Інші обов’язки', 'obligations'],
  ['Мало сил', 'fatigue'],
  ['Свідомо обрав інше', 'choice'],
  ['Відволікся', 'distraction'],
  ['Зовнішні обставини', 'external'],
  ['Немає чіткого наступного кроку', 'unclear'],
  ['Інше', 'other'],
  ['Не знаю', 'unknown'],
];
/** @type {Card} */
const state = {
  id: 'state',
  title: 'Як ти зараз?',
  fields: [
    one(
      'energy',
      'Енергія зараз',
      levels([
        'Сил майже немає',
        'Мало сил, справи даються важко',
        'Вистачає на звичні справи',
        'Багато сил, легко включитися',
        'Дуже багато сил, бадьорість',
      ]),
      { period: 'now' },
    ),
    one(
      'mood',
      'Настрій зараз',
      levels([
        'Дуже поганий',
        'Радше поганий',
        'Нейтральний або змішаний',
        'Радше хороший',
        'Дуже хороший',
      ]),
      { period: 'now' },
    ),
  ],
};
/** @param {string} slot @returns {Card} */
const contextCard = (slot) => ({
  id: 'context',
  title: 'Твій контекст',
  help:
    slot === 'morning'
      ? 'Заняття й компанія саме зараз.'
      : 'Заняття — від попереднього запису, компанія — саме зараз.',
  fields: [
    multi(
      'activitiesV3',
      slot === 'morning' ? 'Чим займаєшся зараз? · до двох' : 'Чим переважно займався? · до двох',
      ACTIVITY_OPTIONS_V3,
      { period: slot === 'morning' ? 'now' : 'since_previous' },
    ),
    multi('companyV3', 'З ким ти зараз?', COMPANY_OPTIONS_V3, { period: 'now' }),
  ],
});
/** @type {Record<string,Card[]>} */
export const CHECKIN_CARDS_V3 = {
  morning: [
    {
      id: 'sleep',
      title: 'Сон перед початком дня',
      help: 'Приблизна тривалість достатня. Час у ліжку не завжди дорівнює часу сну.',
      fields: [
        one('sleepModeV3', 'Який сон був?', [
          ['Основний сон', 'main'],
          ['Лише дрімав', 'naps'],
          ['Не спав', 'none'],
        ]),
        {
          id: 'sleepMinutesV3',
          label: 'Приблизно скільки спав?',
          type: 'duration',
          min: 1,
          max: 1440,
          optional: true,
          when: { key: 'sleepModeV3', values: ['main', 'naps'] },
          period: 'sleep_episode',
          help: 'Якщо не пам’ятаєш, залиш порожнім — це не стане нулем.',
        },
        one(
          'sleepQualityV3',
          'Як оцінюєш цей сон?',
          [
            ...levels([
              'Майже не дав відпочинку',
              'Радше погано',
              'Частково відпочив',
              'Добре відпочив',
              'Повністю влаштував',
            ]),
            ['Не можу оцінити', 'unknown'],
          ],
          { when: { key: 'sleepModeV3', values: ['main', 'naps'] }, period: 'sleep_episode' },
        ),
      ],
    },
    state,
    contextCard('morning'),
    {
      id: 'priority',
      title: 'Напрямок цього дня',
      help: 'Відпочинок — повноцінний пріоритет. Детальний розклад можна створити з асистентом.',
      fields: [
        one('priorityV3', 'Що сьогодні головне?', PRIORITY_OPTIONS_V3, { period: 'upcoming_day' }),
        one('developmentPlanV3', 'Хочеш знайти час для навчання або читання?', development, {
          period: 'upcoming_day',
        }),
        {
          id: 'priorityStepV3',
          label: 'Конкретний результат',
          type: 'text',
          max: 180,
          optional: true,
          period: 'upcoming_day',
        },
      ],
    },
  ],
  afternoon: [
    state,
    contextCard('afternoon'),
    {
      id: 'progress',
      title: 'Як іде твій план?',
      fields: [
        one('priorityPaceV3', 'Поступ головного пріоритету', [
          ['Ще не настав час', 'later'],
          ['Ще не починав', 'notstarted'],
          ['Є поступ', 'progress'],
          ['Завершив', 'finished'],
          ['Свідомо змінив', 'changed'],
          ['Обставини змінили план', 'external'],
          ['Без визначеного пріоритету', 'noplan'],
        ]),
      ],
    },
  ],
  evening: [
    {
      ...state,
      fields: [
        ...state.fields,
        one(
          'satisfactionV3',
          'Наскільки задоволений днем?',
          levels([
            'Зовсім не задоволений',
            'Радше не задоволений',
            'Змішані враження',
            'Радше задоволений',
            'Дуже задоволений',
          ]),
          { period: 'whole_day' },
        ),
      ],
    },
    contextCard('evening'),
    {
      id: 'outcome',
      title: 'Від наміру до результату',
      fields: [
        one('priorityOutcomeV3', 'Що вийшло з головним пріоритетом?', [
          ['Завершив', 'finished'],
          ['Частково просунувся', 'progress'],
          ['Не розпочав', 'notstarted'],
          ['Свідомо змінив', 'changed'],
          ['Змінив через обставини', 'external'],
          ['Не мав пріоритету', 'noplan'],
        ]),
        one('developmentActualV3', 'Сьогодні було навчання або читання?', development, {
          period: 'whole_day',
        }),
      ],
    },
    {
      id: 'time',
      title: 'Час для себе',
      fields: [
        one(
          'freeTimeV3',
          'Скільки часу залишилося після обов’язкових справ?',
          [
            ['Майже не було', 'none'],
            ['До 30 хв', 'lt30'],
            ['30–60 хв', '30_60'],
            ['1–2 год', '1_2h'],
            ['Понад 2 год', 'gt2h'],
            ['Важко оцінити', 'unknown'],
          ],
          {
            period: 'whole_day',
            help: 'Приблизна оцінка доступного часу, а не оцінка того, як ти його витратив.',
          },
        ),
      ],
    },
    {
      id: 'next-sleep',
      title: 'Наступний сон',
      fields: [
        {
          id: 'bedtimePlanV3',
          label: 'Коли хочеш лягти для основного сну?',
          type: 'time',
          optional: true,
          period: 'upcoming_sleep',
          help: 'Можна залишити порожнім, якщо ще не знаєш.',
        },
        one(
          'napV3',
          'Додатково дрімав протягом дня?',
          [
            ['Ні', 'no'],
            ['Так', 'yes'],
            ['Не знаю', 'unknown'],
          ],
          { period: 'whole_day' },
        ),
        {
          id: 'napMinutesV3',
          label: 'Приблизна тривалість додаткової дрімоти',
          type: 'duration',
          min: 1,
          max: 1440,
          optional: true,
          when: { key: 'napV3', values: ['yes'] },
          period: 'nap_episode',
        },
      ],
    },
  ],
};
/** @type {Card[]} */
export const FOLLOWUP_CARDS_V3 = [
  {
    id: 'bedtime',
    title: 'Відхід до сну',
    fields: [
      one(
        'bedtimeOutcomeV3',
        'Чи вдалося лягти тоді, коли хотів?',
        [
          ['Раніше', 'earlier'],
          ['Приблизно тоді', 'ontime'],
          ['Пізніше', 'later'],
          ['План змінився', 'changed'],
          ['Не пам’ятаю', 'unknown'],
        ],
        { optional: true, period: 'sleep_episode' },
      ),
      multi(
        'bedtimeReasonsV3',
        'Що відсунуло відхід до сну?',
        [
          ['Робота / дорога', 'work'],
          ['Обов’язкові справи', 'chores'],
          ['Навчання / читання', 'learning'],
          ['Спілкування', 'people'],
          ['Ігри / фільм', 'leisure'],
          ['Телефон / стрічка', 'phone'],
          ['Не хотів завершувати вечір', 'choice'],
          ['Інше', 'other'],
          ['Не знаю', 'unknown'],
        ],
        {
          optional: true,
          when: { key: 'bedtimeOutcomeV3', values: ['later'] },
          period: 'sleep_episode',
        },
      ),
    ],
  },
  {
    id: 'sleep-poor',
    title: 'Що завадило цьому сну?',
    fields: [
      multi(
        'sleepBlockersV3',
        'Можливі пояснення · до двох',
        [
          ['Мало часу на сон', 'time'],
          ['Важко заснути', 'latency'],
          ['Пробудження', 'awakenings'],
          ['Думки / напруження', 'thoughts'],
          ['Дискомфорт', 'discomfort'],
          ['Шум / температура / умови', 'conditions'],
          ['Сон у дорозі', 'travel'],
          ['Інше', 'other'],
          ['Не знаю', 'unknown'],
        ],
        { optional: true, period: 'sleep_episode' },
      ),
    ],
  },
  {
    id: 'sleep-good',
    title: 'Що допомогло виспатися?',
    fields: [
      multi(
        'sleepHelpersV3',
        'Що пов’язуєш із добрим сном?',
        [
          ['Достатньо часу', 'time'],
          ['Спокійний вечір', 'calm'],
          ['Комфортні умови', 'conditions'],
          ['Вдалося розслабитися', 'relax'],
          ['Ліг коли хотів', 'ontime'],
          ['Нічого виразного', 'none'],
          ['Не знаю', 'unknown'],
        ],
        { optional: true, period: 'sleep_episode' },
      ),
    ],
  },
  {
    id: 'development-blocked',
    title: 'Час на бажане',
    fields: [
      multi('developmentBlockersV3', 'Що завадило запланованому навчанню або читанню?', blockers, {
        optional: true,
        period: 'whole_day',
      }),
    ],
  },
  {
    id: 'plan-blocked',
    title: 'Що змінило план?',
    fields: [
      multi('priorityReasonsV3', 'Головна перешкода або причина зміни', blockers, {
        optional: true,
      }),
    ],
  },
  {
    id: 'mood-context',
    title: 'Що пов’язуєш із настроєм?',
    fields: [
      multi('moodFactorsV3', 'Що найбільше пов’язано з цим станом або зміною?', FACTOR_OPTIONS_V3, {
        optional: true,
        period: 'perceived_context',
        help: 'Твоє пояснення, а не доведена причина. Можна обрати до двох.',
      }),
    ],
  },
  {
    id: 'energy-context',
    title: 'Мало сил — який це стан?',
    fields: [
      one(
        'energyKindV3',
        'Що найбільше описує його?',
        [
          ['Хочеться спати', 'sleepy'],
          ['Фізично виснажений', 'physical'],
          ['Емоційно виснажений', 'emotional'],
          ['Важко включитися у справи', 'activation'],
          ['Фізичний дискомфорт', 'discomfort'],
          ['Кілька причин', 'mixed'],
          ['Не знаю', 'unknown'],
        ],
        { optional: true, period: 'now' },
      ),
    ],
  },
  {
    id: 'learning',
    title: 'Навчання й читання',
    fields: [
      one('learningRangeV3', 'Приблизно скільки навчався?', TIME_RANGES_V3, {
        optional: true,
        period: 'whole_day',
        when: { key: 'developmentActualV3', values: ['learn', 'both'] },
      }),
      one(
        'comprehensionV3',
        'Як сприймався матеріал?',
        [
          ...levels([
            'Майже не зрозумів',
            'Значна частина складна',
            'Зрозумів основне',
            'Здебільшого зрозуміло',
            'Розумію і можу застосувати',
          ]),
          ['Не було нового матеріалу', 'na'],
        ],
        {
          optional: true,
          period: 'whole_day',
          when: { key: 'developmentActualV3', values: ['learn', 'both'] },
        },
      ),
      one('readingRangeV3', 'Приблизно скільки читав?', TIME_RANGES_V3, {
        optional: true,
        period: 'whole_day',
        when: { key: 'developmentActualV3', values: ['read', 'both'] },
      }),
    ],
  },
  {
    id: 'recovery',
    title: 'Після відпочинку або руху',
    fields: [
      one(
        'recoveryEffectV3',
        'Як почуваєшся порівняно з до?',
        [
          ...levels([
            'Значно гірше',
            'Трохи гірше',
            'Без помітної зміни',
            'Трохи краще',
            'Значно краще',
          ]),
          ['Не можу оцінити', 'unknown'],
        ],
        {
          optional: true,
          period: 'retrospective_comparison',
          help: 'Власна оцінка. Це не дві окремі виміряні точки.',
        },
      ),
    ],
  },
  {
    id: 'work',
    title: 'Навантаження на роботі',
    fields: [
      one(
        'workLoadV3',
        'Як відчувалося навантаження?',
        [
          ...levels(['Дуже легке', 'Легке', 'Помірне', 'Значне', 'Дуже значне']),
          ['Важко оцінити', 'unknown'],
        ],
        { optional: true, period: 'whole_day' },
      ),
      one(
        'workBreaksV3',
        'Перерви протягом роботи',
        [
          ['Були', 'yes'],
          ['Майже не було', 'no'],
          ['Не пам’ятаю', 'unknown'],
        ],
        { optional: true, period: 'whole_day' },
      ),
    ],
  },
];

/** @param {Field} f @param {KvBlob} a */
export function fieldVisibleV3(f, a) {
  if (!f.when) return true;
  const v = a[f.when.key];
  return Array.isArray(v)
    ? v.some((x) => f.when?.values?.includes(x))
    : (f.when.values ?? []).includes(v);
}
/** @param {Field} f @param {unknown} value */
export function validValueV3(f, value) {
  if (!validFieldValue(f, value)) return false;
  return (
    !Array.isArray(value) ||
    value.length === 1 ||
    !value.some((x) => ['alone', 'private', 'none', 'unknown'].includes(String(x)))
  );
}
/** @param {KvBlob} records @param {string} date @param {string} slot */
export function adaptiveContext(records, date, slot) {
  const day = records?.[date] ?? {};
  const previousDate = new Date(date + 'T12:00:00Z');
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  const observed = (/** @type {KvBlob} */ a) => (a?.confirmed ? a : {});
  return {
    morning: observed(day.morning),
    previousEvening: observed(records?.[previousDate.toISOString().slice(0, 10)]?.evening),
    previous:
      slot === 'evening'
        ? observed(day.afternoon?.confirmed ? day.afternoon : day.morning)
        : slot === 'afternoon'
          ? observed(day.morning)
          : {},
    activities: [
      ...(observed(day.morning).activitiesV3 ?? []),
      ...(observed(day.afternoon).activitiesV3 ?? []),
    ],
  };
}
/** @param {string} slot @param {KvBlob} a @param {KvBlob} [context] @returns {Card[]} */
export function followupsV3(slot, a, context = {}) {
  const morning = context.morning ?? {};
  const activities = [...(context.activities ?? []), ...(a.activitiesV3 ?? [])];
  const plan = morning.developmentPlanV3,
    actual = a.developmentActualV3;
  const missed =
    (plan === 'both' && actual !== 'both') ||
    (plan === 'learn' && !['learn', 'both'].includes(actual)) ||
    (plan === 'read' && !['read', 'both'].includes(actual));
  const eligible = (/** @type {Card} */ c) => {
    switch (c.id) {
      case 'bedtime':
        return (
          slot === 'morning' &&
          ['main', 'naps'].includes(a.sleepModeV3) &&
          !!context.previousEvening?.bedtimePlanV3
        );
      case 'sleep-poor':
        return (
          slot === 'morning' &&
          ['main', 'naps'].includes(a.sleepModeV3) &&
          [1, 2].includes(a.sleepQualityV3)
        );
      case 'sleep-good':
        return (
          slot === 'morning' &&
          ['main', 'naps'].includes(a.sleepModeV3) &&
          [4, 5].includes(a.sleepQualityV3)
        );
      case 'development-blocked':
        return slot === 'evening' && actual != null && missed;
      case 'plan-blocked':
        return slot === 'afternoon'
          ? ['notstarted', 'external'].includes(a.priorityPaceV3)
          : slot === 'evening' && ['notstarted', 'external'].includes(a.priorityOutcomeV3);
      case 'mood-context':
        return (
          typeof a.mood === 'number' &&
          ([1, 2, 4, 5].includes(a.mood) ||
            (typeof context.previous?.mood === 'number' &&
              Math.abs(a.mood - context.previous.mood) >= 2))
        );
      case 'energy-context':
        return [1, 2].includes(a.energy);
      case 'learning':
        return slot === 'evening' && ['learn', 'read', 'both'].includes(actual);
      case 'reading':
        return false;
      case 'recovery':
        return (
          slot === 'evening' &&
          activities.some((/** @type {string} */ x) => ['rest', 'walk', 'workout'].includes(x))
        );
      case 'work':
        return slot === 'evening' && activities.includes('work');
      default:
        return false;
    }
  };
  // Keep an already answered eligible detail when a later core answer adds a branch.
  const rank = (/** @type {Card} */ c) =>
    c.id === 'learning' ? 3.5 : FOLLOWUP_CARDS_V3.indexOf(c);
  return FOLLOWUP_CARDS_V3.filter(eligible)
    .sort(
      (x, y) =>
        Number(y.fields.some((f) => a[f.id] != null)) -
          Number(x.fields.some((f) => a[f.id] != null)) || rank(x) - rank(y),
    )
    .slice(0, 2);
}
/** @param {string} slot @param {KvBlob} raw */
export function cleanCheckinV3(slot, raw) {
  /** @type {KvBlob} */ const set = {};
  /** @type {string[]} */ const clear = [];
  if (!CHECKIN_CARDS_V3[slot]) return { set, clear };
  for (const f of [...CHECKIN_CARDS_V3[slot], ...FOLLOWUP_CARDS_V3].flatMap((c) => c.fields)) {
    const v = raw[f.id];
    if (v === undefined) continue;
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) clear.push(f.id);
    else if (validValueV3(f, v)) set[f.id] = typeof v === 'string' ? v.trim() : v;
  }
  set.questionVersion = 3;
  return { set, clear };
}
/** @param {string} slot @param {KvBlob} a @param {KvBlob} [context] */
export function clearHiddenV3(slot, a, context = {}) {
  const out = { ...a };
  const shown = followupsV3(slot, out, context);
  const fields = [...(CHECKIN_CARDS_V3[slot] ?? []), ...shown].flatMap((c) => c.fields);
  const allowed = new Set(fields.filter((f) => fieldVisibleV3(f, out)).map((f) => f.id));
  for (const f of [...(CHECKIN_CARDS_V3[slot] ?? []), ...FOLLOWUP_CARDS_V3].flatMap(
    (c) => c.fields,
  ))
    if (!allowed.has(f.id)) delete out[f.id];
  if (out.priorityV3 === 'noplan') delete out.priorityStepV3;
  return out;
}
/** @param {string} slot @param {KvBlob} a */
export function coreCompleteV3(slot, a) {
  return (
    !!CHECKIN_CARDS_V3[slot] &&
    CHECKIN_CARDS_V3[slot].every((c) =>
      c.fields
        .filter((f) => !f.optional && fieldVisibleV3(f, a))
        .every((f) => validValueV3(f, a[f.id])),
    )
  );
}
/** @param {Field} f @param {unknown} value */
export function answerLabelV3(f, value) {
  const label = (/** @type {unknown} */ x) =>
    String(f.options?.find(([, v]) => v === x)?.[0] ?? x ?? '—')
      .split(' :: ')
      .at(-1);
  if (f.type === 'duration' && typeof value === 'number')
    return `${Math.floor(value / 60)} год ${value % 60} хв`;
  return Array.isArray(value) ? value.map(label).join(', ') : label(value);
}
/** @param {unknown} raw */
export function adaptivePreferences(raw) {
  const p = normalizeCheckinPreferences(raw);
  const original = raw && typeof raw === 'object' ? /** @type {KvBlob} */ (raw) : {};
  const oldDefault =
    p.schedule.morning === '08:00' &&
    p.schedule.afternoon === '14:00' &&
    p.schedule.evening === '20:00' &&
    p.schedule.end === '02:00';
  return {
    ...p,
    version: 3,
    schedule:
      !original.schedule || (oldDefault && original.version !== 3)
        ? { morning: '05:00', afternoon: '18:00', evening: '22:00', end: '04:00' }
        : p.schedule,
  };
}

/** Recommended spacing, without forbidding an explicit earlier answer.
 * @param {KvBlob} day @param {string|null} slot @param {number} nowMs */
export function checkinGapV3(day, slot, nowMs) {
  if (!slot || slot === 'morning') return 0;
  const prior = slot === 'evening' ? [day?.afternoon, day?.morning] : [day?.morning];
  const times = prior
    .filter((a) => a?.confirmed)
    .map((a) => Date.parse(a.confirmedAtV3 ?? a.answeredAtV3 ?? a.answeredAtV2 ?? ''))
    .filter((t) => Number.isFinite(t) && t <= nowMs);
  return times.length
    ? Math.max(0, Math.ceil((Math.max(...times) + 180 * 60000 - nowMs) / 60000))
    : 0;
}
