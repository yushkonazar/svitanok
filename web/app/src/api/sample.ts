import type { Stats, HeatmapCell, SavedItem, ArchiveMonth } from './schema.ts';

// Демо-статистика поза Telegram (роадмеп v3, E1) — перенесена 1:1 з
// web/public/index.html SAMPLE_STATS, щоб власник бачив заповнений UI без
// реальних даних. Форма 1:1 відповідає контракту /api/stats.

function sampleHeatmap(): HeatmapCell[] {
  // Детермінований візерунок, вирівняний на понеділок. Рівні l — готові літерали
  // (пораховані за порогами stats-core buildHeatmap), без дублювання формули.
  const out: HeatmapCell[] = [];
  const d = new Date();
  d.setDate(d.getDate() - 83);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const today = new Date();
  // Ключ — ЛОКАЛЬНА дата: toISOString дав би UTC і зсував демо-тултіпи на день.
  const key = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const pattern: [number, number][] = [
    [0, 0],
    [1, 1],
    [3, 2],
    [2, 2],
    [0, 0],
    [4, 3],
    [1, 1],
    [2, 2],
    [7, 4],
    [0, 0],
    [1, 1],
    [5, 3],
    [2, 2],
    [3, 2],
  ];
  for (let i = 0; d <= today; d.setDate(d.getDate() + 1), i++) {
    const [v, l] = pattern[i % pattern.length];
    // Склад суми (opens/mock/news) — детермінований розкид, щоб у демо було
    // видно РІЗНІ за характером дні, а не лише різну «яскравість».
    const o = v === 0 ? 0 : Math.max(1, Math.round(v * 0.4));
    const m = v === 0 ? 0 : i % 3 === 0 ? 1 : 0;
    out.push({ d: key(d), v, l, o, m, n: Math.max(0, v - o - m) });
  }
  return out;
}

/**
 * Демо-тренд утримання: 12 тижнів із видимою динамікою (провал у середині,
 * відновлення в кінці) — інакше на рівному ряді не видно, що графік узагалі
 * щось показує. Останній тиждень частковий (як у житті: він ще триває).
 */
function sampleHabitWeekly() {
  const active = [3, 5, 6, 4, 2, 3, 5, 6, 7, 6, 7, 4];
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 77); // понеділок 12 тижнів тому
  return active.map((a, i) => {
    const week = dayKey(d);
    d.setDate(d.getDate() + 7);
    const days = i === active.length - 1 ? 5 : 7; // поточний тиждень ще не повний
    return { week, active: Math.min(a, days), days, opens: a * 2, mock: a, news: a * 3 };
  });
}

/**
 * Демо-вогники: тижнева композиція з видимою динамікою (той самий принцип,
 * що sampleHabitWeekly) — на старті переважно споживчі, ближче до сьогодні
 * конструктивні (дуолінго/шахи) переважають.
 */
function sampleFlameWeekly() {
  const active = [3, 4, 3, 5, 4, 4, 5, 4, 6, 5, 6, 4];
  // ⚠️ full ЗАВЖДИ помітно менший за active — і це не декор демо, а суть
  // блоку: «хоч один вогник» і «всі пʼять» розходяться в рази, і поки обидва
  // не видно поруч, графік і стрік під ним виглядають як помилка.
  const full = [0, 1, 0, 2, 1, 1, 2, 1, 3, 2, 3, 2];
  const constructive = [1, 1, 1, 2, 1, 2, 3, 2, 4, 3, 4, 3];
  const consumptive = [2, 3, 2, 3, 3, 2, 2, 2, 2, 2, 2, 1];
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 77);
  return active.map((a, i) => {
    const week = dayKey(d);
    d.setDate(d.getDate() + 7);
    const days = i === active.length - 1 ? 5 : 7;
    return {
      week,
      active: Math.min(a, days),
      full: Math.min(full[i]!, days),
      days,
      constructive: constructive[i],
      consumptive: consumptive[i],
    };
  });
}

function sampleFlameStats() {
  return {
    tops: [
      { value: 'duolingo', n: 34 },
      { value: 'tiktok', n: 22 },
      { value: 'chess', n: 14 },
      { value: 'snapchat', n: 9 },
      { value: 'bereal', n: 6 },
    ],
    activeNights: 54,
    streak: 6,
    best: 11,
    weekly: sampleFlameWeekly(),
  };
}

/** ЛОКАЛЬНА дата -> 'YYYY-MM-DD'. toISOString дав би UTC і зсував демо на добу. */
const dayKey = (dt: Date) =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

/**
 * Демо-ряд чек-іну: 24 доби з дірками — саме так це й виглядає в житті, але
 * ДОСИТЬ трислотових діб, щоб «Карта станів» (гейт ≥12 пар енергія×настрій,
 * StateMatrix.tsx) реально показала сітку в демо, а не порожню картку.
 */
function sampleCheckinSeries() {
  const out: Array<{
    d: string;
    sleepH: number | null;
    energy: number | null;
    energyCurve: Array<number | null>;
    moodCurve: Array<number | null>;
    dayScore: number | null;
    slots: number;
  }> = [];
  const d = new Date();
  d.setDate(d.getDate() - 23);
  const sleep = [
    6.5, 7.5, 5.5, 8.5, 6.5, 7.5, 7.5, 5.5, 6.5, 8.5, 7.5, 6.5, 7.5, 6.5, 7, 6, 8, 7.5, 6.5, 7, 8,
    5.5, 7, 6.5,
  ];
  for (let i = 0; i < 24; i++) {
    // Кожен 6-й день пропущений — щоб було видно, що дірки це норма, а не збій.
    if (i % 6 !== 5) {
      const base = Math.round((sleep[i]! - 3) * 10) / 10;
      const three = i % 3 !== 2; // 2 із 3 діб — повний трислотовий запис
      // Форма дня, не лише середнє: у «повні» доби видно спад ранок->вечір,
      // у неповні — дірка null там, де слот не заповнено.
      const clamp = (v: number) => Math.max(1, Math.min(5, Math.round(v)));
      out.push({
        d: dayKey(d),
        sleepH: sleep[i]!,
        energy: base,
        energyCurve: three ? [clamp(base + 1), clamp(base), clamp(base - 1)] : [clamp(base), null, null],
        moodCurve: three ? [clamp(base), clamp(base), clamp(base - 1)] : [null, null, clamp(base)],
        dayScore: i % 3 === 0 ? 4 : 3,
        slots: three ? 3 : 1,
      });
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * Демо гарячого вікна — сирі доби чек-іну з ТЕГАМИ.
 *
 * Глибше за ряд вище (60 діб проти 24) НАВМИСНО: у проді так само, бо ряд
 * тримає 30 діб, а вікно 90. Демо мусить показувати справжнє співвідношення,
 * інакше «карта станів глибша за форму дня» виглядатиме як помилка.
 *
 * Теги не випадкові: погані вечори супроводжуються втомою й пізнім відбоєм,
 * добрі — раннім стартом. Інакше демо показало б рівний шум, тобто рівно те,
 * чого карта й не має показувати, коли звʼязку немає.
 */
function sampleCheckinRaw(): Stats['checkinRaw'] {
  const records: Stats['checkinRaw']['records'] = {};
  const d = new Date();
  d.setDate(d.getDate() - 59);
  const from = dayKey(d);
  for (let i = 0; i < 60; i++) {
    // Кожна 7-ма доба порожня — дірки це норма, а не збій.
    if (i % 7 !== 6) {
      const low = i % 3 === 0; // «важка» доба
      const clamp = (v: number) => Math.max(1, Math.min(5, v));
      records[dayKey(d)] = {
        morning: {
          sleepH: low ? 5.5 : 7.5,
          sleepQ: low ? 2 : 4,
          bedtime: low ? 'e02' : 'e23',
          ...(low ? { lateReason: 'scroll' as const } : {}),
          energy: clamp(low ? 2 : 4),
          mood: clamp(low ? 2 : 4),
          plan: ['work'],
        },
        afternoon: {
          pace: low ? 'behind' : 'on',
          energy: clamp(low ? 2 : 4),
          mood: clamp(low ? 3 : 4),
          withWhom: i % 4 === 0 ? 'alone' : 'friends',
        },
        evening: {
          dayScore: low ? 2 : 4,
          energy: clamp(low ? 1 : 3),
          mood: clamp(low ? 2 : 4),
          // ⚠️ Теги НАВМИСНО не ідеально розділені. Спершу «важкі» доби мали
          // рівно [tired, distract], а «добрі» — рівно [early, list], і
          // деталі клітинки показували «17/17 · норма 0%» у кожному рядку.
          // Виглядало ефектно й учило хибного: у справжніх даних звʼязок
          // ніколи не буває стовідсотковим, а блок мусить показувати саме
          // те, що там буде — часткове перекриття.
          blocker: low
            ? i % 2 === 0
              ? ['tired', 'distract']
              : ['tired']
            : i % 5 === 0
              ? ['procrast']
              : ['none'],
          helper: low ? (i % 4 === 0 ? ['breaks'] : ['none']) : i % 3 === 1 ? ['early'] : ['early', 'list'],
          moved: low ? (i % 3 === 0 ? 'none' : 'light') : i % 2 === 0 ? 'active' : 'workout',
        },
      };
    }
    d.setDate(d.getDate() + 1);
  }
  d.setDate(d.getDate() - 1);
  return { days: 90, from, to: dayKey(d), records };
}


/**
 * Демо-архів: 14 місяців із видимою динамікою.
 *
 * ⚠️ Довший за все інше в демо НАВМИСНО — саме в цьому суть блоку. Решта
 * екрана дивиться на 30-90 діб, а тут єдине місце, де видно рік і більше;
 * показати тут три місяці означало б не показати нічого.
 */
export const SAMPLE_ARCHIVE: ArchiveMonth[] = (() => {
  const out: ArchiveMonth[] = [];
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 13);
  // Сон повільно вирівнюється, оцінка дня росте, активність плаває — щоб було
  // видно, що ряди РІЗНІ, а не один і той самий шум під трьома назвами.
  const sleep = [6.1, 6.0, 6.4, 6.3, 6.8, 6.6, 7.0, 7.1, 6.9, 7.3, 7.2, 7.4, 7.3, 7.5];
  const score = [2.8, 2.9, 3.0, 2.7, 3.1, 3.2, 3.0, 3.4, 3.3, 3.6, 3.5, 3.7, 3.6, 3.8];
  const active = [12, 18, 22, 19, 25, 27, 24, 28, 26, 29, 28, 30, 27, 21];
  for (let i = 0; i < sleep.length; i++) {
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({
      month,
      checkinDays: Math.max(0, active[i]! - 2),
      sleepAvg: sleep[i]!,
      energyAvg: Math.round((2.4 + i * 0.06) * 10) / 10,
      moodAvg: Math.round((2.6 + i * 0.05) * 10) / 10,
      dayScoreAvg: score[i]!,
      activeDays: active[i]!,
      opens: active[i]! * 3,
      mock: Math.round(active[i]! / 3),
      news: active[i]! * 2,
      applied: Math.max(0, Math.round(active[i]! / 4)),
    });
    d.setMonth(d.getMonth() + 1);
  }
  return out;
})();

export const SAMPLE_STATS: Stats = {
  streaks: { openDays: 5, bestOpenDays: 12, mockDays: 4 },
  timeToOpenMin: 23,
  // Розкид ±~35 хв навколо медіани — «ритуал, але не за будильником».
  openRhythm: {
    ready: true,
    n: 46,
    p10: 2,
    q1: 12,
    median: 23,
    q3: 47,
    p90: 78,
    iqr: 35,
    // Демо показує ЗАТИСКАННЯ ритуалу: розкид упав удвічі, медіана трохи
    // зсунулась раніше. Рівні половини сховали б саму картку.
    drift: { early: { n: 23, median: 31, iqr: 48 }, late: { n: 23, median: 20, iqr: 22 } },
  },
  habitWeekly: sampleHabitWeekly(),
  flameStats: sampleFlameStats(),
  weekly: [
    { day: 'Пн', value: 3, active: true },
    { day: 'Вт', value: 2, active: true },
    { day: 'Ср', value: 4, active: true },
    { day: 'Чт', value: 0, active: false },
    { day: 'Пт', value: 5, active: true },
    { day: 'Сб', value: 1, active: true },
    { day: 'Нд', value: 2, active: true },
  ],
  funnel: { saved: 4, applied: 3, interview: 1, offer: 0, rejected: 1, failed: 1 },
  funnelList: [
    {
      url: 'https://example.com/job1',
      stage: 'saved',
      title: 'Junior Frontend (React)',
      ts: '2026-07-06',
      history: [{ stage: 'saved', ts: '2026-07-06' }],
    },
    {
      url: 'https://example.com/job2',
      stage: 'applied',
      title: 'Trainee Full Stack',
      ts: '2026-07-05',
      history: [
        { stage: 'saved', ts: '2026-07-05' },
        { stage: 'applied', ts: '2026-07-08' },
      ],
    },
    {
      url: 'https://example.com/job3',
      stage: 'interview',
      title: 'Node.js Developer',
      ts: '2026-07-04',
      history: [
        { stage: 'saved', ts: '2026-07-04' },
        { stage: 'applied', ts: '2026-07-06' },
        { stage: 'interview', ts: '2026-07-11' },
      ],
    },
    // Термінальні (F1) — щоб демо показувало всі шість лейнів і «Історію».
    {
      url: 'https://example.com/job4',
      stage: 'rejected',
      title: 'React Developer (Middle)',
      ts: '2026-06-28',
      history: [
        { stage: 'saved', ts: '2026-06-28' },
        { stage: 'applied', ts: '2026-06-30' },
        { stage: 'rejected', ts: '2026-07-04' },
      ],
    },
    {
      url: 'https://example.com/job5',
      stage: 'failed',
      title: 'Full Stack Engineer',
      ts: '2026-06-20',
      history: [
        { stage: 'saved', ts: '2026-06-20' },
        { stage: 'applied', ts: '2026-06-22' },
        { stage: 'interview', ts: '2026-07-01' },
        { stage: 'failed', ts: '2026-07-03' },
      ],
    },
  ],
  dismissedUrls: ['https://example.com/job-dismissed'],
  goal: { weeklyTarget: 5, weeklyApplied: 3 },
  // Чесні числа під reached: подались 4 (job2..job5), до співбесіди дійшли 2
  // (job3, job5) -> 50%; зі співбесід 2 офер 0 -> 0%.
  conversion: { appliedToInterview: 50, interviewToOffer: 0 },
  reached: { saved: 5, applied: 4, interview: 2, offer: 0 },
  mockRated: {},
  mockMaterials: {
    Алгоритми: [{ title: 'NeetCode — роадмеп', url: 'https://neetcode.io/roadmap' }],
    Мова: [{ title: 'JavaScript.info (укр)', url: 'https://uk.javascript.info/' }],
  },
  avgFitApplied: 84,
  mock: {
    weakTopics: [
      { name: 'Алгоритми', value: 65 },
      { name: 'Патерни', value: 55 },
      { name: 'HTTP', value: 40 },
    ],
    streak: 4,
    // Свіжіше за all-time weakTopics% — демонструє, що недавно йде краще.
    recentEasyPct: 60,
    // Помітний підйом в останні тижні — щоб демо показувало, що тренд узагалі
    // вміє рухатись; порожні тижні лишені навмисно (n=0 -> null, не нуль).
    easeTrend: [
      { week: '2026-06-22', n: 6, easePct: 33 },
      { week: '2026-06-29', n: 4, easePct: 50 },
      { week: '2026-07-06', n: 0, easePct: null },
      { week: '2026-07-13', n: 5, easePct: 40 },
      { week: '2026-07-20', n: 7, easePct: 57 },
      { week: '2026-07-27', n: 6, easePct: 67 },
      { week: '2026-08-03', n: 8, easePct: 75 },
      { week: '2026-08-10', n: 4, easePct: 75 },
    ],
    recentByTopic: {
      HTTP: { seen: 6, weak: 4 },
      TypeScript: { seen: 5, weak: 3 },
      Мова: { seen: 8, weak: 1 },
    },
  },
  roadmap: { done: 12, total: 74 },
  mastery: {
    // Готовність по темах. Числа підібрані так, щоб демо показувало ВСІ три
    // стани, які блок і має розрізняти: розрив («відмітив, а не дається»),
    // рівний прогрес і теми, яких жодного разу не питали.
    topics: [
      { id: 'frontend', title: '🌐 Frontend основи', done: 7, total: 7, seen: 22, weak: 3, easePct: 86 },
      { id: 'typescript', title: '🟦 TypeScript', done: 5, total: 6, seen: 14, weak: 9, easePct: 36 },
      { id: 'react', title: '⚛️ React', done: 3, total: 6, seen: 18, weak: 6, easePct: 67 },
      { id: 'networking', title: '📡 HTTP / мережі (поглиблено)', done: 4, total: 5, seen: 11, weak: 8, easePct: 27 },
      { id: 'backend', title: '🖥 Backend / Node.js', done: 4, total: 7, seen: 16, weak: 7, easePct: 56 },
      { id: 'databases', title: '🗄 Бази даних', done: 2, total: 6, seen: 9, weak: 4, easePct: 56 },
      { id: 'algorithms', title: '🧮 Алгоритми та структури даних', done: 2, total: 6, seen: 12, weak: 7, easePct: 42 },
      { id: 'security', title: '🔒 Безпека', done: 1, total: 5, seen: 4, weak: 3, easePct: 25 },
      { id: 'ai-dev', title: '🤖 AI у розробці', done: 2, total: 4, seen: 6, weak: 1, easePct: 83 },
      { id: 'testing-adv', title: '🧪 Тестування (поглиблено)', done: 0, total: 5, seen: 0, weak: 0, easePct: null },
      { id: 'tools', title: '🛠 Git / CI', done: 3, total: 5, seen: 0, weak: 0, easePct: null },
      { id: 'ecosystem', title: '📦 Тулінг і екосистема', done: 1, total: 4, seen: 0, weak: 0, easePct: null },
      { id: 'perf-a11y', title: '⚡ Продуктивність і a11y', done: 0, total: 4, seen: 0, weak: 0, easePct: null },
    ],
    themeOfWeek: {
      week: '',
      topicId: 'react',
      title: '⚛️ React',
      done: 3,
      total: 6,
      mockTopics: ['Фреймворк'],
    },
    hints: [
      {
        mockTopic: 'Алгоритми',
        themes: [{ id: 'algorithms', title: '🧮 Алгоритми та структури даних', done: 2, total: 6 }],
      },
      {
        mockTopic: 'Патерни',
        themes: [{ id: 'backend', title: '🖥 Backend / Node.js', done: 4, total: 7 }],
      },
    ],
  },
  interests: [
    { topic: 'Технології', score: 12 },
    { topic: 'Наука', score: 7 },
    { topic: 'Політика', score: 3 },
  ],
  savedCount: 5,
  savedList: [
    { kind: 'question', id: 'q1', title: 'Чим відрізняється let від var?', url: null, ts: '2026-07-08' },
    {
      kind: 'news',
      id: 'https://example.com/news1',
      url: 'https://example.com/news1',
      title: 'Стартап із Києва підняв $2М',
      ts: '2026-07-07',
    },
    { kind: 'quote', id: 'qt1', title: '«Дій, а не бажай» — Марк Аврелій', url: null, ts: '2026-07-06' },
  ],
  readPerDay: 6,
  // 30 днів, один dead-man 9 днів тому — стрік=9 (від наступного дня),
  // рекорд=20 (найдовший забіг до зриву).
  reliability: {
    onTime: 29,
    total: 30,
    deadman: 1,
    streak: 9,
    best: 20,
    days: [
      { d: '2026-06-09', ok: true },
      { d: '2026-06-10', ok: true },
      { d: '2026-06-11', ok: true },
      { d: '2026-06-12', ok: true },
      { d: '2026-06-13', ok: true },
      { d: '2026-06-14', ok: true },
      { d: '2026-06-15', ok: true },
      { d: '2026-06-16', ok: true },
      { d: '2026-06-17', ok: true },
      { d: '2026-06-18', ok: true },
      { d: '2026-06-19', ok: true },
      { d: '2026-06-20', ok: true },
      { d: '2026-06-21', ok: true },
      { d: '2026-06-22', ok: true },
      { d: '2026-06-23', ok: true },
      { d: '2026-06-24', ok: true },
      { d: '2026-06-25', ok: true },
      { d: '2026-06-26', ok: true },
      { d: '2026-06-27', ok: true },
      { d: '2026-06-28', ok: true },
      { d: '2026-06-29', ok: false },
      { d: '2026-06-30', ok: true },
      { d: '2026-07-01', ok: true },
      { d: '2026-07-02', ok: true },
      { d: '2026-07-03', ok: true },
      { d: '2026-07-04', ok: true },
      { d: '2026-07-05', ok: true },
      { d: '2026-07-06', ok: true },
      { d: '2026-07-07', ok: true },
      { d: '2026-07-08', ok: true },
    ],
  },
  heatmap: sampleHeatmap(),
  // Швидкість воронки: демо показує ОБИДВА стани, які блок має розрізняти —
  // крок із медіаною й крок, де переходів ще замало (medianDays: null).
  funnelSpeed: {
    staleAfterDays: 21,
    steps: [
      { from: 'saved' as const, to: 'applied' as const, n: 9, medianDays: 3 },
      { from: 'applied' as const, to: 'interview' as const, n: 4, medianDays: 11 },
      { from: 'interview' as const, to: 'offer' as const, n: 1, medianDays: null },
    ],
    stale: [
      { url: 'https://jobs.example.com/1', stage: 'applied' as const, title: 'Frontend Engineer — Aurora', days: 34 },
      { url: 'https://jobs.example.com/2', stage: 'saved' as const, title: 'React Developer — Northwind', days: 27 },
    ],
  },
  appliedWeekly: [
    { week: '', count: 1 },
    { week: '', count: 2 },
    { week: '', count: 0 },
    { week: '', count: 3 },
    { week: '', count: 2 },
    { week: '', count: 4 },
    { week: '', count: 3 },
    { week: '', count: 5 },
  ],
  // null там, де того тижня подач із fit-оцінкою не було (не 0% — «даних
  // немає», не «поганий fit»).
  fitWeekly: [
    { week: '', avgFit: 70 },
    { week: '', avgFit: null },
    { week: '', avgFit: 75 },
    { week: '', avgFit: 80 },
    { week: '', avgFit: 78 },
    { week: '', avgFit: 82 },
    { week: '', avgFit: 79 },
    { week: '', avgFit: 84 },
  ],
  // 12 тижнів нових завершень роадмепу — демонструє реальний ріст, не лише
  // поточний знімок 12/74.
  roadmapWeekly: [
    { week: '', count: 1 },
    { week: '', count: 0 },
    { week: '', count: 2 },
    { week: '', count: 1 },
    { week: '', count: 1 },
    { week: '', count: 3 },
    { week: '', count: 0 },
    { week: '', count: 2 },
    { week: '', count: 1 },
    { week: '', count: 0 },
    { week: '', count: 2 },
    { week: '', count: 1 },
  ],
  // 26 тижнів (WEEKLY_CAP — уся глибина ретенції, stats-core.mjs), не 6 —
  // демо показує повний тренд-графік (InterestTrend), не лише коротку
  // стрілочку. Технології ростуть, Наука коливається м'яко вгору, Політика
  // згасає — три різні форми лінії для перевірки живим прев'ю.
  interestsTrend: {
    weeks: [
      '2026-01-12',
      '2026-01-19',
      '2026-01-26',
      '2026-02-02',
      '2026-02-09',
      '2026-02-16',
      '2026-02-23',
      '2026-03-02',
      '2026-03-09',
      '2026-03-16',
      '2026-03-23',
      '2026-03-30',
      '2026-04-06',
      '2026-04-13',
      '2026-04-20',
      '2026-04-27',
      '2026-05-04',
      '2026-05-11',
      '2026-05-18',
      '2026-05-25',
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
      '2026-07-06',
    ],
    topics: [
      {
        topic: 'Технології',
        series: [
          1, 2, 1, 3, 2, 3, 4, 3, 5, 4, 6, 5, 7, 6, 8, 7, 9, 8, 10, 9, 11, 10, 12, 11, 13, 12,
        ],
      },
      {
        topic: 'Наука',
        // Останній місяць помітно вищий за попередній — щоб демо показувало
        // картку «що змінилось». Доти всі три ряди були гладкі, картка чесно
        // ховалась, і побачити її можна було лише на власних даних.
        series: [0, 1, 1, 0, 2, 1, 2, 3, 2, 1, 3, 2, 4, 3, 2, 4, 3, 5, 4, 3, 4, 9, 11, 10, 12, 11],
      },
      {
        topic: 'Політика',
        // ...і симетрично — тема, що згасла: рівний інтерес до середини й
        // тиша в останній місяць.
        series: [6, 5, 6, 4, 5, 3, 4, 2, 3, 2, 4, 3, 5, 4, 3, 5, 4, 6, 5, 4, 0, 1, 0, 0, 1, 0],
      },
    ],
  },
  // Чек-ін: демо стоїть у ранковому блоці з частковою відповіддю — так одразу
  // видно всі три стани (заповнюваний / замкнені) і гідратацію з сервера.
  checkinSlot: 'morning',
  checkinToday: { morning: { sleepH: 6.5 } },
  // Глибини агрегації — дзеркало STATS_WINDOWS зі stats-core.mjs. У демо теж
  // справжні, бо підписи «за N діб» малюються саме звідси.
  windows: {
    checkinRecent: 30,
    checkinMid: 60,
    checkinDeep: 90,
    trendWeeks: 8,
    checkinWeeks: 8,
    reliabilityDays: 90,
    rhythmOpens: 90,
  },
  checkinSeries: sampleCheckinSeries(),
  checkinRaw: sampleCheckinRaw(),
  sleepLog: [
    { d: '2026-07-30', startedAt: '2026-07-30T23:12:00.000Z', wokeAt: '2026-07-31T07:05:00.000Z', durationMin: 473 },
    { d: '2026-07-31', startedAt: '2026-07-31T23:58:00.000Z', wokeAt: '2026-08-01T07:20:00.000Z', durationMin: 442 },
    { d: '2026-08-01', startedAt: '2026-08-02T00:34:00.000Z', wokeAt: '2026-08-02T08:10:00.000Z', durationMin: 456 },
    { d: '2026-08-02', startedAt: '2026-08-02T23:20:00.000Z', wokeAt: null, durationMin: null },
  ],
  // 30 діб, у 19 план збігся з тим, що реально зайняло час. Топ-пари — куди
  // саме зʼїжджає день, коли не збігається.
  intentDrift: {
    days: 30,
    total: 30,
    full: 12,
    partial: 9,
    pct: 63,
    top: [
      { from: 'work', to: 'chores', n: 4 },
      { from: 'learn', to: 'work', n: 3 },
      { from: 'project', to: 'rest', n: 2 },
    ],
  },
  checkinWeekly: [
    { week: '', n: 5, sleepAvg: 6.4, energyAvg: 3.1, dayScoreAvg: 3.4 },
    { week: '', n: 6, sleepAvg: 7.1, energyAvg: 3.6, dayScoreAvg: 3.8 },
  ],
  checkinFill: { morning: 18, afternoon: 11, evening: 7, days: 30 },
  // Демо-огляд: кореляції в «готовому» стані, щоб було видно наповнену
  // статистику (у проді вони мовчать, поки в кожному кошику <8 днів).
  sleepVsDayScore: { ready: true, needed: 8, low: 9, ok: 11, lowAvg: 2.9, okAvg: 4.1 },
  bedtimeVsEnergy: { ready: true, needed: 8, early: 11, late: 9, earlyAvg: 3.9, lateAvg: 2.5 },
  categoryInsight: {
    days: 30,
    total: 22,
    rows: [
      { cat: 'work', n: 8, dayScore: 3.4 },
      { cat: 'rest', n: 5, dayScore: 4.2 },
      { cat: 'learn', n: 4, dayScore: 3.8 },
      { cat: 'travel', n: 3, dayScore: null },
      { cat: 'chores', n: 2, dayScore: null },
    ],
  },
  // Ночі: у демо їх чотири зіпсовані з тридцяти — і effect свідомо НЕ готовий.
  // Показати «після безсонної ночі день гірший на 1.2» на чотирьох
  // спостереженнях означало б намалювати монетку, яка читається як висновок.
  nightKinds: {
    days: 30,
    nights: 24,
    slept: 20,
    naps: 3,
    none: 1,
    rough: 4,
    dates: ['2026-07-29', '2026-08-04', '2026-08-09', '2026-08-15'],
    reasons: [
      { value: 'work', n: 2 },
      { value: 'wait', n: 2 },
      { value: 'cant', n: 1 },
      { value: 'uncomf', n: 1 },
    ],
    effect: { ready: false, needed: 8, nRough: 4 },
  },
  checkinTops: {
    days: 30,
    blocker: { value: 'tired', n: 6 },
    helper: { value: 'early', n: 5 },
    blockers: [
      { value: 'tired', n: 6 },
      { value: 'distract', n: 4 },
      { value: 'nomotiv', n: 3 },
      { value: 'overload', n: 2 },
      { value: 'stuck', n: 1 },
    ],
    helpers: [
      { value: 'early', n: 5 },
      { value: 'smallstep', n: 4 },
      { value: 'move', n: 3 },
      { value: 'breaks', n: 2 },
      { value: 'music', n: 1 },
    ],
    // Демо показує рядок «жодного разу» непорожнім — інакше цей стан ніде не
    // побачити, а він і є типовим у перші тижні після розширення списків.
    unusedBlockers: ['waiting', 'forgot', 'noplan', 'context', 'perfect', 'noise'],
    unusedHelpers: ['deadline', 'plan', 'timer', 'clean', 'food'],
    filled: 14,
    lateReasons: [
      { value: 'scroll', n: 4 },
      { value: 'work', n: 3 },
      { value: 'metime', n: 2 },
      { value: 'anxious', n: 1 },
    ],
    lateNights: 10,
  },
  // Соціальний контекст: демо-набір готовий (значуще різняться «сам» і «з
  // людьми») — щоб було видно, як виглядає повністю розкрита картка.
  // Демо показує ЗСУВ, а не рівність: нульовий bias сховав би сенс картки —
  // та сама пастка, що з гладкими демо-рядами інтересів і з full=active у
  // вогниках.
  expectCalibration: {
    days: 30,
    n: 19,
    ready: true,
    avgExpect: 3.1,
    avgActual: 3.5,
    bias: 0.4,
    better: 11,
    same: 4,
    worse: 4,
  },
  moveIntent: {
    days: 30,
    n: 21,
    ready: true,
    planned: 12,
    kept: 7,
    keptPct: 58,
    noPlanDays: 9,
    noPlanButMoved: 3,
  },
  socialContext: {
    days: 60,
    tops: [
      { value: 'work', n: 18 },
      { value: 'alone', n: 14 },
      { value: 'friends', n: 9 },
      { value: 'family', n: 7 },
      { value: 'mixed', n: 4 },
    ],
    filled: 52,
    aloneVsOthers: {
      ready: true,
      nAlone: 14,
      nOthers: 38,
      aloneAvg: 3.3,
      othersAvg: 3.9,
      d: 0.52,
      p: 0.031,
    },
  },
  // «Індекс дня» (checkin-model.mjs): демо-набір, що показує ВСІ стани разом —
  // ваги вивчені, один лаг готовий і один ще ні (гейт), архетипи готові.
  checkinModel: {
    n: 90,
    fit: {
      weights: { recovery: 0.28, resource: 0.24, work: 0.3, agency: 0.1, body: 0.08 },
      // Один відʼємний знак у демо навмисно: без нього не видно, що рахунок
      // узагалі вміє віднімати вимір, який тягне день униз.
      signs: { recovery: 1, resource: 1, work: 1, agency: 1, body: -1 },
      lambda: 0.5,
      r2: 0.38,
      // Помітно нижчий за внутрішньовибірковий — так воно й буває, і демо має
      // показувати саме це, а не два однакові числа.
      r2cv: 0.21,
      n: 45,
      learned: true,
    },
    dayIndex: { last: 74.5, mean: 68.2, lastCoverage: 5, needCoverage: 3, scored: 41 },
    drivers: [
      // q/passesBH — поправка на множинні порівняння: демо показує обидва
      // стани, бо саме різниця між «p<0.05» і «витримує поправку» тут і нова.
      { field: 'output', index: 'work', delta: 1.05, d: 1.42, p: 0.001, q: 0.019, passesBH: true, nHigh: 22, nLow: 18 },
      { field: 'rumination', index: 'recovery', delta: 0.82, d: 1.05, p: 0.004, q: 0.038, passesBH: true, nHigh: 24, nLow: 20 },
      { field: 'autonomy', index: 'agency', delta: 0.71, d: 0.88, p: 0.011, q: 0.07, passesBH: false, nHigh: 19, nLow: 21 },
      { field: 'moved', index: 'body', delta: 0.6, d: 0.74, p: 0.023, q: 0.11, passesBH: false, nHigh: 15, nLow: 17 },
      { field: 'screen', index: 'recovery', delta: -0.55, d: -0.69, p: 0.031, nHigh: 12, nLow: 26 },
    ],
    lagged: {
      recovery: { ready: true, n: 44, rho: 0.21, p: 0.048, src: 'recovery', target: 'dayScore' },
      body: { ready: false, n: 10, needed: 16 },
    },
    archetypes: {
      ready: true,
      k: 4,
      n: 42,
      groups: [
        {
          n: 16,
          share: 0.381,
          profile: { recovery: 0.62, resource: 0.58, work: 0.71, agency: 0.4, body: 0.35 },
          top: 'work',
          low: 'body',
        },
        {
          n: 12,
          share: 0.286,
          profile: { recovery: 0.75, resource: 0.68, work: 0.45, agency: 0.55, body: 0.6 },
          top: 'recovery',
          low: 'work',
        },
        {
          n: 9,
          share: 0.214,
          profile: { recovery: 0.35, resource: 0.4, work: 0.3, agency: 0.42, body: 0.5 },
          top: 'body',
          low: 'recovery',
        },
        {
          n: 5,
          share: 0.119,
          profile: { recovery: 0.3, resource: 0.28, work: 0.25, agency: 0.2, body: 0.3 },
          top: 'body',
          low: 'agency',
        },
      ],
    },
  },
};

/**
 * Порожня статистика — демо-стан «Порожньо» (F2, перемикач у налаштуваннях).
 * Нулі, а не відсутні поля: так видно саме порожні стани блоків (як у перший
 * день використання), а не помилку контракту.
 */
export const EMPTY_STATS: Stats = {
  streaks: { openDays: 0, mockDays: 0, bestOpenDays: 0 },
  timeToOpenMin: null,
  openRhythm: { ready: false, n: 0, needed: 5, drift: null },
  habitWeekly: [],
  flameStats: { tops: [], activeNights: 0, streak: 0, best: 0, weekly: [] },
  weekly: [],
  funnel: { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0, failed: 0 },
  goal: { weeklyTarget: 5, weeklyApplied: 0 },
  conversion: { appliedToInterview: 0, interviewToOffer: 0 },
  reached: { saved: 0, applied: 0, interview: 0, offer: 0 },
  avgFitApplied: null,
  funnelList: [],
  dismissedUrls: [],
  savedCount: 0,
  savedList: [],
  mock: { weakTopics: [], streak: 0, recentEasyPct: null , easeTrend: [], recentByTopic: {} },
  heatmap: [],
  funnelSpeed: { steps: [], stale: [], staleAfterDays: 21 },
  appliedWeekly: [],
  fitWeekly: [],
  roadmapWeekly: [],
  interestsTrend: { weeks: [], topics: [] },
  interests: [],
  readPerDay: 0,
  reliability: { onTime: 0, total: 0, deadman: 0, streak: 0, best: 0, days: [] },
  votes: {},
  mockRated: {},
  mockMaterials: {},
  // Порожньо = перший день: блок відкритий, але жодної відповіді ще немає.
  checkinSlot: 'morning',
  checkinToday: null,
  // Глибини агрегації — дзеркало STATS_WINDOWS зі stats-core.mjs. У демо теж
  // справжні, бо підписи «за N діб» малюються саме звідси.
  windows: {
    checkinRecent: 30,
    checkinMid: 60,
    checkinDeep: 90,
    trendWeeks: 8,
    checkinWeeks: 8,
    reliabilityDays: 90,
    rhythmOpens: 90,
  },
  checkinSeries: [],
  checkinRaw: { days: 90, from: '', to: '', records: {} },
  sleepLog: [],
  intentDrift: { days: 30, total: 0, full: 0, partial: 0, pct: null, top: [] },
  checkinWeekly: [],
  checkinFill: { morning: 0, afternoon: 0, evening: 0, days: 30 },
  sleepVsDayScore: { ready: false, needed: 8, low: 0, ok: 0 },
  bedtimeVsEnergy: { ready: false, needed: 8, early: 0, late: 0 },
  categoryInsight: { days: 30, total: 0, rows: [] },
  nightKinds: {
    days: 30,
    nights: 0,
    slept: 0,
    naps: 0,
    none: 0,
    rough: 0,
    dates: [],
    reasons: [],
    effect: { ready: false, needed: 8, nRough: 0 },
  },
  checkinTops: {
    blocker: null,
    helper: null,
    blockers: [],
    helpers: [],
    unusedBlockers: [],
    unusedHelpers: [],
    days: 30,
    filled: 0,
    lateReasons: [],
    lateNights: 0,
  },
  // ready:false, а не вигадані нулі: порожній стан мусить читатись як «ще
  // рано», а не як «зсув нульовий» чи «намір ніколи не збувався».
  expectCalibration: { days: 30, n: 0, ready: false, needed: 8 },
  moveIntent: { days: 30, n: 0, ready: false, needed: 5 },
  socialContext: {
    days: 60,
    filled: 0,
    tops: [],
    aloneVsOthers: { ready: false, nAlone: 0, nOthers: 0 },
  },
  checkinModel: {
    n: 0,
    fit: {
      weights: { recovery: 0.2, resource: 0.2, work: 0.2, agency: 0.2, body: 0.2 },
      r2: null,
      n: 0,
      learned: false,
    },
    dayIndex: { last: null, mean: null, lastCoverage: 0, needCoverage: 3, scored: 0 },
    drivers: [],
    lagged: { recovery: { ready: false, n: 0 }, body: { ready: false, n: 0 } },
    archetypes: { ready: false, n: 0, groups: [] },
  },
};

/**
 * Демо-архів збереженого (F3) — ДОВШИЙ за прев'ю у SAMPLE_STATS.savedList.
 * Інакше «Показати ще» в демо нічого б не показувала: прев'ю віддає 3 записи
 * при savedCount 5, і кнопка була б порожньою обіцянкою.
 */
export const SAMPLE_SAVED_ARCHIVE: SavedItem[] = [
  ...SAMPLE_STATS.savedList,
  {
    kind: 'news',
    id: 'https://example.com/news9',
    url: 'https://example.com/news9',
    title: 'Cloudflare Workers: нові ліміти безкоштовного плану',
    ts: '2026-07-02',
  },
  {
    kind: 'fact',
    id: 'f9',
    title: 'Перший баг у комп’ютері був справжнім метеликом (1947)',
    url: null,
    ts: '2026-07-01',
  },
];
