import { CHECKIN_CARDS_V3, FOLLOWUP_CARDS_V3, fieldVisibleV3, validValueV3 } from './adaptive.mjs';
import { kyivParts, shiftDate } from '../finance/planning.mjs';
import { CHECKIN_FLOW_REVISION, STATE_RATING_LABELS, coarseRatingV4 } from './state-ratings.mjs';
import {
  activeChoiceScopes,
  resolveFieldChoices,
  normalizeChoiceCatalog,
  choiceAnswerLabel,
} from './choices.mjs';
export { adaptivePreferences, checkinGapV3, answerLabelV3 as answerLabelV4 } from './adaptive.mjs';
/** @typedef {import('./catalog.mjs').Field} Field */
/** @typedef {import('./catalog.mjs').Card} Card */
const key4 = (/** @type {string} */ id) => id.replace(/V3$/, 'V4');
/** Versioned copies keep historical labels and the meaning of combined learning intact. @param {Card} card @returns {Card} */
const copy = (card) => ({
  ...card,
  fields: card.fields.map((f) => ({
    ...f,
    id: key4(f.id),
    options: f.options?.map(([l, v]) => [l, v]),
    when: f.when ? { ...f.when, key: key4(f.when.key) } : undefined,
    ...(f.type === 'multi' ? { limit: 3 } : {}),
  })),
});
/** @param {string} id @param {string} label @param {[string,string|number][]} options @param {Partial<Field>} [extra] @returns {Field} */
const one = (id, label, options, extra = {}) => ({ id, label, type: 'one', options, ...extra });
/** @param {string} id @param {string} label @param {[string,string|number][]} options @param {Partial<Field>} [extra] @returns {Field} */
const multi = (id, label, options, extra = {}) => ({
  id,
  label,
  type: 'multi',
  options,
  limit: 3,
  optional: true,
  ...extra,
});
/** @param {string} id @param {string} label @param {Partial<Field>} [extra] @returns {Field} */
const text = (id, label, extra = {}) => ({
  id,
  label,
  type: 'text',
  max: 180,
  optional: true,
  ...extra,
});
/** @param {string[]} labels @returns {[string,number][]} */
const levels = (labels) => labels.map((s, i) => [`${i + 1} · ${s}`, i + 1]);
/** @type {[string,string|number][]} */
export const DEVELOPMENT_OPTIONS_V4 = [
  ['Навчання', 'study'],
  ['Курс', 'course'],
  ['Читання для себе', 'read'],
  ['Нічому з цього', 'none'],
  ['Важко пригадати', 'unknown'],
];
/** @type {[string,string|number][]} */
export const TIME_RANGES_V4 = [
  ['1–14 хв', '1_14'],
  ['15–29 хв', '15_29'],
  ['30–59 хв', '30_59'],
  ['1–менше 2 год', '60_119'],
  ['2–менше 4 год', '120_239'],
  ['4 год або більше', '240_plus'],
  ['Важко оцінити', 'unknown'],
];
/** @type {[string,string|number][]} */
export const ACTIVITY_OPTIONS_V4 = [
  ['Щойно прокинувся', 'woke'],
  ['Збираюся до дня', 'getting_ready'],
  ['Справи й розвиток :: Робота', 'work'],
  ['Справи й розвиток :: Навчання', 'study'],
  ['Справи й розвиток :: Курс', 'course'],
  ['Справи й розвиток :: Читання для себе', 'read'],
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
export const MOOD_OPTIONS_V4 = [
  ['Гарна погода', 'weather_good'],
  ['Приємне спілкування з коханою', 'partner_good'],
  ['Добре виспався', 'slept_well'],
  ['Вдалося спокійно відпочити', 'rest'],
  ['Щось вдалося зробити', 'success'],
  ['Спокійний день без зайвих турбот', 'calm_day'],
  ['Люди :: Приємне спілкування', 'connection'],
  ['Люди :: Час із родиною', 'family'],
  ['Люди :: Зустріч або розмова з друзями', 'friends'],
  ['Люди :: Підтримка', 'support'],
  ['Люди :: Складна розмова з коханою', 'partner_hard'],
  ['Люди :: Не вистачило спілкування з близькими', 'missed_connection'],
  ['Люди :: Самотність', 'loneliness'],
  ['Люди :: Конфлікт', 'conflict'],
  ['Люди :: Неприємна взаємодія', 'interaction'],
  ['Справи :: Добре пройшла робота', 'work_good'],
  ['Справи :: Порадував заробіток або надходження', 'income_good'],
  ['Справи :: Розібрався з навчальним матеріалом', 'study_good'],
  ['Справи :: Добре пройшов урок курсу', 'course_good'],
  ['Справи :: Творчість', 'creativity'],
  ['Справи :: Плани не склалися', 'plans_failed'],
  ['Справи :: Перевантаження', 'overload'],
  ['Справи :: Невизначеність', 'uncertainty'],
  ['Справи :: Розчарування результатом', 'disappointment'],
  ['Справи :: Відволікання', 'distraction'],
  ['Справи :: Вдалося зосередитися', 'focus'],
  ['Тіло й відновлення :: Смачна їжа або улюблений напій', 'food_good'],
  ['Тіло й відновлення :: Улюблена музика', 'music'],
  ['Тіло й відновлення :: Приємна прогулянка', 'walk'],
  ['Тіло й відновлення :: Тренування', 'workout'],
  ['Тіло й відновлення :: Не виспався', 'poor_sleep'],
  ['Тіло й відновлення :: Втомився від роботи чи справ', 'fatigue'],
  ['Тіло й відновлення :: Було мало часу для себе', 'little_time'],
  ['Тіло й відновлення :: Нездужання або біль', 'health'],
  ['Тіло й відновлення :: Пропустив їжу', 'missed_food'],
  ['Обставини :: Переживання через гроші', 'money'],
  ['Обставини :: Погана для мене погода', 'weather_bad'],
  ['Обставини :: Тривожні новини', 'worrying_news'],
  ['Обставини :: Небезпечні обставини', 'danger'],
  ['Обставини :: Добрі новини', 'good_news'],
  ['Обставини :: Просто хороший настрій, без конкретної події', 'good_no_event'],
  ['Обставини :: Важкий настрій без конкретної події', 'hard_no_event'],
  ['Інше', 'other'],
  ['Нічого виразного', 'none'],
  ['Не знаю', 'unknown'],
];
/** @type {[string,string|number][]} */
const blockers = [
  ['Не вистачило часу', 'time'],
  ['Мало сил', 'fatigue'],
  ['Не знав, із чого почати', 'unclear'],
  ['Відволікався', 'distraction'],
  ['Робота забрала час', 'work'],
  ['Побутові справи забрали час', 'chores'],
  ['Чекав на інших', 'waiting'],
  ['Обрав відпочинок', 'rest'],
  ['Змінилися обставини', 'external'],
  ['Не було потрібних матеріалів або умов', 'resources'],
  ['Змінилося самопочуття', 'health'],
  ['Інше', 'other'],
  ['Не знаю', 'unknown'],
];
/** @type {Record<'morning'|'afternoon'|'evening',Card[]>} */
export const CHECKIN_CARDS_V4 = /** @type {Record<'morning'|'afternoon'|'evening',Card[]>} */ (
  Object.fromEntries(Object.entries(CHECKIN_CARDS_V3).map(([s, cards]) => [s, cards.map(copy)]))
);
/** @type {Card[]} */
export const FOLLOWUP_CARDS_V4 = FOLLOWUP_CARDS_V3.filter(
  (c) => !['learning', 'development-blocked'].includes(c.id),
).map(copy);
/** @param {string} id @returns {Field} */
const field = (id) =>
  [...Object.values(CHECKIN_CARDS_V4).flat(), ...FOLLOWUP_CARDS_V4]
    .flatMap((c) => c.fields)
    .find((f) => f.id === id) ?? /** @type {Field} */ ({});
for (const slot of ['morning', 'afternoon', 'evening']) {
  const cards = CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)];
  const state = cards.find((c) => c.id === 'state');
  if (state) {
    state.fields = state.fields.filter((f) => f.id !== 'satisfactionV4');
    for (const f of state.fields)
      f.label = f.id === 'energy' ? 'Скільки в тебе зараз сил?' : 'Який у тебе зараз настрій?';
  }
  const context = cards.find((c) => c.id === 'context');
  if (context) {
    context.title = slot === 'morning' ? 'Контекст зараз' : 'Що було від попереднього запису';
    context.fields[0] = multi(
      'activitiesV4',
      slot === 'morning'
        ? 'Чим займаєшся зараз? · обери до трьох занять'
        : 'Чим ти переважно займався сьогодні до цього моменту? · обери до трьох занять',
      ACTIVITY_OPTIONS_V4.filter(
        ([, v]) => slot === 'morning' || !['woke', 'getting_ready'].includes(String(v)),
      ),
      { period: slot === 'morning' ? 'now' : 'since_previous' },
    );
    const company = context.fields.find((f) => f.id === 'companyV4');
    if (!company) continue;
    company.optional = true;
    company.limit = 2;
    company.options = [
      ['Сам', 'alone'],
      ['З коханою людиною', 'partner'],
      ['З родиною', 'family'],
      ['З друзями', 'friends'],
      ['З колегами', 'colleagues'],
      ['З клієнтами', 'clients'],
      ['З іншими людьми', 'other'],
      ['Не хочу вказувати', 'private'],
    ];
  }
}
// Morning context is optional and opened inside the state step: three primary steps.
const morningContext = CHECKIN_CARDS_V4.morning.find((c) => c.id === 'context');
if (morningContext) FOLLOWUP_CARDS_V4.push({ ...morningContext, id: 'morning-context' });
CHECKIN_CARDS_V4.morning = CHECKIN_CARDS_V4.morning.filter((c) => c.id !== 'context');
field('sleepModeV4').label = 'Як ти спав перед початком цього дня?';
field('sleepMinutesV4').label = 'Приблизно скільки ти спав?';
CHECKIN_CARDS_V4.morning
  .find((c) => c.id === 'sleep')
  ?.fields.splice(
    1,
    0,
    one(
      'sleepDurationStatusV4',
      'Чи можеш приблизно оцінити тривалість цього сну?',
      [
        ['Так', 'known'],
        ['Не пам’ятаю / важко оцінити', 'unknown'],
      ],
      {
        optional: true,
        period: 'sleep_episode',
        when: { key: 'sleepModeV4', values: ['main', 'naps'] },
      },
    ),
  );
field('sleepQualityV4').label = 'Наскільки відпочив після цього сну?';
field('sleepQualityV4').options = [
  ...levels([
    'Майже не відпочив',
    'Радше не відпочив',
    'Частково відпочив',
    'Добре відпочив',
    'Повністю відпочив',
  ]),
  ['Важко оцінити', 'unknown'],
];
field('priorityV4').label = 'Що для тебе сьогодні головне?';
field('priorityV4').options = [
  ['Робота', 'work'],
  ['Навчання', 'study'],
  ['Курс', 'course'],
  ['Читання для себе', 'read'],
  ['Власний проєкт', 'project'],
  ['Особисті справи', 'personal'],
  ['Близькі люди', 'people'],
  ['Відпочинок', 'rest'],
  ['Подія / поїздка', 'event'],
  ['Інше', 'other'],
  ['Поки без конкретного плану', 'noplan'],
];
field('priorityStepV4').label = 'Що саме хочеш зробити?';
const priority = CHECKIN_CARDS_V4.morning.find((c) => c.id === 'priority');
if (priority)
  priority.fields = priority.fields.map((f) =>
    f.id === 'developmentPlanV4'
      ? multi(
          f.id,
          'Для чого ще хочеш знайти час сьогодні? · до трьох напрямків',
          [
            ['Навчання', 'study'],
            ['Курс', 'course'],
            ['Читання для себе', 'read'],
            ['Поки не планую', 'none'],
            ['Ще не знаю', 'unknown'],
          ],
          {
            period: 'upcoming_day',
            help: 'Навчання — поза окремим курсом; курс — окрема програма. Читання для себе не враховуй вдруге в інших напрямках.',
          },
        )
      : f,
  );
field('priorityPaceV4').label = 'Як справи з тим, що ти запланував на сьогодні?';
field('priorityPaceV4').options = [
  ['Планую почати пізніше', 'later'],
  ['Поки не вдалося почати', 'notstarted'],
  ['Уже дещо зробив', 'progress'],
  ['Завершив', 'finished'],
  ['Вирішив зайнятися іншим', 'changed'],
  ['План змінився через обставини', 'external'],
  ['Сьогодні без конкретного плану', 'noplan'],
];
CHECKIN_CARDS_V4.afternoon
  .find((c) => c.id === 'progress')
  ?.fields.push(
    text('newPriorityV4', 'Що тепер головне?', {
      when: { key: 'priorityPaceV4', values: ['changed', 'external'] },
      period: 'upcoming_day',
    }),
  );
field('priorityOutcomeV4').label = 'Чи вдалося зробити те, що ти запланував?';
field('priorityOutcomeV4').options = [
  ['Так, зробив', 'finished'],
  ['Зробив частину', 'progress'],
  ['Не вдалося почати', 'notstarted'],
  ['Вирішив змінити план', 'changed'],
  ['Плани змінилися через обставини', 'external'],
  ['Конкретного плану не було', 'noplan'],
];
const outcome = CHECKIN_CARDS_V4.evening.find((c) => c.id === 'outcome');
if (outcome)
  outcome.fields = outcome.fields.map((f) =>
    f.id === 'developmentActualV4'
      ? multi(
          f.id,
          'Яким із цих занять ти сьогодні приділив час? · обери до трьох',
          DEVELOPMENT_OPTIONS_V4,
          {
            optional: false,
            period: 'whole_day',
            help: 'Навчання, курс і читання для себе — окремі заняття. Не рахуй один і той самий час двічі.',
          },
        )
      : f,
  );
field('freeTimeV4').label = 'Скільки вільного часу сьогодні було у твоєму розпорядженні?';
field('freeTimeV4').help =
  'За весь день, зокрема між справами: час, яким міг розпорядитися на свій розсуд.';
field('freeTimeV4').options = [
  ['Не було', 'zero'],
  ['1–29 хв', '1_29'],
  ['30–59 хв', '30_59'],
  ['1–менше 2 год', '60_119'],
  ['2–менше 4 год', '120_239'],
  ['4 год або більше', '240_plus'],
  ['Важко оцінити', 'unknown'],
];
CHECKIN_CARDS_V4.evening
  .find((c) => c.id === 'time')
  ?.fields.push(
    one(
      'freeTimeEnoughV4',
      'Чи вистачило тобі цього часу для себе?',
      [
        ['Зовсім не вистачило', 1],
        ['Скоріше не вистачило', 2],
        ['Скоріше вистачило', 3],
        ['Цілком вистачило', 4],
        ['Не було потреби в окремому часі', 'na'],
        ['Важко оцінити', 'unknown'],
      ],
      { optional: true, period: 'whole_day' },
    ),
  );
const final = CHECKIN_CARDS_V4.evening.find((c) => c.id === 'next-sleep');
if (final) {
  final.title = 'День загалом і наступний сон';
  final.fields.unshift(
    copy(CHECKIN_CARDS_V3.evening?.[0] ?? { id: 'state', title: '', fields: [] }).fields.find(
      (f) => f.id === 'satisfactionV4',
    ) ?? one('satisfactionV4', '', []),
  );
  const satisfaction = final.fields.find((f) => f.id === 'satisfactionV4');
  if (satisfaction)
    satisfaction.label = 'Наскільки ти задоволений тим, як пройшов сьогоднішній день?';
  final.fields.push(
    text('dayNoteV4', 'Хочеш щось запам’ятати про цей день?', { max: 400, period: 'whole_day' }),
  );
}
field('bedtimePlanV4').label = 'Наступний основний сон · о котрій плануєш лягти спати?';
field('napV4').label = 'Чи дрімав сьогодні додатково, окрім сну, записаного вранці?';
final?.fields.splice(
  final.fields.findIndex((f) => f.id === 'napMinutesV4'),
  0,
  one(
    'napDurationStatusV4',
    'Чи можеш оцінити тривалість додаткової дрімоти?',
    [
      ['Так', 'known'],
      ['Не пам’ятаю / важко оцінити', 'unknown'],
    ],
    { optional: true, period: 'nap_episode', when: { key: 'napV4', values: ['yes'] } },
  ),
);
field('bedtimeReasonsV4').options = [
  ['Робота', 'work'],
  ['Дорога', 'travel'],
  ['Пізно повернувся додому', 'late_home'],
  ['Побутові справи', 'chores'],
  ['Навчання', 'study'],
  ['Курс', 'course'],
  ['Читання', 'read'],
  ['Спілкування', 'people'],
  ['Ігри / фільм', 'leisure'],
  ['Телефон / стрічка', 'phone'],
  ['Хотів ще трохи часу для себе', 'self_time'],
  ['Пізно вечеряв / готував', 'late_food'],
  ['Непередбачені справи', 'unexpected'],
  ['Не відчував сонливості', 'not_sleepy'],
  ['Інше', 'other'],
  ['Не знаю', 'unknown'],
];
field('sleepBlockersV4').options = [
  ['Мало часу на сон', 'time'],
  ['Пізно повернувся додому', 'late_home'],
  ['Важко заснути', 'latency'],
  ['Прокидався', 'awakenings'],
  ['Думки / напруження', 'thoughts'],
  ['Біль / нездужання', 'health'],
  ['Шум', 'noise'],
  ['Некомфортна температура', 'temperature'],
  ['Повітряна тривога', 'air_alert'],
  ['Телефон перед сном', 'screens'],
  ['Пізня їжа', 'late_food'],
  ['Кофеїн', 'caffeine'],
  ['Незвичний графік', 'schedule'],
  ['Сон у дорозі', 'travel'],
  ['Інше', 'other'],
  ['Не знаю', 'unknown'],
];
field('sleepHelpersV4').options?.push(['Інше', 'other']);
field('moodFactorsV4').options = MOOD_OPTIONS_V4;
field('moodFactorsV4').label =
  'Що, на твою думку, вплинуло на настрій зараз? · обери до трьох основних причин';
field('moodFactorsV4').help = 'Обери причини, які пов’язуєш зі своїм настроєм зараз.';
const energy = FOLLOWUP_CARDS_V4.find((c) => c.id === 'energy-context');
if (energy) {
  energy.title = 'Що пов’язуєш зі своїми силами?';
  energy.fields[0] = multi(
    'energyKindV4',
    'Що саме ти зараз відчуваєш? · обери до двох станів',
    [
      ['Хочеться спати', 'sleepy'],
      ['Фізична втома', 'physical'],
      ['Розумова втома', 'mental'],
      ['Емоційна втома', 'emotional'],
      ['Важко почати справу', 'activation'],
      ['Голод', 'hunger'],
      ['Дискомфорт / нездужання', 'discomfort'],
      ['Важко описати', 'unknown'],
    ],
    { limit: 2, period: 'now', when: { key: 'energy', values: [1, 2, 3] } },
  );
  const factors = field('energyFactorsV4');
  delete factors.when;
  factors.label = 'Що, на твою думку, пов’язано з нестачею сил зараз? · до трьох причин';
  factors.when = { key: 'energy', values: [1, 2, 3] };
  field('energyHelpersV4').options?.push(['Гарна погода', 'weather'], ['Кава / чай', 'coffee']);
  field('energyHelpersV4').when = { key: 'energy', values: [3, 4, 5] };
}
field('priorityReasonsV4').options = blockers;
field('priorityReasonsV4').label = 'Що заважало? · обери до трьох основних причин';
field('priorityHelpersV4').label = 'Що допомагало? · обери до трьох основних причин';
field('priorityChangesV4').label = 'Що змінило плани? · до трьох причин';
/** @type {Record<string,string>} */
export const DIRECTION_LABELS_V4 = { study: 'Навчання', course: 'Курс', read: 'Читання для себе' };
for (const [direction, label] of Object.entries(DIRECTION_LABELS_V4)) {
  FOLLOWUP_CARDS_V4.push({
    id: `missing-${direction}`,
    title: `Не відбулося: ${label.toLowerCase()}`,
    fields: [
      multi(
        `${direction}BlockersV4`,
        `Що змінило плани щодо ${direction === 'course' ? 'курсу' : direction === 'study' ? 'навчання' : 'читання'}? · до трьох причин`,
        blockers,
        { period: 'whole_day' },
      ),
    ],
  });
  const fields = [
    one(
      `${direction}RangeV4`,
      direction === 'course'
        ? 'Приблизно скільки часу ти сьогодні приділив курсу?'
        : direction === 'study'
          ? 'Приблизно скільки часу ти сьогодні навчався поза курсом?'
          : 'Приблизно скільки ти сьогодні читав для себе?',
      TIME_RANGES_V4,
      { optional: true, period: 'whole_day' },
    ),
  ];
  if (direction !== 'read')
    fields.push(
      one(
        `${direction}ComprehensionV4`,
        `Наскільки зрозумілим був матеріал ${direction === 'course' ? 'курсу' : 'навчання'}?`,
        [
          ...levels([
            'Майже не зрозумів',
            'Значна частина складна',
            'Зрозумів основне',
            'Здебільшого зрозумілий',
            'Повністю зрозумілий',
          ]),
          ['Повторював знайоме, нового матеріалу не було', 'na'],
          ['Важко оцінити', 'unknown'],
        ],
        { optional: true, period: 'whole_day' },
      ),
      one(
        `${direction}PracticeV4`,
        'Чи пробував застосувати цей матеріал?',
        [
          ['Самостійно', 'self'],
          ['З підказками', 'help'],
          ['Ще не пробував', 'not_tried'],
          ['Не було потреби', 'na'],
          ['Важко оцінити', 'unknown'],
        ],
        { optional: true, period: 'whole_day' },
      ),
      multi(
        `${direction}ChallengesV4`,
        'Що ускладнювало розуміння? · до трьох причин',
        [
          ['Бракувало попередніх знань', 'foundation'],
          ['Складні пояснення', 'explanation'],
          ['Зависокий темп', 'pace'],
          ['Втома', 'fatigue'],
          ['Відволікання', 'distraction'],
          ['Бракувало практики', 'practice'],
          ['Не було потрібних умов', 'conditions'],
          ['Інше', 'other'],
          ['Не знаю', 'unknown'],
        ],
        { period: 'whole_day' },
      ),
      multi(
        `${direction}HelpersV4`,
        'Що допомагало зрозуміти? · до трьох причин',
        [
          ['Зрозуміле пояснення', 'explanation'],
          ['Приклади', 'examples'],
          ['Власна практика', 'practice'],
          ['Повторення', 'revision'],
          ['Нотатки', 'notes'],
          ['Допомога викладача / наставника', 'mentor'],
          ['Достатньо часу', 'time'],
          ['Інше', 'other'],
          ['Не знаю', 'unknown'],
        ],
        { period: 'whole_day' },
      ),
    );
  FOLLOWUP_CARDS_V4.push({ id: `development-${direction}`, title: label, fields });
}
field('workLoadV4').label = 'Яким для тебе було робоче навантаження сьогодні?';
field('workLoadV4').options = [
  ...levels(['Дуже легким', 'Легким', 'Помірним', 'Важким', 'Дуже важким']),
  ['Важко оцінити', 'unknown'],
];
field('workBreaksV4').label = 'Чи вдавалося робити перерви під час роботи?';
field('workBreaksV4').options = [
  ['Достатньо', 'enough'],
  ['Були, але замало', 'not_enough'],
  ['Майже не було', 'none'],
  ['Працював недовго й не потребував', 'na'],
  ['Не пам’ятаю', 'unknown'],
];
field('workFactorsV4').label =
  'Що на роботі сьогодні вплинуло на твоє самопочуття? · до трьох причин';
delete field('workFactorsV4').when;
field('workFactorsV4').options = [
  ['Багато завдань', 'many_tasks'],
  ['Довга робота', 'duration'],
  ['Термінові справи', 'urgent'],
  ['Фізичне навантаження', 'physical'],
  ['Складне спілкування', 'interaction'],
  ['Несподівані проблеми', 'unexpected'],
  ['Відсутність перерв', 'no_breaks'],
  ['Мало роботи / замовлень', 'few_orders'],
  ['Спокійний темп', 'calm'],
  ['Цікаві завдання', 'interesting'],
  ['Приємні люди', 'people'],
  ['Допомога', 'support'],
  ['Задоволений результатом', 'result'],
  ['Порадував заробіток', 'income'],
  ['Інше', 'other'],
  ['Не знаю', 'unknown'],
];
FOLLOWUP_CARDS_V4.find((c) => c.id === 'work')?.fields.splice(
  1,
  0,
  one(
    'workRangeV4',
    'Скільки приблизно ти сьогодні працював?',
    [
      ['Менше 1 год', 'lt1h'],
      ['1–менше 4 год', '1_4h'],
      ['4–менше 8 год', '4_8h'],
      ['8–менше 12 год', '8_12h'],
      ['12 год або більше', '12_plus'],
      ['Важко оцінити', 'unknown'],
    ],
    { optional: true, period: 'whole_day' },
  ),
);
const recovery = FOLLOWUP_CARDS_V4.find((c) => c.id === 'recovery');
if (recovery)
  recovery.fields.unshift(
    one(
      'recoveryTargetV4',
      'Про що хочеш додати спостереження?',
      [
        ['Прогулянка', 'walk'],
        ['Відпочинок', 'rest'],
        ['Тренування', 'workout'],
      ],
      { optional: true, period: 'whole_day' },
    ),
  );
field('recoveryEffectV4').label = 'Як змінилося твоє самопочуття після цього заняття?';
field('recoveryEffectV4').when = { key: 'recoveryTargetV4', values: ['walk', 'rest', 'workout'] };
/** Fields added in the current flow. The catalog still reads old V4 answers.
 * @type {Set<string>} */
const revisedFields = new Set();
/** @param {Card|undefined} card @param {number} index @param {...Field} fields */
function addRevised(card, index, ...fields) {
  card?.fields.splice(index, 0, ...fields);
  for (const f of fields) revisedFields.add(f.id);
}
/** @param {string} key @param {...string} values */
const when = (key, ...values) => ({ key, values });
/** @param {string} id @param {string} label @param {string} period @param {Field['when']} gate @returns {Field} */
const clock = (id, label, period, gate) => ({ id, label, type: 'time', period, when: gate });
/** @param {string} id @param {string} label @param {string} known @param {string} unknown @param {string} period @param {Field['when']} [gate] */
const knownOr = (id, label, known, unknown, period, gate) =>
  one(
    id,
    label,
    [
      [known, 'known'],
      [unknown, 'unknown'],
    ],
    { period, when: gate },
  );
const isRevised = (/** @type {KvBlob} */ a) => a.flowRevisionV4 === CHECKIN_FLOW_REVISION;

for (const cards of Object.values(CHECKIN_CARDS_V4)) {
  const state = cards.find((c) => c.id === 'state');
  addRevised(
    state,
    0,
    one('energyLevelV4', 'Скільки в тебе зараз сил?', levels(STATE_RATING_LABELS.energy), {
      period: 'now',
    }),
    one('moodLevelV4', 'Який у тебе зараз настрій?', levels(STATE_RATING_LABELS.mood), {
      period: 'now',
    }),
  );
}
const sleep = CHECKIN_CARDS_V4.morning.find((c) => c.id === 'sleep');
addRevised(
  sleep,
  sleep?.fields.length ?? 0,
  one(
    'sleepTimingV4',
    'Який час основного сну пам’ятаєш?',
    [
      ['Коли ліг і коли прокинувся', 'both'],
      ['Тільки коли ліг', 'bedtime'],
      ['Тільки коли прокинувся', 'wake'],
      ['Важко пригадати', 'unknown'],
    ],
    { when: when('sleepModeV4', 'main'), period: 'sleep_episode' },
  ),
  one(
    'sleepBedtimeDayV4',
    'Ти ліг до чи після опівночі?',
    [
      ['Учора, до опівночі', 'previous'],
      ['Сьогодні після опівночі', 'same'],
    ],
    { when: when('sleepTimingV4', 'both', 'bedtime'), period: 'sleep_episode' },
  ),
  clock(
    'sleepBedtimeV4',
    'О котрій ліг спати?',
    'sleep_episode',
    when('sleepTimingV4', 'both', 'bedtime'),
  ),
  clock(
    'sleepWakeV4',
    'О котрій остаточно прокинувся?',
    'sleep_episode',
    when('sleepTimingV4', 'both', 'wake'),
  ),
);
addRevised(
  priority,
  priority?.fields.findIndex((f) => f.id === 'priorityStepV4') ?? 0,
  knownOr(
    'priorityStepStatusV4',
    'Є конкретна справа для цього напряму?',
    'Так, запишу',
    'Ще не визначився',
    'upcoming_day',
  ),
);
const progress = CHECKIN_CARDS_V4.afternoon.find((c) => c.id === 'progress');
addRevised(
  progress,
  1,
  knownOr(
    'newPriorityStatusV4',
    'Ти вже обрав нову головну справу?',
    'Так, запишу',
    'Ще не визначився',
    'upcoming_day',
    when('priorityPaceV4', 'changed', 'external'),
  ),
);
const eveningContext = CHECKIN_CARDS_V4.evening.find((c) => c.id === 'context');
addRevised(
  eveningContext,
  eveningContext?.fields.length ?? 0,
  one(
    'workedTodayV4',
    'Чи працював ти сьогодні?',
    [
      ['Так', 'yes'],
      ['Ні', 'no'],
      ['Важко оцінити', 'unknown'],
    ],
    { period: 'whole_day' },
  ),
  one(
    'homeArrivalStatusV4',
    'Коли повернувся додому після справ за цей день?',
    [
      ['До опівночі цього дня', 'same'],
      ['Після опівночі, вже наступного дня', 'next'],
      ['Увесь день був удома', 'home'],
      ['Ще не повернувся', 'away'],
      ['Важко пригадати', 'unknown'],
    ],
    { period: 'whole_day' },
  ),
  clock(
    'homeArrivalTimeV4',
    'О котрій повернувся додому?',
    'whole_day',
    when('homeArrivalStatusV4', 'same', 'next'),
  ),
);
addRevised(
  final,
  final?.fields.findIndex((f) => f.id === 'bedtimePlanV4') ?? 0,
  knownOr(
    'bedtimePlanStatusV4',
    'Вже знаєш, о котрій плануєш лягти?',
    'Так, вкажу час',
    'Ще не визначився',
    'upcoming_day',
  ),
);
const workCard = FOLLOWUP_CARDS_V4.find((c) => c.id === 'work');
const workRanges = field('workRangeV4').options ?? [];
addRevised(
  workCard,
  1,
  one(
    'workDurationModeV4',
    'Скільки часу ти сьогодні працював?',
    [
      ['Вкажу години й хвилини', 'exact'],
      ['Обрати приблизний діапазон', 'range'],
      ['Важко оцінити', 'unknown'],
    ],
    { period: 'whole_day' },
  ),
  {
    id: 'workMinutesV4',
    label: 'Скільки тривала робота за день?',
    type: 'duration',
    min: 1,
    max: 1440,
    period: 'whole_day',
    when: when('workDurationModeV4', 'exact'),
  },
  one(
    'workEstimateV4',
    'Приблизна тривалість роботи',
    [
      ['Менше години', 'lt1h'],
      ['1–4 години', '1_4h'],
      ['4–8 годин', '4_8h'],
      ['8–12 годин', '8_12h'],
      ['12 годин і більше', '12_plus'],
    ],
    {
      period: 'whole_day',
      when: when('workDurationModeV4', 'range'),
      help: 'Якщо рівно 1, 4, 8 або 12 годин, обери діапазон, що починається з цього числа.',
    },
  ),
);
/** @param {KvBlob} a */
function workRangeFor(a) {
  if (a.workDurationModeV4 === 'range')
    return a.workEstimateV4 !== 'unknown' && workRanges.some(([, id]) => id === a.workEstimateV4)
      ? a.workEstimateV4
      : undefined;
  if (a.workDurationModeV4 === 'unknown') return 'unknown';
  const n = a.workMinutesV4;
  if (a.workDurationModeV4 !== 'exact' || !Number.isInteger(n) || n < 1 || n > 1440) return;
  if (n < 60) return 'lt1h';
  if (n < 240) return '1_4h';
  if (n < 480) return '4_8h';
  return n < 720 ? '8_12h' : '12_plus';
}
// Keep an explicit response available when the proposed reasons don't fit.
for (const c of FOLLOWUP_CARDS_V4)
  for (const f of c.fields)
    if (f.type === 'multi' && f.id !== 'energyKindV4' && !f.options?.some(([, v]) => v === 'none'))
      f.options?.push(['Немає однієї виразної причини', 'none']);
for (const slot of ['afternoon', 'evening']) {
  const c = CHECKIN_CARDS_V4[/** @type {'afternoon'|'evening'} */ (slot)].find(
    (c) => c.id === 'context',
  );
  c?.fields.find((f) => f.id === 'activitiesV4')?.options?.push(['Переважно нічим', 'none']);
}
recovery?.fields
  .find((f) => f.id === 'recoveryTargetV4')
  ?.options?.push(['Важко оцінити', 'unknown']);
// Other is its own optional observation; the parent controls visibility on client AND server.
for (const card of [...Object.values(CHECKIN_CARDS_V4).flat(), ...FOLLOWUP_CARDS_V4]) {
  card.fields = card.fields.flatMap((f) => [
    f,
    ...(f.options?.some(([, v]) => v === 'other')
      ? [
          text(`${f.id}Other`, 'Інше — своїми словами', {
            when: { key: f.id, values: ['other'] },
            period: f.period,
          }),
        ]
      : []),
  ]);
  for (const f of card.fields)
    if (f.type === 'multi' && f.limit === 3 && !/трьох/.test(f.label))
      f.label = f.label.replace(/ · до двох$/, '') + ' · обери до трьох';
}
/** @param {KvBlob} records @param {string} date @param {string} slot */
export function adaptiveContextV4(records, date, slot) {
  const day = records?.[date] ?? {},
    previousDate = new Date(date + 'T12:00:00Z');
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  const observed = (/** @type {KvBlob} */ a) => (a?.confirmed ? a : {});
  return {
    morning: observed(day.morning),
    afternoon: observed(day.afternoon),
    previousEvening: observed(records?.[previousDate.toISOString().slice(0, 10)]?.evening),
    previous:
      slot === 'evening'
        ? observed(day.afternoon?.confirmed ? day.afternoon : day.morning)
        : slot === 'afternoon'
          ? observed(day.morning)
          : {},
    activities: [
      ...(observed(day.morning).activitiesV4 ?? observed(day.morning).activitiesV3 ?? []),
      ...(observed(day.afternoon).activitiesV4 ?? observed(day.afternoon).activitiesV3 ?? []),
    ],
  };
}
/** Only the new, explicit direction is classified. Legacy `learn` is deliberately not inferred. @param {KvBlob} morning @returns {string[]} */
export function plannedDirectionsV4(morning) {
  if (morning?.questionVersion !== 4) return [];
  return [
    ...new Set([
      ...(Object.keys(DIRECTION_LABELS_V4).includes(morning.priorityV4)
        ? [morning.priorityV4]
        : []),
      ...(Array.isArray(morning.developmentPlanV4)
        ? morning.developmentPlanV4.filter((/** @type {string} */ x) => x in DIRECTION_LABELS_V4)
        : []),
    ]),
  ];
}
/** @param {KvBlob} context @returns {{text:string,source:string,at:string|null}} */
export function currentPlanV4(context) {
  const m = context.morning ?? {},
    d = context.afternoon ?? {};
  if (d.questionVersion === 4 && ['changed', 'external'].includes(d.priorityPaceV4))
    return {
      text: d.newPriorityV4 || 'План змінився; нова справа не записана',
      source: 'Денна зміна плану',
      at: d.answerTimesV3?.newPriorityV4 ?? d.confirmedAtV3 ?? null,
    };
  if ([3, 4].includes(m.questionVersion)) {
    const id = m.questionVersion === 4 ? 'priorityV4' : 'priorityV3',
      step = m.questionVersion === 4 ? m.priorityStepV4 : m.priorityStepV3;
    const f =
      m.questionVersion === 4
        ? field(id)
        : CHECKIN_CARDS_V3.morning?.find((c) => c.id === 'priority')?.fields[0];
    if (m[id] && m[id] !== 'noplan' && f)
      return {
        text: step || choiceAnswerLabel(f, m[id], m),
        source: 'Ранковий план',
        at: m.confirmedAtV3 ?? m.answeredAtV3 ?? null,
      };
  }
  return {
    text: 'Записаного плану немає. Можеш оцінити власний план на цей день.',
    source: 'Власна оцінка',
    at: null,
  };
}
/** @param {Card} card @param {KvBlob} a @param {KvBlob} [context] @returns {Card} */
export function contextualCardV4(card, a, context = {}) {
  const c = { ...card, fields: card.fields.map((f) => ({ ...f })) };
  const previousAt = context.previous?.confirmedAtV3 ?? context.previous?.answeredAtV3;
  const time = previousAt
    ? new Date(previousAt).toLocaleTimeString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  if (card.id === 'context' && c.fields[0])
    c.fields[0].label = time
      ? `Чим ти переважно займався від попереднього підтвердженого чек-іну о ${time}? · обери до трьох занять`
      : 'Чим ти переважно займався сьогодні до цього моменту? · обери до трьох занять';
  if (isRevised(a) && card.id === 'context' && markedActivities(a, context).includes('work'))
    c.fields = c.fields.filter((f) => f.id !== 'workedTodayV4');
  if (card.id === 'priority' && a.priorityV4 in DIRECTION_LABELS_V4) {
    const f = c.fields.find((f) => f.id === 'developmentPlanV4');
    if (f) {
      f.label = `${DIRECTION_LABELS_V4[a.priorityV4]} вже в плані. Хочеш додати ще щось?`;
      f.options = f.options
        ?.filter(([, v]) => v !== a.priorityV4)
        .map(([l, v]) => [v === 'none' ? 'Більше нічого не додаю' : l, v]);
    }
  }
  if (card.id === 'bedtime' && c.fields[0])
    c.fields[0].label = `У попередньому вечірньому записі ти планував лягти о ${context.previousEvening?.bedtimePlanV4 ?? context.previousEvening?.bedtimePlanV3}. Чи вдалося?`;
  if (card.id === 'plan-blocked') {
    const result = a.priorityPaceV4 ?? a.priorityOutcomeV4;
    const allowed =
      result === 'progress'
        ? ['priorityReasonsV4', 'priorityHelpersV4']
        : result === 'finished'
          ? ['priorityHelpersV4']
          : result === 'changed'
            ? ['priorityChangesV4']
            : ['priorityReasonsV4'];
    c.fields = c.fields.filter((f) => allowed.some((x) => f.id === x || f.id === `${x}Other`));
    c.title =
      result === 'progress'
        ? 'Що допомагало і що заважало?'
        : result === 'finished'
          ? 'Що допомогло?'
          : 'Обставини плану';
  }
  if (card.id === 'mood-context') c.title = 'Обставини настрою';
  if (isRevised(a) && card.id === 'sleep-poor' && ![1, 2].includes(a.sleepQualityV4)) {
    c.title = 'Що обмежило час на сон?';
    const f = c.fields.find((f) => f.id === 'sleepBlockersV4');
    if (f) f.label = 'Що, на твою думку, скоротило сон? · до трьох причин';
  }
  if (card.id === 'recovery') {
    const recoveryLabels = /** @type {Record<string,string>} */ ({
      walk: 'прогулянки',
      rest: 'відпочинку',
      workout: 'тренування',
    });
    const activity = recoveryLabels[a.recoveryTargetV4];
    const f = c.fields.find((f) => f.id === 'recoveryEffectV4');
    if (f && activity) f.label = `Як змінилося твоє самопочуття після ${activity}?`;
    if (isRevised(a)) {
      const recorded = markedActivities(a, context);
      const target = c.fields.find((f) => f.id === 'recoveryTargetV4');
      if (target)
        target.options = target.options?.filter(
          ([, id]) => id === 'unknown' || recorded.includes(id),
        );
    }
  }
  c.fields = c.fields.map((f) => {
    const resolved = resolveFieldChoices(
      contextualFieldV4(f, a),
      context.choices,
      activeChoiceScopes(f.id, a),
    );
    if (
      isRevised(a) &&
      (f.type !== 'text' || ['priorityStepV4', 'newPriorityV4', 'priorityV4Other'].includes(f.id))
    )
      resolved.optional = false;
    return resolved;
  });
  return c;
}
const positiveMood = new Set([
  'weather_good',
  'partner_good',
  'slept_well',
  'rest',
  'success',
  'calm_day',
  'connection',
  'family',
  'friends',
  'support',
  'work_good',
  'income_good',
  'study_good',
  'course_good',
  'creativity',
  'focus',
  'food_good',
  'music',
  'walk',
  'workout',
  'good_news',
  'good_no_event',
]);
const escapeChoices = new Set(['other', 'none', 'unknown']);
/** Shared by rendering, the choice editor and canonical server cleanup. No expanded list
 * can escape this contextual boundary. @param {Field} field @param {KvBlob} a @returns {Field} */
export function contextualFieldV4(field, a) {
  const f = { ...field };
  /** @param {(id:string|number)=>boolean} keep */
  const filter = (keep) => {
    f.options = f.options?.filter(([, id]) => keep(id));
  };
  if (f.id === 'moodFactorsV4' && typeof a.mood === 'number' && a.mood !== 3) {
    filter(
      (id) =>
        escapeChoices.has(String(id)) ||
        (a.mood >= 4 ? positiveMood.has(String(id)) : !positiveMood.has(String(id))),
    );
    f.label =
      a.mood >= 4
        ? 'Що підтримує твій хороший настрій? · до трьох причин'
        : 'Що пов’язуєш зі складним настроєм зараз? · до трьох причин';
  }
  if (f.id === 'moodFactorsV4' && a.sleepModeV4 === 'none') filter((id) => id !== 'slept_well');
  if (f.id === 'energyHelpersV4' && a.sleepModeV4 === 'none') filter((id) => id !== 'sleep');
  if (f.id === 'energyFactorsV4') {
    const kinds = Array.isArray(a.energyKindV4) ? a.energyKindV4 : [];
    const byKind = /** @type {Record<string,string[]>} */ ({
      sleepy: ['sleep', 'no_breaks', 'many_tasks'],
      physical: ['no_breaks', 'physical_load', 'immobility', 'health', 'sleep'],
      mental: ['no_breaks', 'many_tasks', 'stress', 'distraction', 'sleep'],
      emotional: ['stress', 'many_tasks', 'no_breaks', 'sleep'],
      activation: ['unclear', 'distraction', 'sleep', 'stress'],
      hunger: ['missed_food', 'no_food_time'],
      discomfort: ['health', 'immobility', 'physical_load', 'sleep'],
    });
    if (kinds.length && !kinds.includes('unknown')) {
      const allowed = new Set(kinds.flatMap((/** @type {string} */ k) => byKind[k] ?? []));
      filter((id) => escapeChoices.has(String(id)) || allowed.has(String(id)));
    }
  }
  if (f.id === 'workFactorsV4') {
    const heavyOnly = new Set(['many_tasks', 'duration', 'urgent', 'physical', 'no_breaks']);
    if ([1, 2].includes(a.workLoadV4)) filter((id) => !heavyOnly.has(String(id)));
    if ([4, 5].includes(a.workLoadV4)) filter((id) => !['few_orders', 'calm'].includes(String(id)));
    if (a.workBreaksV4 === 'enough') filter((id) => id !== 'no_breaks');
  }
  for (const direction of ['study', 'course'])
    if (
      f.id === `${direction}HelpersV4` &&
      ['not_tried', 'na'].includes(a[`${direction}PracticeV4`])
    )
      filter((id) => id !== 'practice');
  if (
    f.id === 'workBreaksV4' &&
    ['4_8h', '8_12h', '12_plus'].includes(isRevised(a) ? workRangeFor(a) : a.workRangeV4)
  )
    filter((id) => id !== 'na');
  if (f.id === 'freeTimeEnoughV4' && a.freeTimeV4 === 'zero')
    filter((id) => ![3, 4].includes(Number(id)));
  return f;
}
/** @param {KvBlob} a @param {KvBlob} context @returns {(string|number)[]} */
function markedActivities(a, context) {
  return [
    ...(Array.isArray(context.activities) ? context.activities : []),
    ...(Array.isArray(a.activitiesV4) ? a.activitiesV4 : []),
  ];
}
/** All relevant topics, including those the user may add voluntarily. @param {string} slot @param {KvBlob} a @param {KvBlob} [context] @returns {Card[]} */
export function eligibleFollowupsV4(slot, a, context = {}) {
  const actual = Array.isArray(a.developmentActualV4) ? a.developmentActualV4 : [];
  const plan = plannedDirectionsV4(context.morning ?? {});
  return FOLLOWUP_CARDS_V4.filter((c) => {
    switch (c.id) {
      case 'bedtime':
        return (
          slot === 'morning' &&
          ['main', 'naps'].includes(a.sleepModeV4) &&
          !!(context.previousEvening?.bedtimePlanV4 ?? context.previousEvening?.bedtimePlanV3)
        );
      case 'sleep-poor':
        return (
          slot === 'morning' &&
          ['main', 'naps'].includes(a.sleepModeV4) &&
          ([1, 2].includes(a.sleepQualityV4) ||
            (isRevised(a) &&
              a.sleepModeV4 === 'main' &&
              a.sleepDurationStatusV4 === 'known' &&
              Number.isInteger(a.sleepMinutesV4) &&
              a.sleepMinutesV4 > 0 &&
              a.sleepMinutesV4 < 420))
        );
      case 'sleep-good':
        return (
          slot === 'morning' &&
          ['main', 'naps'].includes(a.sleepModeV4) &&
          [4, 5].includes(a.sleepQualityV4)
        );
      case 'sleep-mixed':
        return (
          slot === 'morning' && ['main', 'naps'].includes(a.sleepModeV4) && a.sleepQualityV4 === 3
        );
      case 'sleep-none':
        return slot === 'morning' && a.sleepModeV4 === 'none';
      case 'morning-context':
        return slot === 'morning' && (!isRevised(a) || coarseRatingV4(a.moodLevelV4) != null);
      case 'mood-context':
        return isRevised(a) ? coarseRatingV4(a.moodLevelV4) != null : typeof a.mood === 'number';
      case 'energy-context':
        return isRevised(a)
          ? coarseRatingV4(a.energyLevelV4) != null
          : typeof a.energy === 'number';
      case 'plan-blocked':
        return (
          (slot === 'afternoon' || slot === 'evening') &&
          ['notstarted', 'progress', 'finished', 'changed', 'external'].includes(
            a.priorityPaceV4 ?? a.priorityOutcomeV4,
          )
        );
      case 'work':
        return (
          slot === 'evening' &&
          (!isRevised(a) ||
            a.workedTodayV4 === 'yes' ||
            markedActivities(a, context).includes('work'))
        );
      case 'recovery':
        return (
          slot === 'evening' &&
          (!isRevised(a) ||
            markedActivities(a, context).some((id) =>
              ['walk', 'rest', 'workout'].includes(String(id)),
            ))
        );
      default:
        return (
          slot === 'evening' &&
          (c.id.startsWith('development-')
            ? actual.includes(c.id.slice(12))
            : c.id.startsWith('missing-') &&
              actual.length > 0 &&
              !actual.includes('unknown') &&
              plan.includes(c.id.slice(8)) &&
              !actual.includes(c.id.slice(8)))
        );
    }
  }).map((c) => contextualCardV4(c, a, context));
}
/** @param {string} slot @param {KvBlob} a @param {KvBlob} [context] */
export function followupsV4(slot, a, context = {}) {
  const eligible = eligibleFollowupsV4(slot, a, context);
  if (isRevised(a)) return eligible;
  const activities = markedActivities(a, context);
  const suggestions = eligible
    .filter(
      (c) =>
        c.id !== 'morning-context' &&
        (c.id !== 'mood-context' || a.mood !== 3) &&
        (c.id !== 'energy-context' || a.energy !== 3) &&
        (c.id !== 'work' || activities.includes('work')) &&
        (c.id !== 'recovery' ||
          activities.some((x) => ['walk', 'rest', 'workout'].includes(String(x)))),
    )
    .sort((a, b) => {
      const rank = (/** @type {Card} */ c) =>
        c.id === 'bedtime'
          ? 0
          : c.id.startsWith('sleep-')
            ? 1
            : c.id.startsWith('missing-')
              ? 2
              : c.id.startsWith('development-')
                ? 3
                : c.id === 'plan-blocked'
                  ? 4
                  : c.id === 'mood-context'
                    ? 5
                    : c.id === 'energy-context'
                      ? 6
                      : 7;
      return rank(a) - rank(b);
    });
  return eligible.filter(
    (c) =>
      suggestions.includes(c) ||
      a.detailTopicsV4?.includes(c.id) ||
      c.fields.some((f) => a[f.id] != null),
  );
}
/** @param {Field} f @param {unknown} value */
export function validValueV4(f, value) {
  return validValueV3(f, value) && (!Array.isArray(value) || new Set(value).size === value.length);
}
/** @param {Field} f @param {KvBlob} a */
export function fieldVisibleV4(f, a) {
  if (revisedFields.has(f.id) && !isRevised(a)) return false;
  if (isRevised(a)) {
    if (['energy', 'mood', 'workRangeV4'].includes(f.id)) return false;
    if (f.id === 'sleepMinutesV4' && a.sleepDurationStatusV4 !== 'known') return false;
    if (f.id === 'napMinutesV4' && a.napDurationStatusV4 !== 'known') return false;
    if (f.id === 'priorityStepStatusV4') return !!a.priorityV4 && a.priorityV4 !== 'noplan';
    if (f.id === 'priorityStepV4')
      return !!a.priorityV4 && a.priorityV4 !== 'noplan' && a.priorityStepStatusV4 === 'known';
    if (f.id === 'developmentPlanV4') return !!a.priorityV4;
    if (f.id === 'newPriorityV4' && a.newPriorityStatusV4 !== 'known') return false;
    if (f.id === 'bedtimePlanV4' && a.bedtimePlanStatusV4 !== 'known') return false;
    if (f.id === 'freeTimeEnoughV4' && a.freeTimeV4 == null) return false;
    if (
      [
        'companyV4',
        'companyV4Other',
        'workedTodayV4',
        'homeArrivalStatusV4',
        'homeArrivalTimeV4',
      ].includes(f.id) &&
      (!Array.isArray(a.activitiesV4) || !a.activitiesV4.length)
    )
      return false;
    if (f.id === 'energyKindV4')
      return coarseRatingV4(a.energyLevelV4) != null && a.energyLevelV4 <= 4;
    if (f.id === 'energyFactorsV4')
      return (
        coarseRatingV4(a.energyLevelV4) != null &&
        a.energyLevelV4 <= 4 &&
        Array.isArray(a.energyKindV4) &&
        a.energyKindV4.length > 0
      );
    if (f.id === 'energyHelpersV4')
      return coarseRatingV4(a.energyLevelV4) != null && a.energyLevelV4 >= 5;
  }
  if (f.id === 'sleepMinutesV4' && a.sleepDurationStatusV4 === 'unknown') return false;
  if (f.id === 'napMinutesV4' && a.napDurationStatusV4 === 'unknown') return false;
  if (f.id === 'energyFactorsV4' && (!Array.isArray(a.energyKindV4) || !a.energyKindV4.length))
    return false;
  if (f.id === 'workFactorsV4' && a.workLoadV4 == null) return false;
  for (const direction of ['study', 'course']) {
    if (
      f.id === `${direction}ChallengesV4` &&
      ![1, 2, 3].includes(a[`${direction}ComprehensionV4`])
    )
      return false;
    if (f.id === `${direction}HelpersV4` && ![3, 4, 5].includes(a[`${direction}ComprehensionV4`]))
      return false;
  }
  return fieldVisibleV3(f, a);
}
/** Calendar date of the next intended sleep, not a measured sleep episode.
 * @param {number} nowMs @param {unknown} time @returns {string|null} */
export function nextSleepDateV4(nowMs, time) {
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const p = kyivParts(nowMs),
    minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return shiftDate(p.date, minutes < p.hour * 60 + p.minute ? 1 : 0);
}
/** @param {string} slot @param {KvBlob} raw @param {unknown} [choices] */
export function cleanCheckinV4(slot, raw, choices) {
  /** @type {KvBlob} */ const set = {};
  /** @type {string[]} */ const clear = [];
  if (!CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)])
    return { set, clear };
  for (const f of [
    ...CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)],
    ...FOLLOWUP_CARDS_V4,
  ].flatMap((c) => c.fields)) {
    const v = raw[f.id];
    if (v === undefined) continue;
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) clear.push(f.id);
    else if (validValueV4(resolveFieldChoices(f, choices), v))
      set[f.id] = typeof v === 'string' ? v.trim() : v;
  }
  if (Array.isArray(raw.detailTopicsV4))
    set.detailTopicsV4 = [
      ...new Set(
        raw.detailTopicsV4.filter((/** @type {unknown} */ x) =>
          FOLLOWUP_CARDS_V4.some((c) => c.id === x),
        ),
      ),
    ];
  if (Array.isArray(raw.visitedStepsV4))
    set.visitedStepsV4 = [
      ...new Set(
        raw.visitedStepsV4.filter((/** @type {unknown} */ x) =>
          CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)].some(
            (c) => c.id === x,
          ),
        ),
      ),
    ];
  set.questionVersion = 4;
  if (isRevised(raw)) set.flowRevisionV4 = CHECKIN_FLOW_REVISION;
  return { set, clear };
}
/** @param {string} slot @param {KvBlob} a @param {KvBlob} [context] */
export function clearHiddenV4(slot, a, context = {}) {
  const out = { ...a };
  if (isRevised(out)) {
    for (const key of ['energy', 'mood']) {
      const value = coarseRatingV4(out[`${key}LevelV4`]);
      if (value == null) delete out[key];
      else out[key] = value;
    }
  }
  let changed;
  do {
    changed = false;
    const eligible = eligibleFollowupsV4(slot, out, context);
    const cards = [
      ...(CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)] ?? []).map((c) =>
        contextualCardV4(c, out, context),
      ),
      ...eligible,
    ];
    const allowed = new Map(
      cards
        .flatMap((c) => c.fields)
        .filter((f) => fieldVisibleV4(f, out))
        .map((f) => [f.id, f]),
    );
    for (const f of [
      ...(CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)] ?? []),
      ...FOLLOWUP_CARDS_V4,
    ].flatMap((c) => c.fields)) {
      if (out[f.id] == null) continue;
      if (isRevised(out) && ['energy', 'mood', 'workRangeV4'].includes(f.id)) continue;
      const current = allowed.get(f.id);
      let value = out[f.id];
      if (current?.type === 'multi' && Array.isArray(value))
        value = value.filter((/** @type {unknown} */ v) =>
          current.options?.some(([, id]) => id === v),
        );
      if (!current || !validValueV4(current, value)) {
        delete out[f.id];
        changed = true;
      } else if (JSON.stringify(value) !== JSON.stringify(out[f.id])) {
        out[f.id] = value;
        changed = true;
      }
    }
    if (Array.isArray(out.detailTopicsV4))
      out.detailTopicsV4 = out.detailTopicsV4.filter((/** @type {string} */ id) =>
        eligible.some((c) => c.id === id),
      );
  } while (changed);
  if (isRevised(out)) {
    const range = workRangeFor(out);
    if (range == null) delete out.workRangeV4;
    else out.workRangeV4 = range;
  }
  if (out.priorityV4 === 'noplan') delete out.priorityStepV4;
  return out;
}
/** @param {string} id @param {string} slot */
function stepFor(id, slot) {
  if (id.startsWith('sleep') || id === 'bedtime') return 'sleep';
  if (id === 'energy-context') return 'energy';
  if (id === 'mood-context' || id === 'morning-context') return 'mood';
  if (id === 'plan-blocked') return slot === 'afternoon' ? 'progress' : 'outcome';
  if (id.startsWith('development-') || id.startsWith('missing-')) return 'outcome';
  return 'context';
}
const primaryFields = /** @type {Record<string,string[]>} */ ({
  sleep: ['sleepModeV4'],
  energy: ['energyLevelV4'],
  mood: ['moodLevelV4'],
  priority: ['priorityV4'],
  context: ['activitiesV4'],
  progress: ['priorityPaceV4'],
  outcome: ['priorityOutcomeV4', 'developmentActualV4'],
  time: ['freeTimeV4'],
  'next-sleep': ['satisfactionV4', 'napV4'],
});
/** @param {string} slot @param {Card[]} followups */
function orderedSteps(slot, followups) {
  const core = CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)] ?? [];
  const steps = core.flatMap((card) =>
    card.id !== 'state'
      ? [card]
      : [
          {
            ...card,
            id: 'energy',
            title: 'Енергія',
            fields: card.fields.filter((f) => f.id === 'energyLevelV4'),
          },
          {
            ...card,
            id: 'mood',
            title: 'Настрій',
            fields: card.fields.filter((f) => f.id === 'moodLevelV4'),
          },
        ],
  );
  return steps.map((card) => ({
    ...card,
    primary: primaryFields[card.id] ?? [],
    followups: followups.filter((c) => stepFor(c.id, slot) === card.id),
  }));
}
/** The same ordered steps drive the form and confirmation.
 * @param {string} slot @param {KvBlob} a @param {KvBlob} [context] */
export function checkinStepsV4(slot, a, context = {}) {
  return orderedSteps(slot, eligibleFollowupsV4(slot, a, context)).map((card) => ({
    ...card,
    ...contextualCardV4(card, a, context),
  }));
}
/** Read existing answers even if prior-day context or a custom option is no longer available.
 * @param {string} slot @param {KvBlob} record */
export function recordedCheckinStepsV4(slot, record) {
  const answered = FOLLOWUP_CARDS_V4.filter(
    (card) =>
      (card.id !== 'morning-context' || slot === 'morning') &&
      card.fields.some((field) => record[field.id] != null),
  );
  return orderedSteps(slot, answered);
}
/** @param {Card & {followups?:Card[]}} card @param {KvBlob} a */
export function checkinStepCompleteV4(card, a) {
  return [card, ...(card.followups ?? [])].every((section) =>
    section.fields.every((f) => f.optional || !fieldVisibleV4(f, a) || validValueV4(f, a[f.id])),
  );
}
/** @param {string} slot @param {KvBlob} a @param {unknown} [choices] @param {KvBlob} [context] */
export function coreCompleteV4(slot, a, choices, context = {}) {
  if (isRevised(a)) {
    const steps = checkinStepsV4(slot, a, { ...context, choices });
    return steps.length > 0 && steps.every((card) => checkinStepCompleteV4(card, a));
  }
  return (
    !!CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)] &&
    CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)].every((c) =>
      c.fields
        .filter((f) => !f.optional && fieldVisibleV4(f, a))
        .every((f) => validValueV4(resolveFieldChoices(f, choices), a[f.id])),
    )
  );
}
/** Freeze the displayed label/category at answer time; catalog edits never rewrite history.
 * @param {string} slot @param {KvBlob} a @param {KvBlob} [context] */
export function choiceSnapshotV4(slot, a, context = {}) {
  /** @type {Record<string,Record<string,string>>} */ const labels = {};
  const cards = [
    ...(CHECKIN_CARDS_V4[/** @type {'morning'|'afternoon'|'evening'} */ (slot)] ?? []),
    ...FOLLOWUP_CARDS_V4,
  ];
  for (const f of cards.map((c) => contextualCardV4(c, a, context)).flatMap((c) => c.fields)) {
    if (!f.options || a[f.id] == null || !fieldVisibleV4(f, a)) continue;
    const selected = Array.isArray(a[f.id]) ? a[f.id] : [a[f.id]];
    for (const id of selected) {
      const label = f.options.find(([, v]) => v === id)?.[0];
      if (label) (labels[f.id] ??= {})[String(id)] = label;
    }
  }
  return {
    optionLabelsV4: labels,
    optionsRevisionV4: normalizeChoiceCatalog(context.choices).revision,
  };
}
