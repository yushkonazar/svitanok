import { z } from 'zod';

// Контракт /api/stats (роадмеп v3, E1). Форми списані 1:1 з aggregateStats
// (web/stats-core.mjs:435-481) + доповнень handleStats (web/worker.js:483-508:
// roadmap, mastery, votes). Zod-об'єкти за замовчуванням відкидають зайві ключі,
// тож схема стійка до нових полів сервера; nullable/optional — там, де джерело
// реально їх повертає (median -> null, best-стрік -> може бути 0, votes відсутні
// поза голосуванням). Валідація — safeParse у client.ts: биті дані -> плейсхолдери,
// не краш вкладки.

const num = z.number();
const int = z.number();

export const weeklyDaySchema = z.object({
  day: z.string(),
  value: num,
  active: z.boolean(),
});

// Воронка v2 (F1): 4 лінійні + термінальні rejected/failed.
// ⚠️ Цей enum — найкрихкіше місце контракту: варто серверу віддати стадію, якої
// тут немає, і safeParse валить ВЕСЬ /api/stats (не один елемент) -> вкладки
// «Статистика» й «Вакансії» йдуть у помилку. Розширювати синхронно зі stats-core.
export const stageSchema = z.enum(['saved', 'applied', 'interview', 'offer', 'rejected', 'failed']);

export const funnelSchema = z.object({
  saved: int,
  applied: int,
  interview: int,
  offer: int,
  // .default(0) — старий сервер (до F1) цих полів не віддає; без дефолту дашборд
  // ліг би на першому ж завантаженні під час деплою.
  rejected: int.default(0),
  failed: int.default(0),
});

/** Один перехід у журналі стадій — для «Історії» у шторці вакансії. */
export const stageEventSchema = z.object({ stage: stageSchema, ts: z.string() });

export const funnelItemSchema = z.object({
  url: z.string(),
  stage: stageSchema,
  title: z.string(),
  /** Дата ПЕРШОГО входу у воронку (F1), не останнього переходу. */
  ts: z.string(),
  /** Журнал переходів; легасі-записи (до F1) його не мають -> порожній. */
  history: z.array(stageEventSchema).default([]),
});

/** Скільки вакансій КОЛИСЬ дійшли до стадії — знаменники конверсій (F1). */
export const reachedSchema = z.object({
  saved: int.default(0),
  applied: int.default(0),
  interview: int.default(0),
  offer: int.default(0),
});

export const savedItemSchema = z.object({
  kind: z.string(),
  id: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  ts: z.string(),
});

/** Сторінка архіву збереженого — GET /api/saved (F3). */
export const savedPageSchema = z.object({
  items: z.array(savedItemSchema).default([]),
  total: int.default(0),
});

export const weakTopicSchema = z.object({ name: z.string(), value: num });

export const heatmapCellSchema = z.object({ d: z.string(), v: num, l: int });

export const appliedWeekSchema = z.object({ week: z.string(), count: int });

export const interestSchema = z.object({ topic: z.string(), score: num });

export const interestsTrendSchema = z.object({
  weeks: z.array(z.string()),
  topics: z.array(z.object({ topic: z.string(), series: z.array(num) })),
});

export const roadmapSchema = z.object({ done: int, total: int });

export const masteryThemeSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: int,
  total: int,
});

export const masteryHintSchema = z.object({
  mockTopic: z.string(),
  themes: z.array(masteryThemeSchema),
});

export const themeOfWeekSchema = z.object({
  week: z.string(),
  topicId: z.string(),
  title: z.string(),
  done: int,
  total: int,
  mockTopics: z.array(z.string()),
});

/** Куроване джерело з роадмепу — «Вивчити» в картці питання (F4/F5). */
export const materialSchema = z.object({ title: z.string(), url: z.string() });

export const masterySchema = z.object({
  hints: z.array(masteryHintSchema).default([]),
  themeOfWeek: themeOfWeekSchema.nullable().default(null),
});

export const statsSchema = z.object({
  streaks: z.object({
    openDays: int.default(0),
    mockDays: int.default(0),
    bestOpenDays: int.optional(),
  }),
  timeToOpenMin: num.nullable().default(null),
  weekly: z.array(weeklyDaySchema).default([]),
  funnel: funnelSchema,
  goal: z.object({ weeklyTarget: num.nullable().default(null), weeklyApplied: int.default(0) }),
  conversion: z.object({ appliedToInterview: num, interviewToOffer: num }),
  // F1: знаменники конверсій — щоб «50%» читалось як «1 з 2». Старий сервер поля
  // не віддає -> дефолт нулями.
  reached: reachedSchema.default({ saved: 0, applied: 0, interview: 0, offer: 0 }),
  avgFitApplied: num.nullable().default(null),
  funnelList: z.array(funnelItemSchema).default([]),
  savedCount: int.default(0),
  savedList: z.array(savedItemSchema).default([]),
  mock: z.object({ weakTopics: z.array(weakTopicSchema).default([]), streak: int.default(0) }),
  heatmap: z.array(heatmapCellSchema).default([]),
  appliedWeekly: z.array(appliedWeekSchema).default([]),
  interestsTrend: interestsTrendSchema.default({ weeks: [], topics: [] }),
  interests: z.array(interestSchema).default([]),
  readPerDay: num.default(0),
  reliability: z.object({
    onTime: int.default(0),
    total: int.default(0),
    deadman: int.default(0),
  }),
  mockRatedToday: z.boolean().optional(),
  // F4: qId -> обрана оцінка. Доти вибір жив лише в стані сесії й зникав після
  // перезавантаження: чипи були заблоковані, але жоден не підсвічений.
  mockRated: z.record(z.string(), z.enum(['easy', 'hard'])).default({}),
  // F4: mock-тема -> матеріали роадмепу. Старий сервер поля не віддає -> {}.
  mockMaterials: z.record(z.string(), z.array(materialSchema)).default({}),
  roadmap: roadmapSchema.optional(),
  mastery: masterySchema.optional(),
  // zod 4: z.record ВИМАГАЄ обидві схеми — ключа й значення. З одним аргументом
  // v4 читає його як схему КЛЮЧА (у v3 це була схема значення), тобто мовчазна
  // інверсія сенсу: замість «url -> голос» вийшло б «ключі мусять бути up/down»,
  // і кожен реальний votes завалював би валідацію -> вкладка «Статистика» в
  // помилку. Ключ тут — url новини.
  votes: z.record(z.string(), z.enum(['up', 'down'])).optional(),
});

export type Stats = z.infer<typeof statsSchema>;
export type WeeklyDay = z.infer<typeof weeklyDaySchema>;
export type Funnel = z.infer<typeof funnelSchema>;
export type FunnelItem = z.infer<typeof funnelItemSchema>;
export type StageEvent = z.infer<typeof stageEventSchema>;
export type Reached = z.infer<typeof reachedSchema>;
export type Material = z.infer<typeof materialSchema>;
export type SavedPage = z.infer<typeof savedPageSchema>;
export type SavedItem = z.infer<typeof savedItemSchema>;
export type WeakTopic = z.infer<typeof weakTopicSchema>;
export type HeatmapCell = z.infer<typeof heatmapCellSchema>;
export type AppliedWeek = z.infer<typeof appliedWeekSchema>;
export type Interest = z.infer<typeof interestSchema>;
export type InterestsTrend = z.infer<typeof interestsTrendSchema>;
export type Mastery = z.infer<typeof masterySchema>;
export type MasteryHint = z.infer<typeof masteryHintSchema>;
export type ThemeOfWeek = z.infer<typeof themeOfWeekSchema>;
export type Roadmap = z.infer<typeof roadmapSchema>;
