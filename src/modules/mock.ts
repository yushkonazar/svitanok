// mock (consumer). «Питання дня» для підготовки до співбесіди — LLM, але
// ЕКОНОМНО: батч-кеш (як fact). Коли state.mockCache порожній, один claude -p
// генерує batchSize питань під стек; далі щодня одне без LLM (~1 виклик/2 тижні).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { parseFacts } from './fact.js'; // спільний парсер JSON-масиву рядків

const MOCK_PRIORITY = 58; // після вакансій (55), перед next-step

export function buildMockPrompt(n: number, profile: string): string {
  return [
    `Згенеруй рівно ${n} коротких питань для технічної співбесіди.`,
    `Профіль кандидата: ${profile}.`,
    'Різні теми (мова, фреймворк, HTTP, бази даних, алгоритми, патерни).',
    'Кожне питання — одне речення, без нумерації та без відповіді.',
    'Поверни ЛИШЕ валідний JSON-масив рядків, без прози: ["питання", "питання", ...]',
  ].join(' ');
}

export const mockModule: Module<AppConfig> = {
  id: 'mock',
  kind: 'consumer',
  enabled: (config) => config.modules.mock.enabled,

  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const cfg = ctx.config.modules.mock;
    let cache = ctx.state.get<string[]>('mockCache') ?? [];

    if (cache.length === 0) {
      try {
        const out = await ctx.llm.complete(buildMockPrompt(cfg.batchSize, cfg.profile), {
          timeoutMs: ctx.config.llm.timeoutMs,
        });
        cache = parseFacts(out);
      } catch (e) {
        ctx.log.warn(`mock: генерація не вдалася: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      if (cache.length === 0) return null;
    }

    const question = cache.shift()!;
    ctx.state.set('mockCache', cache);
    return {
      id: 'mock',
      title: 'Питання дня',
      icon: '🎤',
      summary: question,
      data: { question },
      priority: MOCK_PRIORITY,
    };
  },
};
