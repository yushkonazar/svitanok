import { z } from 'zod';

// Контракт briefing.json (роадмеп v3, E2). brief = { generatedAt, dateLabel,
// blocks[] }; кожен блок { id, data? }. Дашборд шукає блоки за id (byId) і читає
// data за відомою формою. Тримаємо data на рівні brief нетипізованим, а форму
// кожного блоку валідуємо окремо при читанні (readBlock) — битий один блок
// деградує до плейсхолдера, не валить увесь брифінг (як vanilla-захист has()).
// Продюсер: src/core/briefing.ts + src/modules/*.

export const briefBlockSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  icon: z.string().optional(),
  summary: z.string().optional(),
  data: z.unknown().optional(),
  priority: z.number().optional(),
});

export const briefSchema = z.object({
  // .default('') — порожній брифінг '{}' (свіжий деплой / wipe KV / до першого
  // крону) сервер віддає HTTP 200 '{}'; без дефолтів safeParse кинув би, і Today
  // показала б жорстку помилку. Vanilla трактує '{}' як успіх (порожні
  // плейсхолдери) — відтворюємо це.
  generatedAt: z.string().default(''),
  dateLabel: z.string().default(''),
  blocks: z.array(briefBlockSchema).default([]),
});

export type Brief = z.infer<typeof briefSchema>;
export type BriefBlock = z.infer<typeof briefBlockSchema>;

// ── Форми data окремих блоків (лише поля, які споживає Today-вкладка) ──

export const weatherLocationSchema = z.object({
  name: z.string(),
  emoji: z.string().default(''),
  tempC: z.number(),
  feelsLikeC: z.number().optional(),
  minC: z.number().optional(),
  maxC: z.number().optional(),
  windMps: z.number().optional(),
  gustMps: z.number().optional(),
  humidity: z.number().optional(),
  uv: z.number().optional(),
  aqi: z.number().optional(),
  condition: z.string().optional(),
  willRain: z.boolean().optional(),
  willBeCold: z.boolean().optional(),
  popPercent: z.number().optional(),
  rainWindow: z.string().optional(),
  advice: z.string().optional(),
  dayLenDeltaMin: z.number().optional(),
  sunrise: z.number().default(0),
  sunset: z.number().default(0),
  hourly: z.array(z.object({ h: z.number(), t: z.number() })).optional(),
});

export const weatherDataSchema = z.object({
  locations: z.array(weatherLocationSchema).default([]),
});

export const currencyDataSchema = z.object({
  usd: z.number().optional(),
  eur: z.number().optional(),
  pln: z.number().optional(),
  gbp: z.number().optional(),
  usdHistory: z.array(z.number()).optional(),
  eurHistory: z.array(z.number()).optional(),
  plnHistory: z.array(z.number()).optional(),
  gbpHistory: z.array(z.number()).optional(),
});

export const mockDataSchema = z.object({
  question: z.string(),
  answer: z.string().optional(),
  hint: z.string().optional(),
  resourceUrl: z.string().optional(),
  topic: z.string().optional(),
});

export const factDataSchema = z.object({ fact: z.string() });

export const stoicDataSchema = z.object({ text: z.string(), author: z.string() });

export const onThisDayEventSchema = z.object({
  year: z.number(),
  text: z.string(),
  url: z.string().optional(),
});

export const onThisDayDataSchema = z.object({
  events: z.array(onThisDayEventSchema).default([]),
});

export const newsItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  why: z.string().optional(),
});

export const newsGroupSchema = z.object({
  scope: z.enum(['world', 'ua']),
  topic: z.string(),
  items: z.array(newsItemSchema).default([]),
  more: z.array(newsItemSchema).default([]),
});

export const newsDataSchema = z.object({
  groups: z.array(newsGroupSchema).default([]),
});

// funnelStage — лише демо-фолбек; реальна стадія завжди зі stats (funnelList).
export const jobItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  score: z.number().default(-1),
  why: z.string().default(''),
  funnelStage: z.enum(['saved', 'applied', 'interview', 'offer']).optional(),
});

export const jobsDataSchema = z.object({
  items: z.array(jobItemSchema).default([]),
});

export type WeatherLocation = z.infer<typeof weatherLocationSchema>;
export type WeatherData = z.infer<typeof weatherDataSchema>;
export type CurrencyData = z.infer<typeof currencyDataSchema>;
export type MockData = z.infer<typeof mockDataSchema>;
export type FactData = z.infer<typeof factDataSchema>;
export type StoicData = z.infer<typeof stoicDataSchema>;
export type OnThisDayEvent = z.infer<typeof onThisDayEventSchema>;
export type OnThisDayData = z.infer<typeof onThisDayDataSchema>;
export type NewsItem = z.infer<typeof newsItemSchema>;
export type NewsGroup = z.infer<typeof newsGroupSchema>;
export type NewsData = z.infer<typeof newsDataSchema>;
export type JobItem = z.infer<typeof jobItemSchema>;
export type JobsData = z.infer<typeof jobsDataSchema>;

/**
 * Знайти блок за id і безпечно розпарсити його data за схемою. null, якщо блоку
 * нема або форма не збіглася (деградація до плейсхолдера, не краш брифінгу).
 * `S extends ZodTypeAny` + z.infer<S> дають OUTPUT-тип (з застосованими .default),
 * інакше дженерик ZodType хибно прив'язує INPUT-тип (де дефолти опційні).
 */
export function readBlock<S extends z.ZodTypeAny>(
  blocks: BriefBlock[],
  id: string,
  schema: S,
): z.infer<S> | null {
  const block = blocks.find((b) => b.id === id);
  if (!block || block.data === undefined) return null;
  const parsed = schema.safeParse(block.data);
  return parsed.success ? parsed.data : null;
}
