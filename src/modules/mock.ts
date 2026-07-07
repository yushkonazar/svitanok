// mock (consumer). «Питання дня» для підготовки до співбесіди — LLM, але
// ЕКОНОМНО: батч-кеш. Коли state.mockCache порожній, один claude -p генерує
// batchSize пар питання+відповідь під стек; далі щодня одну без LLM. Розкриття в
// дашборді показує відповідь + кнопку «Вивчити» (детермінований пошук теми).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

const MOCK_PRIORITY = 58; // після вакансій (55), перед next-step

export interface MockQA {
  q: string;
  a: string;
}

export function buildMockPrompt(n: number, profile: string): string {
  return [
    `Згенеруй рівно ${n} пар «питання–відповідь» для технічної співбесіди.`,
    `Профіль кандидата: ${profile}.`,
    'Різні теми (мова, фреймворк, HTTP, бази даних, алгоритми, патерни).',
    'Питання — одне речення. Відповідь — 1–2 речення, стисло й точно, українською.',
    'Поверни ЛИШЕ валідний JSON-масив об\'єктів без прози: [{"q":"питання","a":"відповідь"}, ...]',
  ].join(' ');
}

/** Розпарсити масив {q,a} з відповіді LLM; малформат/порожні -> відкидаємо. */
export function parseMockCache(text: string): MockQA[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is { q: string; a?: unknown } =>
          !!x && typeof x === 'object' && typeof (x as { q?: unknown }).q === 'string',
      )
      .map((x) => ({ q: x.q.trim(), a: typeof x.a === 'string' ? x.a.trim() : '' }))
      .filter((x) => x.q.length > 0);
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
    // Старий формат кешу (string[] без відповідей) -> відкидаємо, щоб одразу
    // регенерувати з відповідями. Новий формат ({q,a}) — лишаємо.
    const raw = ctx.state.get<unknown[]>('mockCache') ?? [];
    const isNewFormat =
      raw.length > 0 &&
      raw.every((x) => !!x && typeof x === 'object' && typeof (x as MockQA).q === 'string');
    let cache: MockQA[] = isNewFormat ? (raw as MockQA[]).filter((x) => x.q && x.q.length > 0) : [];

    if (cache.length === 0) {
      try {
        const out = await ctx.llm.complete(buildMockPrompt(cfg.batchSize, cfg.profile), {
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
      },
      inMessage: false, // глибина — в дашборді; повідомлення лаконічне
      priority: MOCK_PRIORITY,
    };
  },
};
