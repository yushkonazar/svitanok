// Source-reviewed editorial catalog. Never publish unverified legacy LLM strings.
// One stable item per Kyiv calendar day; retries do not consume another fact.
import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import originalCatalog from '../data/verified-facts.json' with { type: 'json' };
import { octoberFacts } from '../data/content-october.js';
import { monthlyContent } from '../core/monthly-content.js';
import { preparedDailyContent, reviewedReserve } from '../core/daily-content.js';
import { contentExcluded } from '../../web/core/brief/daily-content.mjs';
const catalog = [...originalCatalog, ...octoberFacts].filter((n) => !contentExcluded(n));

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
    const pool = [...catalog, ...(reviewedReserve(ctx, 'fact') as unknown as VerifiedFact[])];
    const saved = ctx.state.get<{ date: string; id: string }>('verifiedFactDay');
    const fact =
      (saved?.date === date ? pool.find((item) => item.id === saved.id) : null) ??
      (preparedDailyContent(ctx, 'fact') as unknown as VerifiedFact | null) ??
      monthlyContent('facts', date, pool, ctx.state, (n) => n.id, resolveFact);
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
