// weekly-review (consumer, неділя, §6). Багатший підсумок тижня: скільки новин
// показано, які кроки до офера пройдено. Retention 7 днів. Показується ЗАВЖДИ в
// неділю (навіть у тихий день, §4.1 п.5) — orchestrator не вмикає quiet у неділю.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import type { NextStepLogEntry } from './next-step.js';

export const RETENTION_DAYS = 7;

export function withinDays(dateStr: string, days: number, now: number): boolean {
  const t = Date.parse(dateStr);
  return Number.isFinite(t) && t >= now - days * 86400_000;
}

export const weeklyReviewModule: Module<AppConfig> = {
  id: 'weekly-review',
  kind: 'consumer',
  enabled: (config) => config.modules.weeklyReview.enabled,
  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    if (!ctx.clock.isSunday()) return null; // лише в неділю

    const now = ctx.clock.now().getTime();
    const shown = ctx.state.get<Record<string, string>>('shownNews') ?? {};
    const newsCount = Object.values(shown).filter((d) => withinDays(d, RETENTION_DAYS, now)).length;

    const log = ctx.state.get<NextStepLogEntry[]>('nextStepLog') ?? [];
    const steps = [
      ...new Set(log.filter((e) => withinDays(e.date, RETENTION_DAYS, now)).map((e) => e.step)),
    ];

    const summary = `Минулого тижня: ${newsCount} новин, ${steps.length} кроків до офера.`;
    const detail = steps.length ? steps.map((s) => `• ${s}`).join('\n') : undefined;

    return {
      id: 'weekly-review',
      title: 'Підсумок тижня',
      icon: '📊',
      summary,
      detail,
      data: { newsCount, steps }, // Mini App (чат тепер лише [дата]+кнопка, без detail)
      priority: 5, // зверху в неділю (замінює звичайний набір, §5)
    };
  },
};
