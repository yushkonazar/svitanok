import type { CheckinSlot } from '../../api/schema.ts';

// Питання чек-іну — «трекер життя» (рішення власника 18.07: загальний фокус, не
// пошук роботи). Дзеркало CHECKIN_FIELDS зі stats-core.mjs — значення мусять
// збігатись, інакше сервер мовчки відкине відповідь як невалідну.
//
// Усі відповіді ЗАКРИТІ (число або перелік) свідомо: вільний текст неможливо
// порівняти з учора, а вся цінність чек-іну — у порівнянні.
//
// Джоб-числа (planApply/applied) — ОПЦІЙНІ: показуються, лише коли головне дня =
// «Робота/пошук» (needsWork), і НІКОЛИ не блокують завершення блоку. Так пошук
// роботи лишається однією з категорій життя, а не фокусом усього чек-іну.

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

export interface Question {
  id: string;
  t: string;
  /** [підпис, значення]; значення летить на сервер як є. */
  o: Array<[string, string | number]>;
  /** Необовʼязкове — блок вважається заповненим і без нього. */
  soft?: boolean;
  /** Показувати лише в «робочі» дні (головне = work). Ніколи не блокує блок. */
  needsWork?: boolean;
}

export interface Block {
  id: CheckinSlot;
  ic: string;
  nm: string;
  /** Київська година, з якої блок відкритий (кінець = початок наступного). */
  from: number;
  qs: Question[];
}

const ENERGY: Question = {
  id: 'energy',
  t: 'Енергія зараз',
  o: [
    ['😴', 1],
    ['😑', 2],
    ['🙂', 3],
    ['💪', 4],
    ['🔥', 5],
  ],
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
        o: [
          ['<4', 3.5],
          ['<5', 4.5],
          ['5–6', 5.5],
          ['6–7', 6.5],
          ['7–8', 7.5],
          ['8–9', 8.5],
          ['9+', 9.5],
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
      { ...ENERGY, t: 'Як почуваєшся зараз?' },
      {
        id: 'plan',
        t: 'Головне на сьогодні',
        o: CATEGORIES,
      },
      {
        id: 'planApply',
        t: 'Скільки подач плануєш?',
        soft: true,
        needsWork: true,
        o: [
          ['0', 0],
          ['1', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5+', 5],
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
        id: 'pace',
        t: 'Як іде день?',
        o: [
          ['📈 За планом', 'on'],
          ['😐 Збився', 'off'],
          ['🚀 Краще', 'better'],
        ],
      },
      { ...ENERGY },
      {
        id: 'ate',
        t: 'Що зайняло найбільше часу?',
        o: CATEGORIES,
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
        id: 'dayScore',
        t: 'Як пройшов день?',
        o: [
          ['1', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5', 5],
        ],
      },
      {
        id: 'kept',
        t: 'Зробив те, що планував?',
        o: [
          ['✅ Так', 'yes'],
          ['🤏 Частково', 'partly'],
          ['❌ Ні', 'no'],
        ],
      },
      {
        id: 'applied',
        t: 'Скільки подач вийшло?',
        soft: true,
        needsWork: true,
        o: [
          ['0', 0],
          ['1', 1],
          ['2', 2],
          ['3', 3],
          ['4', 4],
          ['5+', 5],
        ],
      },
      { ...ENERGY },
      {
        id: 'blocker',
        t: 'Що завадило? (можна пропустити)',
        soft: true,
        o: [
          ['Втома', 'tired'],
          ['Тривога', 'anxious'],
          ['Не знав з чого', 'stuck'],
          ['Відволікання', 'distract'],
          ['Здоровʼя', 'health'],
          ['Зовнішнє', 'external'],
          ['Нічого', 'none'],
        ],
      },
      {
        id: 'helper',
        t: 'Що допомогло? (можна пропустити)',
        soft: true,
        o: [
          ['Ранній старт', 'early'],
          ['Список', 'list'],
          ['Перерви', 'breaks'],
          ['Підтримка', 'support'],
          ['Нічого', 'none'],
        ],
      },
    ],
  },
];

/** Чи головне дня — робота/пошук (керує показом опційних джоб-чисел). */
export function isWorkDay(dayAnswers: Record<string, unknown> | undefined): boolean {
  return dayAnswers?.plan === 'work';
}

/** Питання блоку, видимі за поточним контекстом (ховаємо джоб-числа не в роб.дні). */
export function visibleQuestions(b: Block, workDay: boolean): Question[] {
  return b.qs.filter((q) => !q.needsWork || workDay);
}

/** Блок заповнений, коли відповіли на всі НЕ-soft і НЕ-needsWork питання. */
export function isDone(b: Block, answers: Record<string, unknown> | undefined): boolean {
  if (!answers) return false;
  return b.qs.filter((q) => !q.soft && !q.needsWork).every((q) => answers[q.id] !== undefined);
}
