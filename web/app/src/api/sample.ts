import type { Stats, HeatmapCell, SavedItem } from './schema.ts';

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
    out.push({ d: key(d), v, l });
  }
  return out;
}

/** ЛОКАЛЬНА дата -> 'YYYY-MM-DD'. toISOString дав би UTC і зсував демо на добу. */
const dayKey = (dt: Date) =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

/** Демо-ряд чек-іну: 14 діб із дірками — саме так це й виглядає в житті. */
function sampleCheckinSeries() {
  const out: Array<{
    d: string;
    sleepH: number | null;
    energy: number | null;
    dayScore: number | null;
    slots: number;
  }> = [];
  const d = new Date();
  d.setDate(d.getDate() - 13);
  const sleep = [6.5, 7.5, 5.5, 8.5, 6.5, 7.5, 7.5, 5.5, 6.5, 8.5, 7.5, 6.5, 7.5, 6.5];
  for (let i = 0; i < 14; i++) {
    // Кожен 5-й день пропущений — щоб було видно, що дірки це норма, а не збій.
    if (i % 5 !== 4) {
      out.push({
        d: dayKey(d),
        sleepH: sleep[i]!,
        energy: Math.round((sleep[i]! - 3) * 10) / 10,
        dayScore: i % 3 === 0 ? 4 : 3,
        slots: i % 4 === 0 ? 3 : 1,
      });
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export const SAMPLE_STATS: Stats = {
  streaks: { openDays: 5, bestOpenDays: 12, mockDays: 4 },
  timeToOpenMin: 23,
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
  },
  roadmap: { done: 12, total: 74 },
  mastery: {
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
  reliability: { onTime: 28, total: 30, deadman: 1 },
  heatmap: sampleHeatmap(),
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
  interestsTrend: {
    weeks: ['', '', '', '', '', ''],
    topics: [
      { topic: 'Технології', series: [2, 4, 3, 6, 5, 8] },
      { topic: 'Наука', series: [1, 2, 0, 3, 2, 4] },
      { topic: 'Політика', series: [0, 1, 1, 0, 2, 1] },
    ],
  },
  // Чек-ін: демо стоїть у ранковому блоці з частковою відповіддю — так одразу
  // видно всі три стани (заповнюваний / замкнені) і гідратацію з сервера.
  checkinSlot: 'morning',
  checkinToday: { morning: { sleepH: 6.5 } },
  checkinSeries: sampleCheckinSeries(),
  checkinWeekly: [
    { week: '', n: 5, sleepAvg: 6.4, energyAvg: 3.1, dayScoreAvg: 3.4 },
    { week: '', n: 6, sleepAvg: 7.1, energyAvg: 3.6, dayScoreAvg: 3.8 },
  ],
  checkinFill: { morning: 18, afternoon: 11, evening: 7, days: 30 },
  planVsFact: [
    { d: '2026-07-14', planned: 3, actual: 1 },
    { d: '2026-07-15', planned: 2, actual: 2 },
    { d: '2026-07-16', planned: 3, actual: 0 },
  ],
  // ready:false — демо показує саме ГЕЙТ: поки в кошиках мало днів, цифр немає
  // свідомо (кореляція на малій вибірці бреше впевнено).
  sleepVsApplied: { ready: false, needed: 8, low: 4, ok: 6 },
};

/**
 * Порожня статистика — демо-стан «Порожньо» (F2, перемикач у налаштуваннях).
 * Нулі, а не відсутні поля: так видно саме порожні стани блоків (як у перший
 * день використання), а не помилку контракту.
 */
export const EMPTY_STATS: Stats = {
  streaks: { openDays: 0, mockDays: 0, bestOpenDays: 0 },
  timeToOpenMin: null,
  weekly: [],
  funnel: { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0, failed: 0 },
  goal: { weeklyTarget: 5, weeklyApplied: 0 },
  conversion: { appliedToInterview: 0, interviewToOffer: 0 },
  reached: { saved: 0, applied: 0, interview: 0, offer: 0 },
  avgFitApplied: null,
  funnelList: [],
  savedCount: 0,
  savedList: [],
  mock: { weakTopics: [], streak: 0 },
  heatmap: [],
  appliedWeekly: [],
  interestsTrend: { weeks: [], topics: [] },
  interests: [],
  readPerDay: 0,
  reliability: { onTime: 0, total: 0, deadman: 0 },
  votes: {},
  mockRated: {},
  mockMaterials: {},
  // Порожньо = перший день: блок відкритий, але жодної відповіді ще немає.
  checkinSlot: 'morning',
  checkinToday: null,
  checkinSeries: [],
  checkinWeekly: [],
  checkinFill: { morning: 0, afternoon: 0, evening: 0, days: 30 },
  planVsFact: [],
  sleepVsApplied: { ready: false, needed: 8, low: 0, ok: 0 },
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
