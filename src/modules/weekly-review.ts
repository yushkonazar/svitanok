// weekly-review (consumer, неділя, §6). Підсумок тижня: скільки новин показано,
// прогрес роадмепу, слабкі теми. Retention 7 днів. Показується ЗАВЖДИ в неділю
// (навіть у тихий день, §4.1 п.5) — orchestrator не вмикає quiet у неділю.
//
// Фаза B5: +roadmapDone/weakTopics — БЕЗ нової інфраструктури: обидва вже
// лежать у тому самому 'state'-блобі (roadmapProgress пише Worker,
// mockWeights пише Worker) і читаються тут pass-through, як і shownNews.
// roadmapDone — це ЗАГАЛЬНИЙ лічильник (усі позначені пункти коли-небудь, не лише
// за тиждень) — чесно позначено «загалом» у повідомленні (orchestrator.ts
// formatWeeklyReviewMessage), не «цього тижня». Метрики Фази A
// (funnel/interests/reliability) НЕ читаються — вони живуть в окремому KV-блобі
// 'stats', якого createKvStateStore не бачить взагалі.
//
// D4: «кроки до офера» прибрано разом із модулем next-step.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { weakMockTopics, type MockWeights } from './mock.js';

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

    const roadmapProgress = ctx.state.get<Record<string, string>>('roadmapProgress') ?? {};
    const roadmapDone = Object.keys(roadmapProgress).length;
    const weights = ctx.state.get<MockWeights>('mockWeights') ?? {};
    const weakTopics = weakMockTopics(weights);

    const summary = `Минулого тижня: ${newsCount} новин.`;

    return {
      id: 'weekly-review',
      title: 'Підсумок тижня',
      icon: '📊',
      summary,
      // Mini App (data) + недільне Telegram-повідомлення (orchestrator.ts,
      // Фаза B5 читає ці самі поля).
      data: { newsCount, roadmapDone, weakTopics },
      priority: 5, // зверху в неділю (замінює звичайний набір, §5)
    };
  },
};
