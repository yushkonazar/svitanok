import type { CheckinSlot } from '../../api/schema.ts';

// Питання чек-іну — «трекер життя» (рішення власника 18.07: загальний фокус, не
// пошук роботи). Дзеркало CHECKIN_FIELDS зі stats-core.mjs — значення мусять
// збігатись, інакше сервер мовчки відкине відповідь як невалідну.
//
// Усі відповіді ЗАКРИТІ (число, перелік або набір) свідомо: вільний текст
// неможливо порівняти з учора, а вся цінність чек-іну — у порівнянні.
//
// Структура набору (розширення на базі валідованих інструментів — ESM/EMA,
// Consensus Sleep Diary, NASA-TLX, SDT, daily-diary recovery):
//   • core — коротке щоденне ядро, воно й вважається «блок заповнено»;
//   • deep — розділ «Детальніше», згорнутий за замовчуванням. Туди винесено
//     все, що цінне для аналізу, але не мусить питатись щодня: інакше вечір
//     розростається до 17 питань і звичка вмирає (власник уже казав, що
//     інколи забуває заповнювати — це не абстрактний ризик).
//   • pad — ОДИН тап дає ДВА виміри (енергія×настрій, зусилля×результат):
//     єдиний спосіб подвоїти дані, не подвоївши тертя.

/** Дев'ять життєвих категорій — «головне на сьогодні» і «що зайняло час».
 *  [підпис, значення]; значення дзеркалиться в CHECKIN_FIELDS.plan/ate. */
export const CATEGORIES: Array<[string, string]> = [
  ['💼 Робота/пошук', 'work'],
  ['📚 Навчання', 'learn'],
  ['🛠 Проєкт', 'project'],
  ['🧭 Дорога', 'travel'],
  ['🔁 Побут', 'chores'],
  ['🏃 Спорт', 'sport'],
  ['🌿 Відпочинок', 'rest'],
  ['👥 Люди', 'people'],
  ['🎨 Творчість', 'create'],
];

/** Тип відповіді. `one` — старий одиночний вибір; решта — нові. */
export type QKind = 'one' | 'multi' | 'pad';

export interface Question {
  id: string;
  t: string;
  kind?: QKind;
  /** [підпис, значення]; значення летить на сервер як є. Для `pad` не потрібне. */
  o?: Array<[string, string | number]>;
  /** multi: скільки варіантів максимум (дзеркало `max` у CHECKIN_FIELDS). */
  max?: number;
  /** pad: [id-осі-X, підпис-X, id-осі-Y, підпис-Y]; обидві осі 1..5. */
  pad?: { x: string; xLabel: string; y: string; yLabel: string };
  /** Необовʼязкове — блок вважається заповненим і без нього. */
  soft?: boolean;
  /** Показувати лише в «робочі» дні (головне = work). Ніколи не блокує блок. */
  needsWork?: boolean;
  /** Жити в згорнутому розділі «Детальніше». Завжди неблокуюче. */
  deep?: boolean;
  /** Показувати, лише якщо інша відповідь має одне з цих значень. */
  showIf?: { q: string; in: Array<string | number> };
}

export interface Block {
  id: CheckinSlot;
  ic: string;
  nm: string;
  /** Київська година, з якої блок відкритий (кінець = початок наступного). */
  from: number;
  qs: Question[];
}

/**
 * Пад «енергія × настрій» — активація та валентність окремо (модель афекту:
 * це дві ОРТОГОНАЛЬНІ осі, а не одна шкала). Доти мірялась лише енергія, тож
 * «виснажений але задоволений» і «бадьорий але роздратований» зливались в
 * одне число. Один тап по сітці дає обидва значення.
 */
const AFFECT: Question = {
  id: 'affect',
  t: 'Енергія та настрій зараз',
  kind: 'pad',
  pad: { x: 'mood', xLabel: 'настрій', y: 'energy', yLabel: 'енергія' },
};

/** Межі — рішення власника: 08:00 / 14:00 / 20:00; вечір іде до 02:00. */
export const BLOCKS: Block[] = [
  {
    id: 'morning',
    ic: '🌅',
    nm: 'Ранок',
    from: 8,
    qs: [
      {
        id: 'sleepH',
        t: 'Скільки годин ти спав?',
        // Діапазони НЕ перетинаються. Доти було «<4» і «<5» — друге логічно
        // включало перше, і щоразу треба було вгадувати, який варіант «твій».
        o: [
          ['<4', 3.5],
          ['4–5', 4.5],
          ['5–6', 5.5],
          ['6–7', 6.5],
          ['7–8', 7.5],
          ['8–9', 8.5],
          ['9+', 9.5],
        ],
      },
      {
        // Якість окремо від тривалості (стандарт Consensus Sleep Diary, 1..5):
        // без неї 8 годин поганого сну рахувались «виспаний».
        id: 'sleepQ',
        t: 'Як спалось?',
        o: [
          ['1 · жахливо', 1],
          ['2 · погано', 2],
          ['3 · так собі', 3],
          ['4 · добре', 4],
          ['5 · чудово', 5],
        ],
      },
      {
        id: 'bedtime',
        t: 'О котрій учора ліг?',
        o: [
          ['до 23', 'e23'],
          ['23–00', 'e00'],
          ['00–01', 'e01'],
          ['01–02', 'e02'],
          ['пізніше', 'late'],
        ],
      },
      {
        // Умовне: питається, ЛИШЕ коли лягав пізно, тож у нормальні дні коштує
        // нуль тапів. «Мстива прокрастинація сну» — стресовий день штовхає
        // лягати пізніше, щоб урвати час для себе; без цього поля причина
        // пізнього відбою невідома, а вона різна щоразу.
        id: 'lateReason',
        t: 'Чому так пізно?',
        soft: true,
        showIf: { q: 'bedtime', in: ['e02', 'late'] },
        o: [
          ['Робота/проєкт', 'work'],
          ['Залип у стрічці', 'scroll'],
          ['Хотів час для себе', 'metime'],
          ['Не міг заснути', 'anxious'],
          ['Люди/події', 'social'],
          ['Інше', 'other'],
        ],
      },
      { ...AFFECT },
      {
        id: 'plan',
        t: 'Головне на сьогодні',
        kind: 'multi',
        max: 2,
        o: CATEGORIES,
      },
      {
        // Гейт needsWork знято: у день навчання теж може бути намір подати, і
        // доти його не було куди записати.
        id: 'planApply',
        t: 'Скільки подач плануєш?',
        soft: true,
        o: [
          ['0', 0],
          ['1', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5+', 5],
        ],
      },
      {
        id: 'sleepLatency',
        t: 'Скільки засинав?',
        soft: true,
        deep: true,
        o: [
          ['<15 хв', 'fast'],
          ['15–30', 'mid'],
          ['30–60', 'slow'],
          ['годину+', 'vslow'],
        ],
      },
      {
        id: 'worryAM',
        t: 'Тривожно за сьогодні?',
        soft: true,
        deep: true,
        o: [
          ['1 · зовсім ні', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5 · дуже', 5],
        ],
      },
    ],
  },
  {
    id: 'afternoon',
    ic: '☀️',
    nm: 'Післяобід',
    from: 14,
    qs: [
      {
        // «Збився» розділено: відстаю / роблю інше / перевантажений — це три
        // різні дні з різними висновками, доти вони зливались в один варіант.
        id: 'pace',
        t: 'Як іде день?',
        o: [
          ['📈 За планом', 'on'],
          ['🐢 Відстаю', 'behind'],
          ['🔀 Роблю інше', 'other'],
          ['🥵 Перевантажений', 'overload'],
          ['🚀 Краще', 'better'],
        ],
      },
      { ...AFFECT },
      {
        // Переформульовано: питається о 14:00, тобто про частину доби, а не про
        // весь день. Доти підпис обіцяв підсумок дня, якого о другій ще нема.
        id: 'ate',
        t: 'Що зайняло час досі?',
        kind: 'multi',
        max: 2,
        o: CATEGORIES,
      },
      {
        id: 'rushed',
        t: 'Наскільки кваплений?',
        soft: true,
        deep: true,
        o: [
          ['1 · спокійно', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5 · гнав', 5],
        ],
      },
      {
        id: 'withWhom',
        t: 'З ким переважно був?',
        soft: true,
        deep: true,
        o: [
          ['🧍 Сам', 'alone'],
          ['🏠 Рідні', 'family'],
          ['🫂 Друзі', 'friends'],
          ['💼 По роботі', 'work'],
          ['🏙 Серед людей', 'public'],
          ['🔀 Порівну', 'mixed'],
        ],
      },
    ],
  },
  {
    id: 'evening',
    ic: '🌙',
    nm: 'Вечір',
    from: 20,
    qs: [
      {
        // Словесні якорі замість голих цифр: без них власна шкала пливе за
        // місяці, і тренд «оцінка дня» перестає бути порівнюваним із собою.
        id: 'dayScore',
        t: 'Як пройшов день?',
        o: [
          ['1 · змарнував', 1],
          ['2 · слабко', 2],
          ['3 · нормально', 3],
          ['4 · добре', 4],
          ['5 · чудово', 5],
        ],
      },
      {
        // «Змінив свідомо» відділено від «Ні»: свідома зміна пріоритетів — це
        // не провал, і доти вона псувала статистику дотримання плану.
        id: 'kept',
        t: 'Зробив те, що планував?',
        o: [
          ['✅ Так', 'yes'],
          ['🤏 Частково', 'partly'],
          ['🔄 Змінив свідомо', 'changed'],
          ['❌ Ні', 'no'],
        ],
      },
      { ...AFFECT },
      {
        // Зусилля й результат — РІЗНІ виміри (NASA-TLX). Разом дають квадранти:
        // потік (мало зусиль, багато результату), гриндж (багато зусиль, мало
        // результату), легкий день, застій. Знову один тап на два значення.
        id: 'work2d',
        t: 'Зусилля та результат',
        kind: 'pad',
        pad: { x: 'output', xLabel: 'результат', y: 'effort', yLabel: 'зусилля' },
      },
      {
        id: 'applied',
        t: 'Скільки подач вийшло?',
        soft: true,
        o: [
          ['0', 0],
          ['1', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5+', 5],
        ],
      },
      {
        // Мультивибір: у дня зазвичай не одна перешкода. Список розширено й
        // СПІВСТАВЛЕНО з помічниками нижче, щоб було видно, що спрацювало
        // проти саме цієї перешкоди.
        id: 'blocker',
        t: 'Що завадило?',
        kind: 'multi',
        max: 3,
        soft: true,
        o: [
          ['Втома', 'tired'],
          ['Тривога', 'anxious'],
          ['Не знав з чого', 'stuck'],
          ['Відволікання', 'distract'],
          ['Немає мотивації', 'nomotiv'],
          ['Забагато всього', 'overload'],
          ['Відкладав', 'procrast'],
          ['Чекав на інших', 'waiting'],
          ['Здоровʼя', 'health'],
          ['Зовнішнє', 'external'],
          ['Нічого', 'none'],
        ],
      },
      {
        // Доти помічників було вдвічі менше за перешкоди (5 проти 7) і вони
        // нічому не відповідали. Тепер майже кожній перешкоді є пара:
        // distract↔nodistract, stuck↔smallstep, tired↔move, anxious↔support.
        id: 'helper',
        t: 'Що допомогло?',
        kind: 'multi',
        max: 3,
        soft: true,
        o: [
          ['Ранній старт', 'early'],
          ['Список', 'list'],
          ['Маленький крок', 'smallstep'],
          ['Прибрав відволікання', 'nodistract'],
          ['Рух/прогулянка', 'move'],
          ['Перерви', 'breaks'],
          ['Дедлайн', 'deadline'],
          ['Музика/фокус', 'music'],
          ['Підтримка', 'support'],
          ['Нічого', 'none'],
        ],
      },
      {
        // Єдине поле, чия цінність — у звʼязку із ЗАВТРАШНІМ днем: у daily-diary
        // дослідженнях відновлення ввечері передбачає завтрашню залученість.
        id: 'detached',
        t: 'Вдалось відключитись від справ?',
        o: [
          ['✅ Так', 'yes'],
          ['🤏 Частково', 'partly'],
          ['❌ Ні', 'no'],
        ],
      },
      {
        id: 'moved',
        t: 'Рух сьогодні',
        o: [
          ['🪑 Майже сидів', 'none'],
          ['🚶 Трохи', 'light'],
          ['🏃 Тренування', 'workout'],
        ],
      },
      {
        id: 'rumination',
        t: 'Крутиться в голові?',
        soft: true,
        deep: true,
        o: [
          ['1 · тихо', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5 · не відпускає', 5],
        ],
      },
      {
        id: 'autonomy',
        t: 'День був твій вибір?',
        soft: true,
        deep: true,
        o: [
          ['1 · мною керували', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5 · повністю мій', 5],
        ],
      },
      {
        id: 'outdoor',
        t: 'Час надворі',
        soft: true,
        deep: true,
        o: [
          ['Не виходив', 'none'],
          ['До години', 'short'],
          ['Годину+', 'long'],
        ],
      },
      {
        id: 'screen',
        t: 'Екран поза роботою',
        soft: true,
        deep: true,
        o: [
          ['<1 год', 'low'],
          ['1–3', 'mid'],
          ['3–5', 'high'],
          ['5+', 'vhigh'],
        ],
      },
      {
        id: 'caffeine',
        t: 'Кави/чаю за день',
        soft: true,
        deep: true,
        o: [
          ['0', 0],
          ['1', 1],
          ['2', 2],
          ['3', 3],
          ['4+', 4],
        ],
      },
      {
        id: 'focusQuality',
        t: 'Якість зосередження',
        soft: true,
        deep: true,
        o: [
          ['1 · розсіяно', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5 · глибоко', 5],
        ],
      },
      {
        id: 'jobProgress',
        t: 'Відчуття просування в пошуку',
        soft: true,
        deep: true,
        needsWork: true,
        o: [
          ['1 · стою', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5 · рухаюсь', 5],
        ],
      },
      {
        id: 'jobConfidence',
        t: 'Віриш, що знайдеш?',
        soft: true,
        deep: true,
        needsWork: true,
        o: [
          ['1 · ні', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5 · так', 5],
        ],
      },
      {
        // Без капу нижче кількості варіантів: усі пʼять стріків цілком
        // реально запалити в один день, на відміну від blocker/helper.
        // Підписи без емодзі: справжнє лого бренду малює BrandLogo.tsx.
        id: 'flames',
        t: 'Чи запалив вогники?',
        kind: 'multi',
        max: 5,
        soft: true,
        deep: true,
        o: [
          ['Тікток', 'tiktok'],
          ['Дуолінго', 'duolingo'],
          ['Снепчат', 'snapchat'],
          ['BeReal', 'bereal'],
          ['Шахмати', 'chess'],
        ],
      },
    ],
  },
];

/** «1 питання / 2 питання / 5 питань» — той самий підхід, що pluralizeNova у
 *  новинах (окрема функція на слово, не універсальний утиліт). */
export function pluralizePytannya(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'питання';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'питання';
  return 'питань';
}

/** Значення мультивибору як масив (сервер так само терпить легасі-рядок). */
export function asList(v: unknown): Array<string | number> {
  if (Array.isArray(v)) return v as Array<string | number>;
  return v === undefined || v === null || v === '' ? [] : [v as string | number];
}

/** Чи головне дня — робота/пошук (керує показом опційних джоб-питань). */
export function isWorkDay(dayAnswers: Record<string, unknown> | undefined): boolean {
  return asList(dayAnswers?.plan).includes('work');
}

/** Чи виконана умова showIf цього питання. */
function condMet(q: Question, answers: Record<string, unknown> | undefined): boolean {
  if (!q.showIf) return true;
  const v = answers?.[q.showIf.q];
  return v !== undefined && q.showIf.in.includes(v as string | number);
}

/** Питання блоку, видимі за поточним контекстом (умови + гейт робочого дня). */
export function visibleQuestions(
  b: Block,
  workDay: boolean,
  answers?: Record<string, unknown>,
): Question[] {
  return b.qs.filter((q) => (!q.needsWork || workDay) && condMet(q, answers));
}

/** Питання щоденного ядра — вони й вирішують, чи блок «заповнено». */
export function coreQuestions(
  b: Block,
  workDay: boolean,
  answers?: Record<string, unknown>,
): Question[] {
  return visibleQuestions(b, workDay, answers).filter((q) => !q.deep);
}

/** Питання розділу «Детальніше» — завжди опційні, ніколи не блокують. */
export function deepQuestions(
  b: Block,
  workDay: boolean,
  answers?: Record<string, unknown>,
): Question[] {
  return visibleQuestions(b, workDay, answers).filter((q) => q.deep);
}

/** Чи відповіли на питання (для pad — на обидві осі). */
export function isAnswered(q: Question, answers: Record<string, unknown> | undefined): boolean {
  if (!answers) return false;
  if (q.kind === 'pad' && q.pad) {
    return answers[q.pad.x] !== undefined && answers[q.pad.y] !== undefined;
  }
  if (q.kind === 'multi') return asList(answers[q.id]).length > 0;
  return answers[q.id] !== undefined;
}

/** Блок заповнений, коли відповіли на всі НЕ-soft питання ядра. */
export function isDone(b: Block, answers: Record<string, unknown> | undefined): boolean {
  if (!answers) return false;
  const workDay = isWorkDay(answers);
  return coreQuestions(b, workDay, answers)
    .filter((q) => !q.soft && !q.needsWork)
    .every((q) => isAnswered(q, answers));
}
