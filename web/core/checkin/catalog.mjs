/** Check-in v2: one catalog for the form, validation and descriptive statistics.
 * Changed concepts have new keys. No inferred answer or composite health score. */
/** @typedef {{id:string,label:string,type:'one'|'multi'|'number'|'duration'|'text'|'datetime'|'time'|'categories',options?:[string,string|number][],min?:number,max?:number,limit?:number,optional?:boolean,when?:{key:string,values?:unknown[],positive?:boolean,notValues?:unknown[]},help?:string,period?:string}} Field */
/** @typedef {{id:string,title:string,module?:string,fields:Field[],help?:string}} Card */
/** @typedef {{modules:string[],schedule:{morning:string,afternoon:string,evening:string,end:string},habits:{id:string,name:string,days:number[]}[],categories:{id:string,name:string,group:string}[],hiddenCategories:string[]}} CheckinPreferences */
export const CHECKIN_MODULES = [
  ['sleep', 'Сон детальніше'],
  ['learning', 'Навчання'],
  ['attention', 'Навантаження й увага'],
  ['body', 'Тіло та відновлення'],
  ['support', 'Підтримка'],
  ['habits', 'Мої звички'],
];
export const ACTIVITY_GROUPS = [
  'Робота й розвиток',
  'Повсякденне',
  'Тіло й відновлення',
  'Люди й дозвілля',
];
export const ACTIVITIES = [
  { id: 'taxi', name: 'Таксі', group: ACTIVITY_GROUPS[0] },
  { id: 'work', name: 'Інша робота', group: ACTIVITY_GROUPS[0] },
  { id: 'mate', name: 'Mate Academy', group: ACTIVITY_GROUPS[0] },
  { id: 'learn', name: 'Інше навчання', group: ACTIVITY_GROUPS[0] },
  { id: 'project', name: 'Власний проєкт', group: ACTIVITY_GROUPS[0] },
  { id: 'travel', name: 'Дорога поза роботою', group: ACTIVITY_GROUPS[1] },
  { id: 'chores', name: 'Побут', group: ACTIVITY_GROUPS[1] },
  { id: 'food', name: 'Готування', group: ACTIVITY_GROUPS[1] },
  { id: 'admin', name: 'Адмін / фінансові справи', group: ACTIVITY_GROUPS[1] },
  { id: 'move', name: 'Рух', group: ACTIVITY_GROUPS[2] },
  { id: 'health', name: 'Здоров’я', group: ACTIVITY_GROUPS[2] },
  { id: 'rest', name: 'Відпочинок', group: ACTIVITY_GROUPS[2] },
  { id: 'people', name: 'Люди', group: ACTIVITY_GROUPS[3] },
  { id: 'create', name: 'Творчість', group: ACTIVITY_GROUPS[3] },
  { id: 'games', name: 'Ігри', group: ACTIVITY_GROUPS[3] },
  { id: 'content', name: 'Перегляд контенту', group: ACTIVITY_GROUPS[3] },
];
/** @type {CheckinPreferences} */
export const DEFAULT_CHECKIN_PREFERENCES = {
  modules: ['sleep', 'learning', 'attention', 'body', 'support'],
  schedule: { morning: '08:00', afternoon: '14:00', evening: '20:00', end: '02:00' },
  habits: [],
  categories: [],
  hiddenCategories: [],
};
/** @param {unknown} value */
export function minuteOf(value) {
  const m = typeof value === 'string' && /^(\d{2}):(\d{2})$/.exec(value);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
}
/** @param {KvBlob} schedule */
export function validSchedule(schedule) {
  const { morning, afternoon, evening, end } = schedule ?? {};
  const a = minuteOf(morning),
    b = minuteOf(afternoon),
    c = minuteOf(evening),
    d = minuteOf(end);
  return (
    a != null &&
    b != null &&
    c != null &&
    d != null &&
    a < b &&
    b < c &&
    (d <= a || d > c) &&
    b - a >= 60 &&
    c - b >= 60 &&
    (d <= a ? d + 1440 - c : d - c) >= 60
  );
}
/** @param {unknown} raw @returns {CheckinPreferences} */
export function normalizeCheckinPreferences(raw) {
  const r = raw && typeof raw === 'object' ? /** @type {KvBlob} */ (raw) : {};
  const defaults = DEFAULT_CHECKIN_PREFERENCES;
  const ids = CHECKIN_MODULES.map(([id]) => id);
  return {
    modules: Array.isArray(r.modules)
      ? [...new Set(r.modules.filter((/** @type {string} */ id) => ids.includes(id)))]
      : [...defaults.modules],
    schedule: validSchedule(r.schedule)
      ? {
          morning: r.schedule.morning,
          afternoon: r.schedule.afternoon,
          evening: r.schedule.evening,
          end: r.schedule.end,
        }
      : { ...defaults.schedule },
    habits: (Array.isArray(r.habits) ? r.habits : [])
      .filter(
        (/** @type {KvBlob} */ h) =>
          /^[a-z0-9_-]{1,40}$/.test(h?.id) && typeof h.name === 'string' && h.name.trim(),
      )
      .slice(0, 12)
      .map((/** @type {KvBlob} */ h) => ({
        id: h.id,
        name: h.name.trim().slice(0, 80),
        days: [
          ...new Set(
            (Array.isArray(h.days) ? h.days : []).filter(
              (/** @type {number} */ d) => Number.isInteger(d) && d >= 0 && d <= 6,
            ),
          ),
        ],
      })),
    categories: (Array.isArray(r.categories) ? r.categories : [])
      .filter(
        (/** @type {KvBlob} */ c) =>
          /^custom_[a-z0-9_-]{1,32}$/.test(c?.id) &&
          typeof c.name === 'string' &&
          c.name.trim() &&
          ACTIVITY_GROUPS.includes(c.group),
      )
      .slice(0, 20)
      .map((/** @type {KvBlob} */ c) => ({
        id: c.id,
        name: c.name.trim().slice(0, 80),
        group: c.group,
      })),
    hiddenCategories: (Array.isArray(r.hiddenCategories) ? r.hiddenCategories : [])
      .filter((/** @type {string} */ id) => ACTIVITIES.some((c) => c.id === id))
      .slice(0, ACTIVITIES.length),
  };
}
/** @param {number} minute @param {unknown} [prefs] */
export function checkinClock(minute, prefs) {
  const p = normalizeCheckinPreferences(prefs),
    s = p.schedule;
  const a = minuteOf(s.morning) ?? 480,
    b = minuteOf(s.afternoon) ?? 840,
    c = minuteOf(s.evening) ?? 1200,
    d = minuteOf(s.end) ?? 120;
  const overnight = d <= a;
  const slot =
    minute >= a && minute < b
      ? 'morning'
      : minute >= b && minute < c
        ? 'afternoon'
        : (minute >= c && (overnight || minute < d)) || (overnight && minute < d)
          ? 'evening'
          : null;
  const end =
    slot === 'morning'
      ? b
      : slot === 'afternoon'
        ? c
        : slot === 'evening'
          ? overnight && minute >= c
            ? 1440 + d
            : d
          : null;
  const next = [a, b, c].find((t) => t > minute) ?? a + 1440;
  return {
    slot,
    endsIn: end == null ? null : end - minute,
    nextIn: next - minute,
    previousDay: slot === 'evening' && overnight && minute < d,
    schedule: s,
  };
}
/** @param {number} minute @param {unknown} [prefs] */
export function checkinReminder(minute, prefs) {
  const clock = checkinClock(minute, prefs);
  if (!clock.slot) return null;
  const s = clock.schedule,
    start = minuteOf(/** @type {KvBlob} */ (s)[clock.slot]) ?? 0;
  const elapsed = (minute - start + 1440) % 1440;
  // One window per slot: late enough to respond, never outside its configured window.
  const duration = elapsed + (clock.endsIn ?? 0),
    at = Math.min(duration - 30, clock.slot === 'evening' ? 150 : duration - 60);
  if (elapsed < at || elapsed >= at + 30) return null;
  /** @type {Record<string,string>} */ const names = {
    morning: 'ранковий',
    afternoon: 'денний',
    evening: 'вечірній',
  };
  return {
    slot: clock.slot,
    text: `Ще не підтвердив ${names[clock.slot]} чек-ін. Можна завершити зараз.`,
  };
}
/** @param {string[]} labels @returns {[string,number][]} */
const levels = (labels) => labels.map((label, i) => [`${i + 1} · ${label}`, i + 1]);
/** @param {string} id @param {string} label @param {[string,string|number][]} options @param {Partial<Field>} [rest] @returns {Field} */
const one = (id, label, options, rest = {}) => ({ id, label, type: 'one', options, ...rest });
/** @param {string} id @param {string} label @param {Partial<Field>} [rest] @returns {Field} */
const duration = (id, label, rest = {}) => ({
  id,
  label,
  type: 'duration',
  min: 0,
  max: 1440,
  ...rest,
});
/** @param {string} id @param {string} label @param {Partial<Field>} [rest] @returns {Field} */
const text = (id, label, rest = {}) => ({
  id,
  label,
  type: 'text',
  max: 300,
  optional: true,
  ...rest,
});
/** @param {string} id @param {string} label @param {Partial<Field>} [rest] @returns {Field} */
const datetime = (id, label, rest = {}) => ({
  id,
  label,
  type: 'datetime',
  optional: true,
  ...rest,
});
/** @param {string} id @param {string} label @param {[string,string|number][]} options @param {Partial<Field>} [rest] @returns {Field} */
const multi = (id, label, options, rest = {}) => ({
  id,
  label,
  type: 'multi',
  options,
  limit: 2,
  optional: true,
  ...rest,
});
/** @type {[string,string|number][]} */
const approximate = [
  ['Вказую точно', 'exact'],
  ['Приблизно', 'approx'],
];
const stress = one(
  'tensionV2',
  'Напруження зараз',
  [
    ['0 · немає', 0],
    ['1 · невелике', 1],
    ['2 · помірне', 2],
    ['3 · сильне', 3],
    ['4 · дуже сильне', 4],
  ],
  { period: 'now' },
);
const sleepy = one(
  'sleepinessV2',
  'Наскільки хочеться спати зараз?',
  [
    ['0 · зовсім ні', 0],
    ['1 · трохи', 1],
    ['2 · помірно', 2],
    ['3 · сильно', 3],
    ['4 · дуже сильно', 4],
  ],
  { optional: true, period: 'now' },
);
/** @type {Card} */
const affect = {
  id: 'affect',
  title: 'Енергія й настрій зараз',
  fields: [
    one(
      'energy',
      'Енергія',
      levels(['Сил майже немає', 'Мало сил', 'Помірно', 'Достатньо сил', 'Сил багато']),
      { period: 'now' },
    ),
    one(
      'mood',
      'Настрій',
      levels(['Дуже неприємний', 'Неприємний', 'Нейтральний', 'Приємний', 'Дуже приємний']),
      { period: 'now' },
    ),
  ],
};
/** @type {Card} */
const learning = {
  id: 'learning',
  title: 'Навчання сьогодні',
  module: 'learning',
  fields: [
    duration('learningMinutesV2', 'Час навчання', { optional: true }),
    one('learningPrecisionV2', 'Точність тривалості', approximate, { optional: true }),
    one(
      'comprehensionV2',
      'Наскільки розібрався в матеріалі?',
      [
        ...levels(['Майже не розібрався', 'Трохи', 'Частково', 'Добре', 'Дуже добре']),
        ['Не було нового матеріалу', 'na'],
      ],
      { optional: true, when: { key: 'learningMinutesV2', positive: true } },
    ),
  ],
};
/** @type {Card} */
const focus = {
  id: 'focus',
  title: 'Увага до важливої справи',
  module: 'attention',
  fields: [
    one(
      'focusV2',
      'Як вдавалося зосереджуватися?',
      [
        ...levels(['Дуже важко', 'Важко', 'Посередньо', 'Добре', 'Легко']),
        ['Не було такої справи', 'na'],
      ],
      { optional: true },
    ),
    one(
      'interruptionsV2',
      'Як часто зовнішні переривання заважали?',
      [
        ['Ніколи', 'none'],
        ['Іноді', 'sometimes'],
        ['Часто', 'often'],
        ['Майже постійно', 'constant'],
        ['Не було такої справи', 'na'],
      ],
      { optional: true, help: 'Звичайні замовлення в таксі не є перериваннями навчання.' },
    ),
  ],
};
/** @type {Card} */
const body = {
  id: 'physical',
  title: 'Фізичне самопочуття',
  module: 'body',
  fields: [
    one(
      'physicalV2',
      'Як фізично почуваєшся зараз?',
      levels(['Дуже погано', 'Погано', 'Посередньо', 'Добре', 'Дуже добре']),
      { optional: true, period: 'now' },
    ),
    one(
      'discomfortV2',
      'Що саме відчуваєш?',
      [
        ['Немає дискомфорту', 'none'],
        ['Біль', 'pain'],
        ['Напруження', 'tension'],
        ['Нездужання', 'illness'],
        ['Інше', 'other'],
      ],
      { optional: true },
    ),
    text('discomfortAreaV2', 'Де відчуваєш дискомфорт?', {
      when: { key: 'discomfortV2', values: ['pain', 'tension', 'illness', 'other'] },
    }),
    one(
      'discomfortStrengthV2',
      'Сила дискомфорту',
      [
        ['0', 0],
        ['1', 1],
        ['2', 2],
        ['3', 3],
        ['4', 4],
      ],
      {
        optional: true,
        when: { key: 'discomfortV2', values: ['pain', 'tension', 'illness', 'other'] },
      },
    ),
  ],
};
/** @type {Card} */
const factors = {
  id: 'factors',
  title: 'Що заважало й допомагало?',
  module: 'attention',
  fields: [
    multi('blockersV2', 'Перешкоди — до двох', [
      ['Брак сил', 'fatigue'],
      ['Незрозумілий наступний крок', 'unclear'],
      ['Відволікання', 'distraction'],
      ['Забагато справ', 'overload'],
      ['Думки / напруження', 'tension'],
      ['Фізичний дискомфорт', 'physical'],
      ['Зовнішні обставини', 'external'],
      ['Брак підтримки', 'support'],
      ['Інше', 'other'],
      ['Очікування інших', 'waiting'],
      ['Шум', 'noise'],
      ['Перемикання між справами', 'switching'],
      ['Нічого', 'none'],
      ['Не можу визначити', 'unknown'],
    ]),
    multi('helpersV2', 'Помічники — до двох', [
      ['Зрозумілий наступний крок', 'nextstep'],
      ['План / список', 'plan'],
      ['Умови для фокусу', 'focus'],
      ['Перерва / сон', 'rest'],
      ['Рух', 'movement'],
      ['Підтримка', 'support'],
      ['Нормальне харчування', 'food'],
      ['Інше', 'other'],
      ['Таймер', 'timer'],
      ['Музика', 'music'],
      ['Ранній старт', 'early'],
      ['Нічого', 'none'],
      ['Не можу визначити', 'unknown'],
    ]),
  ],
};
/** @type {Record<string,Card[]>} */
export const CHECKIN_CARDS = {
  morning: [
    {
      id: 'sleep',
      title: 'Сон перед початком дня',
      help: 'Тривалість сну, а не час між відкриттями застосунку.',
      fields: [
        one('sleepModeV2', 'Який сон був?', [
          ['Основний сон', 'main'],
          ['Лише дрімота', 'naps'],
          ['Не спав', 'none'],
        ]),
        duration('sleepMinutesV2', 'Скільки загалом спав?', {
          when: { key: 'sleepModeV2', values: ['main', 'naps'] },
        }),
        one('sleepPrecisionV2', 'Точність тривалості', approximate, {
          when: { key: 'sleepModeV2', values: ['main', 'naps'] },
        }),
      ],
    },
    {
      id: 'quality',
      title: 'Якість цього сну',
      fields: [
        one(
          'sleepQualityV2',
          'Як спалося?',
          levels(['Дуже погано', 'Погано', 'Посередньо', 'Добре', 'Дуже добре']),
          { when: { key: 'sleepModeV2', values: ['main', 'naps'] } },
        ),
      ],
    },
    affect,
    {
      id: 'priority',
      title: 'Що сьогодні найважливіше?',
      fields: [
        { id: 'priorityV2', label: 'Один головний пріоритет', type: 'categories', limit: 1 },
        text('priorityStepV2', 'Конкретний маленький крок'),
        {
          id: 'extraPriorityV2',
          label: 'Ще один пріоритет — за бажанням',
          type: 'categories',
          limit: 1,
          optional: true,
          when: { key: 'priorityV2', notValues: ['noplan', 'unknown'] },
        },
      ],
    },
    {
      id: 'sleep-details',
      title: 'Контекст цього сну',
      module: 'sleep',
      fields: [
        multi('sleepReasonsV2', 'Що завадило спати так, як хотів?', [
          ['Робочий графік', 'work'],
          ['Не міг заснути', 'latency'],
          ['Думки / напруження', 'tension'],
          ['Біль / нездужання', 'health'],
          ['Шум / умови', 'conditions'],
          ['Телефон', 'phone'],
          ['Люди', 'people'],
          ['Зовнішні події', 'external'],
          ['Інше', 'other'],
          ['Нічого', 'none'],
          ['Не пам’ятаю', 'unknown'],
        ]),
        one(
          'sleepLatencyV2',
          'Час від спроби заснути до сну',
          [
            ['До 15 хв', 'lt15'],
            ['15–30 хв', '15_30'],
            ['31–60 хв', '31_60'],
            ['Понад 60 хв', 'gt60'],
            ['Не пам’ятаю', 'unknown'],
          ],
          { optional: true, when: { key: 'sleepModeV2', values: ['main', 'naps'] } },
        ),
        one(
          'awakeningsV2',
          'Пробудження під час цього сну',
          [
            ['0', 0],
            ['1', 1],
            ['2–3', '2_3'],
            ['4+', '4plus'],
            ['Не пам’ятаю', 'unknown'],
          ],
          { optional: true, when: { key: 'sleepModeV2', values: ['main', 'naps'] } },
        ),
        datetime('sleepAttemptV2', 'Коли почав намагатися заснути?', {
          when: { key: 'sleepModeV2', values: ['main', 'naps'] },
        }),
        datetime('sleepWakeV2', 'Коли остаточно прокинувся?', {
          when: { key: 'sleepModeV2', values: ['main', 'naps'] },
        }),
        text('lateSleepReasonV2', 'Якщо ліг пізніше, ніж хотів — що вплинуло?'),
      ],
    },
    { id: 'sleepiness', title: 'Сонливість зараз', module: 'sleep', fields: [sleepy] },
    body,
    {
      id: 'expectations',
      title: 'Очікування від дня',
      module: 'attention',
      fields: [
        one(
          'expectedPleasantV2',
          'Наскільки приємного дня очікуєш?',
          levels([
            'Зовсім не приємного',
            'Мало приємного',
            'Нейтрального',
            'Приємного',
            'Дуже приємного',
          ]),
          { optional: true },
        ),
        one(
          'expectedChoiceV2',
          'Наскільки зможеш обирати, на що витратити час?',
          levels(['Майже не зможу', 'Мало', 'Частково', 'Здебільшого', 'Повністю']),
          { optional: true },
        ),
        one(
          'expectedLoadV2',
          'Скільки справ очікується?',
          levels(['Дуже мало', 'Мало', 'Помірно', 'Багато', 'Дуже багато']),
          { optional: true },
        ),
      ],
    },
    {
      id: 'tension',
      title: 'Напруження зараз',
      module: 'attention',
      fields: [{ ...stress, optional: true }],
    },
  ],
  afternoon: [
    affect,
    { id: 'tension', title: 'Напруження зараз', fields: [stress] },
    {
      id: 'progress',
      title: 'Головний крок протягом дня',
      module: 'attention',
      fields: [
        one(
          'priorityPaceV2',
          'Як зараз із твоїм пріоритетом?',
          [
            ['Як і планував', 'ontrack'],
            ['Повільніше', 'slower'],
            ['Швидше', 'faster'],
            ['Свідомо змінив', 'changed'],
            ['Поки не брався', 'notstarted'],
            ['Без плану', 'noplan'],
          ],
          { optional: true },
        ),
        one(
          'priorityStageV2',
          'На якому етапі головний крок?',
          [
            ['Не почав', 'notstarted'],
            ['У процесі', 'progress'],
            ['Завершив', 'finished'],
            ['Змінив', 'changed'],
            ['Не стосується', 'na'],
          ],
          { optional: true },
        ),
        one(
          'timePressureV2',
          'Брак часу від попереднього чек-іну',
          levels(['Зовсім ні', 'Невеликий', 'Помірний', 'Сильний', 'Дуже сильний']),
          { optional: true, period: 'since_previous' },
        ),
        {
          id: 'currentActivityV2',
          label: 'Що робиш зараз?',
          type: 'categories',
          limit: 1,
          optional: true,
          period: 'now',
        },
      ],
    },
    focus,
    { id: 'sleepiness', title: 'Сонливість зараз', module: 'sleep', fields: [sleepy] },
    body,
    {
      id: 'contact',
      title: 'Контакт і підтримка',
      module: 'support',
      fields: [
        one(
          'contactV2',
          'З ким переважно був?',
          [
            ['Сам', 'alone'],
            ['Партнер', 'partner'],
            ['Родина', 'family'],
            ['Друзі', 'friends'],
            ['Робочі контакти', 'work'],
            ['Різні контакти', 'mixed'],
          ],
          { optional: true },
        ),
        one(
          'supportV2',
          'Чи відчував підтримку?',
          [
            ['Не було потреби', 'notneeded'],
            ['Ні', 'no'],
            ['Частково', 'partial'],
            ['Так', 'yes'],
          ],
          { optional: true },
        ),
      ],
    },
  ],
  evening: [
    affect,
    {
      id: 'satisfaction',
      title: 'Задоволення днем',
      fields: [
        one(
          'satisfactionV2',
          'Наскільки задоволений днем загалом?',
          levels([
            'Зовсім не задоволений',
            'Мало задоволений',
            'Посередньо',
            'Задоволений',
            'Дуже задоволений',
          ]),
        ),
      ],
    },
    {
      id: 'outcome',
      title: 'Результат головного пріоритету',
      fields: [
        one('priorityOutcomeV2', 'Що вийшло з головним кроком?', [
          ['Завершив', 'finished'],
          ['Просунувся', 'progress'],
          ['Не почав', 'notstarted'],
          ['Свідомо змінив', 'changed'],
          ['Не було плану / відпочинок', 'noplan'],
        ]),
      ],
    },
    {
      id: 'activities',
      title: 'Які заняття переважали сьогодні?',
      help: 'До трьох категорій. Це частота занять, а не кількість годин.',
      fields: [{ id: 'activitiesV2', label: 'Основні заняття дня', type: 'categories', limit: 3 }],
    },
    {
      id: 'movement',
      title: 'Рух сьогодні',
      help: 'Рахуй ходьбу та іншу активність. Водіння не є рухом.',
      fields: [
        one('movementRangeV2', 'Скільки активно рухався?', [
          ['0 хв', '0'],
          ['1–15 хв', '1_15'],
          ['16–30 хв', '16_30'],
          ['31–60 хв', '31_60'],
          ['Понад 60 хв', 'gt60'],
        ]),
        duration('movementMinutesV2', 'Точніша тривалість', { optional: true }),
      ],
    },
    learning,
    focus,
    factors,
    {
      id: 'work',
      title: 'Зусилля та результат важливої справи',
      module: 'attention',
      fields: [
        one(
          'effortContextV2',
          'Яка діяльність?',
          [
            ['Робота', 'work'],
            ['Навчання', 'learning'],
            ['Не стосується', 'na'],
          ],
          { optional: true },
        ),
        one(
          'effortV2',
          'Скільки зусиль вклав?',
          levels(['Дуже мало', 'Мало', 'Помірно', 'Багато', 'Дуже багато']),
          { optional: true, when: { key: 'effortContextV2', values: ['work', 'learning'] } },
        ),
        one(
          'resultV2',
          'Наскільки задоволений результатом цієї справи?',
          levels(['Зовсім ні', 'Мало', 'Частково', 'Задоволений', 'Дуже задоволений']),
          { optional: true, when: { key: 'effortContextV2', values: ['work', 'learning'] } },
        ),
      ],
    },
    {
      id: 'switching',
      title: 'Після справ',
      module: 'attention',
      fields: [
        one(
          'detachmentV2',
          'Чи вдалося відключитись від роботи / навчання?',
          [
            ['Так', 'yes'],
            ['Частково', 'partial'],
            ['Ні', 'no'],
            ['Ще працюю', 'working'],
            ['Не було роботи / навчання', 'na'],
          ],
          { optional: true },
        ),
        one(
          'repeatingThoughtsV2',
          'Наскільки важко переключитися від повторюваних думок?',
          levels(['Зовсім не важко', 'Трохи', 'Помірно', 'Важко', 'Дуже важко']),
          { optional: true },
        ),
        one(
          'timeChoiceV2',
          'Наскільки міг обирати, на що витрачати час?',
          levels(['Майже не міг', 'Мало', 'Частково', 'Здебільшого', 'Повністю']),
          { optional: true },
        ),
        { ...stress, optional: true },
      ],
    },
    body,
    {
      id: 'recovery',
      title: 'Відновлення й час надворі',
      module: 'body',
      fields: [
        one(
          'recoveryV2',
          'Відпочинок, після якого відчув відновлення',
          [
            ['Не було відпочинку', 'none'],
            ['Був, без ефекту', 'noeffect'],
            ['Трохи відновив', 'some'],
            ['Добре відновив', 'well'],
            ['Не можу оцінити', 'unknown'],
          ],
          { optional: true },
        ),
        one(
          'outdoorRangeV2',
          'Час надворі поза авто / приміщенням',
          [
            ['0 хв', '0'],
            ['1–15 хв', '1_15'],
            ['16–30 хв', '16_30'],
            ['31–60 хв', '31_60'],
            ['Понад 60 хв', 'gt60'],
          ],
          { optional: true },
        ),
        one(
          'workoutV2',
          'Чи було тренування?',
          [
            ['Ні', 'no'],
            ['Так', 'yes'],
          ],
          { optional: true },
        ),
      ],
    },
    {
      id: 'naps',
      title: 'Додаткова дрімота',
      module: 'sleep',
      help: 'Тільки після сну, вже записаного вранці. Не записуй той самий епізод двічі.',
      fields: [
        one(
          'extraNapV2',
          'Чи дрімав додатково після основного сну?',
          [
            ['Ні', 'no'],
            ['Так', 'yes'],
          ],
          { optional: true },
        ),
        datetime('napStartV2', 'Початок додаткової дрімоти', {
          when: { key: 'extraNapV2', values: ['yes'] },
        }),
        duration('napMinutesV2', 'Приблизна тривалість дрімоти', {
          optional: true,
          when: { key: 'extraNapV2', values: ['yes'] },
        }),
        sleepy,
      ],
    },
    {
      id: 'screen',
      title: 'Екран поза роботою / навчанням',
      module: 'attention',
      fields: [
        duration('leisureScreenMinutesV2', 'Приблизна тривалість', { optional: true }),
        one(
          'leisureScreenIntentV2',
          'Як сприймаєш цей час?',
          [
            ['Заплановане дозвілля', 'planned'],
            ['Довше, ніж хотів', 'longer'],
            ['Не можу оцінити', 'unknown'],
          ],
          { optional: true },
        ),
      ],
    },
    {
      id: 'caffeine',
      title: 'Напої з кофеїном',
      module: 'sleep',
      help: 'Кава, чай, енергетики; декаф не рахуй. Кількість напоїв не дорівнює міліграмам кофеїну.',
      fields: [
        {
          id: 'caffeineCountV2',
          label: 'Кількість напоїв',
          type: 'number',
          min: 0,
          max: 30,
          optional: true,
        },
        {
          id: 'lastCaffeineV2',
          label: 'Час останнього',
          type: 'time',
          optional: true,
          when: { key: 'caffeineCountV2', positive: true },
        },
      ],
    },
    {
      id: 'support',
      title: 'Підтримка й важливий момент',
      module: 'support',
      fields: [
        one(
          'supportV2',
          'Чи відчував сьогодні підтримку?',
          [
            ['Не було потреби', 'notneeded'],
            ['Ні', 'no'],
            ['Частково', 'partial'],
            ['Так', 'yes'],
          ],
          { optional: true },
        ),
        one(
          'contactV2',
          'Тип контакту',
          [
            ['Сам', 'alone'],
            ['Партнер', 'partner'],
            ['Родина', 'family'],
            ['Друзі', 'friends'],
            ['Робочі контакти', 'work'],
            ['Різні контакти', 'mixed'],
          ],
          { optional: true },
        ),
        {
          id: 'momentCategoryV2',
          label: 'Приємне або важливе — категорія',
          type: 'categories',
          limit: 1,
          optional: true,
        },
        text('momentNoteV2', 'Що хочеш запам’ятати?'),
      ],
    },
    {
      id: 'habits',
      title: 'Мої добровільні звички',
      module: 'habits',
      fields: [
        {
          id: 'habitsV2',
          label: 'Які обрані звички виконав?',
          type: 'multi',
          limit: 12,
          optional: true,
          options: [['Сьогодні жодної', 'none']],
        },
      ],
    },
  ],
};
/** @param {Field} field @param {KvBlob} answers */
export function fieldVisible(field, answers) {
  if (!field.when) return true;
  if (field.when.notValues)
    return (
      answers[field.when.key] != null && !field.when.notValues.includes(answers[field.when.key])
    );
  return field.when.positive
    ? typeof answers[field.when.key] === 'number' && answers[field.when.key] > 0
    : (field.when.values ?? []).includes(answers[field.when.key]);
}
/** @param {Field} field @param {unknown} value */
export function validFieldValue(field, value) {
  if (value == null) return false;
  if (field.type === 'number' || field.type === 'duration')
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= (field.min ?? 0) &&
      value <= (field.max ?? 1440)
    );
  if (field.type === 'text')
    return (
      typeof value === 'string' && value.trim().length > 0 && value.length <= (field.max ?? 300)
    );
  if (field.type === 'datetime')
    return (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + 'Z')) &&
      new Date(value + 'Z').toISOString().slice(0, 16) === value
    );
  if (field.type === 'time') return minuteOf(value) != null;
  if (field.type === 'categories') {
    const values = field.limit === 1 ? [value] : value;
    return (
      Array.isArray(values) &&
      values.length > 0 &&
      values.length <= (field.limit ?? 3) &&
      new Set(values).size === values.length &&
      values.every(
        (v) =>
          typeof v === 'string' &&
          (ACTIVITIES.some((c) => c.id === v) ||
            /^custom_[a-z0-9_-]{1,32}$/.test(v) ||
            (v === 'noplan' && field.id === 'priorityV2') ||
            (v === 'unknown' && field.id !== 'priorityV2')),
      ) &&
      (values.length === 1 || !values.some((v) => v === 'noplan' || v === 'unknown'))
    );
  }
  const ids = (field.options ?? []).map(([, v]) => v);
  if (field.type === 'one') return ids.includes(/** @type {string|number} */ (value));
  if (field.type === 'multi')
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= (field.limit ?? 2) &&
      new Set(value).size === value.length &&
      value.every((v) =>
        field.id === 'habitsV2'
          ? typeof v === 'string' && /^[a-z0-9_-]{1,40}$/.test(v)
          : ids.includes(v),
      ) &&
      (value.length === 1 || !value.some((v) => v === 'none' || v === 'unknown'))
    );
  return false;
}
/** Validate only declared fields; retain explicit clears. @param {string} slot @param {KvBlob} raw */
export function cleanCheckinV2(slot, raw) {
  /** @type {KvBlob} */ const set = {};
  /** @type {string[]} */ const clear = [];
  const cards = CHECKIN_CARDS[slot];
  if (!cards) return { set, clear };
  for (const f of cards.flatMap((c) => c.fields)) {
    const v = raw[f.id];
    if (v === undefined) continue;
    if (v === null || (Array.isArray(v) && v.length === 0) || v === '') {
      clear.push(f.id);
      continue;
    }
    if (validFieldValue(f, v)) set[f.id] = typeof v === 'string' ? v.trim() : v;
  }
  if (raw.questionVersion === 2) set.questionVersion = 2;
  return { set, clear };
}
/** Clear gated values even for non-UI callers. @param {string} slot @param {KvBlob} answers */
export function clearHiddenV2(slot, answers) {
  const copy = { ...answers };
  for (const f of (CHECKIN_CARDS[slot] ?? []).flatMap((c) => c.fields))
    if (!fieldVisible(f, copy)) delete copy[f.id];
  if (typeof copy.movementMinutesV2 === 'number') {
    const m = copy.movementMinutesV2;
    copy.movementRangeV2 =
      m === 0 ? '0' : m <= 15 ? '1_15' : m <= 30 ? '16_30' : m <= 60 ? '31_60' : 'gt60';
  }
  if (copy.sleepModeV2 === 'none') {
    delete copy.sleepMinutesV2;
    delete copy.sleepPrecisionV2;
    delete copy.sleepQualityV2;
  }
  if (copy.priorityV2 === 'noplan') {
    delete copy.priorityStepV2;
    delete copy.extraPriorityV2;
  }
  return copy;
}
/** @param {string} slot @param {KvBlob} answers */
export function coreCompleteV2(slot, answers) {
  const cards = CHECKIN_CARDS[slot];
  return (
    !!cards &&
    cards
      .filter((c) => !c.module)
      .every((c) =>
        c.fields
          .filter((f) => !f.optional && fieldVisible(f, answers))
          .every((f) => validFieldValue(f, answers[f.id])),
      ) &&
    !(slot === 'morning' && answers.sleepModeV2 !== 'none' && !(answers.sleepMinutesV2 > 0))
  );
}
