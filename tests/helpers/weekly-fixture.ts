import { completedWeekPeriod } from '../../web/core/report-period.mjs';
import { WEEKLY_REPORT_FORMAT } from '../../web/core/tools/weekly-summary.mjs';
const NOW = Date.parse('2026-10-26T06:00:00Z');
const sources = Object.fromEntries(
  ['stats', 'state', 'archive', 'weeklyArchive', 'levers', 'plans', 'finance', 'system'].map(
    (key) => [key, { status: 'available' }],
  ),
);
export function conciseFixture() {
  const period = completedWeekPeriod(NOW);
  return {
    packetVersion: 3,
    reportFormat: WEEKLY_REPORT_FORMAT,
    period,
    sources: structuredClone(sources),
    today: '2026-10-25',
    week: { from: period.dateFrom, to: period.dateTo },
    plan: {
      source: 'motivation',
      complete: true,
      summary: {
        acceptedCommitments: 3,
        distinctResults: 2,
        completedDistinctResults: 1,
        lifecycle: { completed: 1, 'completed-late': 1 },
      },
      tasks: [],
    },
    finance: {
      period,
      summary: { expenseMinor: 10000, count: 3 },
      sourceTotals: {
        mono: { expenseMinor: 7000, count: 2 },
        manual: { expenseMinor: 3000, count: 1 },
      },
      categories: [{ category: 'продукти', amountMinor: 10000, count: 3 }],
      categoryBreakdown: {
        top: [{ category: 'продукти', amountMinor: 10000, count: 3 }],
        rest: { amountMinor: 0 },
        otherCategory: { amountMinor: 0 },
        expenseMinor: 10000,
      },
      comparison: {
        complete: true,
        averageExpenseMinor: 12000,
        weeks: [1, 2, 3, 4].map((week) => ({ week, status: 'available', expenseMinor: 12000 })),
      },
      quality: { unknownCurrencyCount: 0, unclassifiedCount: 0, invalidDirectionCount: 0 },
      review: {
        outflows: { expenseMinor: 10000, pendingExpenseMinor: 2000, confirmedExpenseMinor: 8000 },
      },
      context: {
        balances: { complete: true, ownedMinor: 40000 },
        reserves: { complete: true, availableAfterReservesMinor: 30000 },
      },
    },
    system: {
      runs: { total: 20, failed: 1 },
      toolCalls: { total: 18, failed: 0 },
      costs: {
        month: {
          records: 30,
          knownCostRecords: 8,
          unpricedRecords: 22,
          estimatedUsd: 1.23,
          period,
          coverage: { trackingSince: '2026-10-01T00:00:00Z' },
        },
      },
    },
    personalPeriods: {
      current: {
        period,
        observationsV3: { 'morning.energy': { n: 4, sum: 16, average: 4 } },
        coverage: {
          v3: {
            confirmedSlots: 4,
            recordedDays: 4,
            bySlot: { morning: 4, afternoon: 0, evening: 0 },
          },
        },
      },
      previousWeeks: [],
    },
    checkin: {},
    habits: {},
    funnel: {},
    mastery: {},
    interests: {},
    reliability: {},
    archive: {},
  };
}
