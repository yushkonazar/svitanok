import type { AnalyticsRequest, FinanceAnalytics } from '../api/finance-analytics-schema.ts';
import { analyticsPeriod } from '../../../core/finance/analytics.mjs';
import { kyivParts } from '../../../core/finance/planning.mjs';

export function todaySpendingRequest(nowMs: number): AnalyticsRequest {
  return { ...analyticsPeriod('week', nowMs), comparison: 'week', status: 'confirmed' };
}
export function todaySpendingInsight(
  data: Pick<FinanceAnalytics, 'coverage' | 'summary' | 'categories' | 'quality' | 'selection'>,
) {
  const oldest = Date.parse(data.coverage.oldestTransactionAt ?? '');
  const covered =
    Number.isFinite(oldest) &&
    kyivParts(oldest).date <= data.selection.previousFrom &&
    !data.coverage.previousBeforeFirstRecord &&
    !data.coverage.beyondBankRetention;
  const comparable = covered && !data.quality.comparisonIncomplete;
  const change = comparable ? data.summary.changeBps : null;
  const direction = Math.sign(data.summary.changeMinor);
  const driver =
    comparable && direction !== 0
      ? (data.categories
          .filter((row) => Math.sign(row.deltaMinor) === direction)
          .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))[0] ?? null)
      : null;
  return { covered, comparable, change, driver };
}
