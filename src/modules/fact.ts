// Source-reviewed editorial catalog. Never publish unverified legacy LLM strings.
// One stable item per Kyiv calendar day; retries do not consume another fact.
import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import catalog from '../data/verified-facts.json' with { type: 'json' };

export interface VerifiedFact {
  id: string;
  fact: string;
  sourceUrl: string;
  sourceName: string;
  verifiedAt: string;
}
export function resolveFact(todayKey: string): VerifiedFact | null {
  const day = Date.parse(`${todayKey}T00:00:00Z`);
  if (!Number.isFinite(day) || !catalog.length) return null;
  const offset = Math.floor((day - Date.parse('2026-10-04T00:00:00Z')) / 86400000);
  return catalog[((offset % catalog.length) + catalog.length) % catalog.length] ?? null;
}
export const factModule: Module<AppConfig> = {
  id: 'fact',
  kind: 'consumer',
  enabled: (config) => config.modules.fact.enabled,
  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const date = ctx.clock.todayKey();
    const saved = ctx.state.get<{ date: string; id: string }>('verifiedFactDay');
    const fact =
      (saved?.date === date ? catalog.find((item) => item.id === saved.id) : null) ??
      resolveFact(date);
    if (!fact) return null;
    ctx.state.set('verifiedFactDay', { date, id: fact.id });
    return {
      id: 'fact',
      title: 'Факт дня',
      icon: '🧠',
      summary: fact.fact,
      data: fact,
      priority: 20,
    };
  },
};
