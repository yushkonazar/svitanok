import {
  batchSchema,
  contentExcluded,
  publicContent,
} from '../../web/core/brief/daily-content.mjs';
import type { Ctx } from './types.js';
export function reviewedReserve(ctx: Ctx, kind: 'fact' | 'quote'): Record<string, unknown>[] {
  const parsed = batchSchema.safeParse(ctx.bus?.get('dailyContentReserve'));
  if (!parsed.success) return [];
  return (kind === 'fact' ? parsed.data.facts : parsed.data.quotes)
    .filter((n) => !contentExcluded(n))
    .map(publicContent);
}
/** Immutable calendar slot. No paid calls and no preferences-driven replacement mid-day. */
export function preparedDailyContent(
  ctx: Ctx,
  kind: 'fact' | 'quote',
): Record<string, unknown> | null {
  const date = ctx.clock.todayKey(),
    parsed = batchSchema.safeParse(ctx.bus?.get('dailyContentBatch'));
  if (!parsed.success || parsed.data.month !== date.slice(0, 7)) return null;
  const item = (kind === 'fact' ? parsed.data.facts : parsed.data.quotes)[
    Number(date.slice(-2)) - (parsed.data.startDay ?? 1)
  ];
  if (!item || contentExcluded(item)) return null;
  const historyKey = `dailyContentHistory:${kind === 'fact' ? 'facts' : 'quotes'}`;
  const history = ctx.state?.get<Array<{ date: string; id: string }>>(historyKey) ?? [];
  ctx.state?.set(
    historyKey,
    [...history.filter((n) => n.date !== date), { date, id: item.id }]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-365),
  );
  return publicContent(item);
}
