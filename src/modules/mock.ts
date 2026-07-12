// mock (consumer). «Питання дня» для підготовки до співбесіди — LLM, але
// ЕКОНОМНО: батч-кеш. Коли state.mockCache порожній, один claude -p генерує
// batchSize пар питання+відповідь+тема під стек; далі щодня одну без LLM.
// Розкриття в дашборді показує відповідь + самооцінку (легко/важко, Блок F) +
// кнопку «Вивчити» (детермінований пошук теми). Самооцінка на слабких темах
// підвищує їх вагу (mockWeights, KV `state`) -> наступний батч генерує більше
// питань саме з них («інтервальне повторення» тем, не конкретних питань).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

const MOCK_PRIORITY = 58; // після вакансій (55), перед next-step

// Фіксований список тем — щоб вага теми (mockWeights) не фрагментувалась між
// батчами через довільні LLM-формулювання. Безпека/AI-LLM додано 2026-07,
// щоб словник тем перекликався з новими темами роадмепу (web/roadmap-data.mjs:
// security, ai-dev) — той самий «інтерв'ю ↔ навчання» словник без окремої
// логіки синхронізації (mockWeights і roadmapProgress лишаються незалежними
// стейтами; звʼязок лише на рівні назв тем).
export const MOCK_TOPICS = [
  'Мова',
  'Фреймворк',
  'HTTP',
  'Бази даних',
  'Алгоритми',
  'Патерни',
  'Безпека',
  'AI/LLM',
];

export interface MockQA {
  q: string;
  a: string;
  topic?: string;
}

// --- mockWeights (памʼять слабких тем із самооцінки: інтервальне повторення) ---
export type MockWeights = Record<string, number>;
export const MOCK_WEIGHT_MIN = 0.5;
export const MOCK_WEIGHT_MAX = 2.0;
const MOCK_WEIGHT_STEP = 0.2;

const clampMockWeight = (w: number) => Math.min(MOCK_WEIGHT_MAX, Math.max(MOCK_WEIGHT_MIN, w));

/** rating='hard' -> тема «слабша», вага росте (частіше в наступному батчі); 'easy' -> спадає. */
export function updateMockWeight(
  weights: MockWeights,
  topic: string,
  rating: 'easy' | 'hard',
): MockWeights {
  if (!topic) return weights;
  const cur = weights[topic] ?? 1.0;
  const next = clampMockWeight(cur + (rating === 'hard' ? MOCK_WEIGHT_STEP : -MOCK_WEIGHT_STEP));
  return { ...weights, [topic]: next };
}

export function buildMockPrompt(n: number, profile: string, weights?: MockWeights): string {
  const weak = weights
    ? Object.entries(weights)
        .filter(([, w]) => w > 1.0)
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t)
    : [];
  return [
    `Згенеруй рівно ${n} пар «питання–відповідь» для технічної співбесіди.`,
    `Профіль кандидата: ${profile}.`,
    `Теми лише з цього списку: ${MOCK_TOPICS.join(', ')}.`,
    weak.length ? `Приділи більше уваги слабким темам кандидата: ${weak.join(', ')}.` : '',
    'Питання — одне речення. Відповідь — 1–2 речення, стисло й точно, українською.',
    "Поверни ЛИШЕ валідний JSON-масив об'єктів без прози:",
    '[{"q":"питання","a":"відповідь","topic":"одна з тем зі списку"}, ...]',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Розпарсити масив {q,a,topic?} з відповіді LLM; малформат/порожні -> відкидаємо. */
export function parseMockCache(text: string): MockQA[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is { q: string; a?: unknown; topic?: unknown } =>
          !!x && typeof x === 'object' && typeof (x as { q?: unknown }).q === 'string',
      )
      .map((x) => ({
        q: x.q.trim(),
        a: typeof x.a === 'string' ? x.a.trim() : '',
        topic: typeof x.topic === 'string' && x.topic.trim() ? x.topic.trim() : undefined,
      }))
      .filter((x) => x.q.length > 0 && x.a.length > 0); // лише повні пари
  } catch {
    return [];
  }
}

/** Детермінований ресурс для вивчення теми (пошук питання) — без вигаданих URL. */
function resourceFor(question: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(question)}`;
}

export const mockModule: Module<AppConfig> = {
  id: 'mock',
  kind: 'consumer',
  enabled: (config) => config.modules.mock.enabled,

  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const cfg = ctx.config.modules.mock;
    // Лишаємо лише ПОВНІ пари {q,a}. Старий string[]-кеш і мігровані порожні
    // {q,a:''} відкидаються -> регенеруємо з відповідями.
    const raw = ctx.state.get<unknown[]>('mockCache') ?? [];
    let cache: MockQA[] = (Array.isArray(raw) ? raw : []).filter(
      (x): x is MockQA =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as MockQA).q === 'string' &&
        (x as MockQA).q.length > 0 &&
        typeof (x as MockQA).a === 'string' &&
        (x as MockQA).a.length > 0,
    );

    if (cache.length === 0) {
      // mockWeights (Блок F): слабкі теми з самооцінки -> LLM генерує більше з них.
      const weights = ctx.state.get<MockWeights>('mockWeights');
      try {
        const out = await ctx.llm.complete(buildMockPrompt(cfg.batchSize, cfg.profile, weights), {
          timeoutMs: ctx.config.llm.timeoutMs,
        });
        cache = parseMockCache(out);
      } catch (e) {
        ctx.log.warn(`mock: генерація не вдалася: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      if (cache.length === 0) return null;
    }

    const item = cache.shift()!;
    ctx.state.set('mockCache', cache);
    return {
      id: 'mock',
      title: 'Питання дня',
      icon: '🎤',
      summary: item.q,
      data: {
        question: item.q,
        answer: item.a || undefined,
        resourceUrl: resourceFor(item.q),
        topic: item.topic,
      },
      inMessage: false, // глибина — в дашборді; повідомлення лаконічне
      priority: MOCK_PRIORITY,
    };
  },
};
