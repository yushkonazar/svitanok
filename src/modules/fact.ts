// fact (consumer). «Факт дня» через LLM, але ЕКОНОМНО — батч-кеш: коли
// state.factCache порожній, ОДИН виклик генерує batchSize фактів; далі щодня
// беремо один без LLM. Тобто ~1 виклик на batchSize днів (нуль квоти решту часу).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

const FACT_PRIORITY = 20; // слот колишнього «На сьогодні», під стоїком

/** Витягти JSON-масив рядків із виводу LLM (можлива проза навколо). */
export function parseFacts(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function buildFactsPrompt(n: number): string {
  return [
    `Згенеруй рівно ${n} коротких цікавих фактів українською мовою`,
    '(наука, історія, космос, природа, технології, мова).',
    'Кожен факт — одне-два речення, самодостатній, без нумерації та без повторів.',
    'Поверни ЛИШЕ валідний JSON-масив рядків, без прози: ["факт", "факт", ...]',
  ].join(' ');
}

export const factModule: Module<AppConfig> = {
  id: 'fact',
  kind: 'consumer',
  enabled: (config) => config.modules.fact.enabled,

  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const cfg = ctx.config.modules.fact;
    let cache = ctx.state.get<string[]>('factCache') ?? [];

    if (cache.length === 0) {
      try {
        const out = await ctx.llm.complete(buildFactsPrompt(cfg.batchSize), {
          timeoutMs: ctx.config.llm.timeoutMs,
        });
        cache = parseFacts(out);
      } catch (e) {
        ctx.log.warn(`fact: генерація не вдалася: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      if (cache.length === 0) return null;
    }

    const fact = cache.shift()!;
    ctx.state.set('factCache', cache);
    return {
      id: 'fact',
      title: 'Факт дня',
      icon: '🧠',
      summary: fact,
      data: { fact },
      buttons: [[{ label: '🔖 Зберегти', action: 'sf' }]],
      priority: FACT_PRIORITY,
    };
  },
};
