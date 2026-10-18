import { readFinanceAnalytics } from '../finance/analytics-store.mjs';
import { kyivParts, shiftDate } from '../finance/planning.mjs';
import { weekBounds } from '../tools/weekly.mjs';
import { shiftReportCutoff } from '../report-period.mjs';

/** Uses the dashboard reader, classification, source filters and integer amounts.
 * Each baseline stops at the same Kyiv weekday and time as the current slice.
 * @param {Env} env @param {number} asOfMs */
export async function readWeeklyFinance(env, asOfMs) {
  const today = kyivParts(asOfMs).date;
  const week = weekBounds(today);
  const read = async (/** @type {number} */ offset) => {
    const cutoff = shiftReportCutoff(asOfMs, -offset * 7);
    return readFinanceAnalytics(
      env,
      new URLSearchParams({
        from: shiftDate(week.from, -offset * 7),
        to: shiftDate(today, -offset * 7),
        source: 'all',
        account: 'all',
        status: 'all',
      }),
      cutoff,
      false,
      { review: true, context: offset === 0 },
    );
  };
  const current = await read(0);
  const comparisons = await Promise.allSettled([1, 2, 3, 4].map(read));
  const weeks = comparisons.map((result, i) => {
    if (result.status === 'rejected')
      return { week: i + 1, status: 'unavailable', expenseMinor: null };
    const data = result.value;
    const oldest = data.coverage.oldestTransactionAt;
    const covered = oldest != null && String(oldest) <= String(data.selection.period?.from);
    const qualityComplete =
      !data.quality.unknownCurrencyCount &&
      !data.quality.unclassifiedCount &&
      !data.quality.invalidDirectionCount;
    return {
      week: i + 1,
      status: !covered ? 'incomplete-history' : qualityComplete ? 'available' : 'incomplete-data',
      period: data.selection.period,
      expenseMinor: data.summary.expenseMinor,
      count: data.summary.count,
      sourceTotals: data.sourceTotals,
      quality: data.quality,
      outflows: data.review?.outflows,
      repayment: data.review?.repayment,
    };
  });
  const comparisonComplete =
    weeks.every((w) => w.status === 'available') &&
    !current.quality.unknownCurrencyCount &&
    !current.quality.unclassifiedCount &&
    !current.quality.invalidDirectionCount;
  const average = comparisonComplete
    ? weeks.reduce((sum, w) => sum + (w.expenseMinor ?? 0), 0) / 4
    : null;
  const averageWithoutPrincipal = comparisonComplete
    ? weeks.reduce((sum, w) => sum + (w.repayment?.withoutPrincipalMinor ?? 0), 0) / 4
    : null;
  // Keep the four-period numerator exact. Independently rounding category means
  // would make their contributions disagree with the total by several kopecks.
  const names = new Set([
    ...current.categories.filter((c) => c.count).map((c) => c.category),
    ...comparisons.flatMap((r) =>
      r.status === 'fulfilled'
        ? r.value.categories.filter((c) => c.count).map((c) => c.category)
        : [],
    ),
  ]);
  const categories = [...names]
    .map((category) => {
      const row = current.categories.find((c) => c.category === category);
      const baselineTotal = comparisons.reduce(
        (sum, r) =>
          sum +
          (r.status === 'fulfilled'
            ? (r.value.categories.find((c) => c.category === category)?.amountMinor ?? 0)
            : 0),
        0,
      );
      const baselineCount = comparisons.reduce(
        (sum, r) =>
          sum +
          (r.status === 'fulfilled'
            ? (r.value.categories.find((c) => c.category === category)?.count ?? 0)
            : 0),
        0,
      );
      return {
        category,
        amountMinor: row?.amountMinor ?? 0,
        count: row?.count ?? 0,
        baselineObservedMinor: baselineTotal,
        baselineCount,
        averageMinor: comparisonComplete ? baselineTotal / 4 : null,
        changeFourPeriodMinor: comparisonComplete
          ? (row?.amountMinor ?? 0) * 4 - baselineTotal
          : null,
      };
    })
    .sort((a, b) => b.amountMinor - a.amountMinor || a.category.localeCompare(b.category, 'uk'));
  const otherCategory = categories.filter((c) => !c.category.trim() || c.category === 'інше');
  const ranked = categories.filter((c) => c.count && c.category.trim() && c.category !== 'інше');
  const compact = (/** @type {typeof categories} */ rows) => ({
    amountMinor: rows.reduce((sum, c) => sum + c.amountMinor, 0),
    count: rows.reduce((sum, c) => sum + c.count, 0),
    categories: rows.length,
  });
  return {
    scope: { account: 'all', source: 'all', status: 'all', currency: 'UAH', unit: 'kopecks' },
    period: current.selection.period,
    summary: current.summary,
    sourceTotals: current.sourceTotals,
    categories,
    categoryBreakdown: {
      top: ranked.slice(0, 3),
      rest: compact(ranked.slice(3)),
      otherCategory: compact(otherCategory),
      expenseMinor: categories.reduce((sum, c) => sum + c.amountMinor, 0),
      changeFourPeriodMinor: comparisonComplete
        ? categories.reduce((sum, c) => sum + (c.changeFourPeriodMinor ?? 0), 0)
        : null,
      unclassifiedOutsideExpenses: {
        count: current.quality.unclassifiedCount,
        outflowMinor: current.quality.unclassifiedOutflowMinor,
        inflowMinor: current.quality.unclassifiedInflowMinor,
        unknownCurrencyCount: current.quality.unclassifiedUnknownCurrencyCount,
      },
    },
    largestCategoryChanges: comparisonComplete
      ? [...categories]
          .sort(
            (a, b) =>
              Math.abs(b.changeFourPeriodMinor ?? 0) - Math.abs(a.changeFourPeriodMinor ?? 0),
          )
          .slice(0, 3)
      : [],
    review: current.review,
    context: current.context,
    quality: current.quality,
    coverage: current.coverage,
    comparison: {
      method: 'four-matching-weekday-and-time-slices',
      weeks,
      complete: comparisonComplete,
      averageExpenseMinor: average,
      changeBps: average ? Math.round((current.summary.expenseMinor / average - 1) * 10_000) : null,
      excludingDebtPrincipal: {
        policy: 'linked-exact-debt-principal-only',
        currentMinor: current.review?.repayment.withoutPrincipalMinor ?? null,
        averageMinor: averageWithoutPrincipal,
        changeBps: averageWithoutPrincipal
          ? Math.round(
              ((current.review?.repayment.withoutPrincipalMinor ?? 0) / averageWithoutPrincipal -
                1) *
                10_000,
            )
          : null,
      },
    },
  };
}
