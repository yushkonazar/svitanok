import { describe, expect, it } from 'vitest';
import { buildWeeklyDigest } from '../web/core/tools/weekly.mjs';
import { compactWeeklyDetails } from '../web/core/tools/weekly-compaction.mjs';
import { weeklyPacketQuality } from '../web/core/brain/weekly-report-quality.mjs';
import { weeklyPersonalPeriods } from '../web/core/brain/weekly-personal.mjs';

const TODAY = '2026-10-18';
const NOW = Date.parse('2026-10-18T15:55:00Z');
const sources = Object.fromEntries(
  ['stats', 'state', 'archive', 'weeklyArchive', 'levers', 'plans', 'finance', 'system'].map(
    (key) => [key, { status: 'available' }],
  ),
);

// Synthetic volume and structure; no production snapshot is stored in Git.
function largeInput() {
  const categories = Array.from({ length: 16 }, (_, i) => ({
    category: `категорія-${i}`,
    amountMinor: 1000 + i,
    count: 5,
  }));
  const operations = Array.from({ length: 40 }, (_, i) => ({
    id: `op-${i}`,
    at: '2026-10-13T09:00:00Z',
    amountMinor: 100 + i,
    description: 'Деталі операції '.repeat(30),
    reason: 'Потрібна звірка',
  }));
  const period = {
    from: '2026-10-11T21:00:00.000Z',
    to: '2026-10-18T15:55:00.001Z',
    asOf: new Date(NOW).toISOString(),
  };
  const personal = weeklyPersonalPeriods(
    {
      '2026-10-12': {
        morning: { questionVersion: 3, confirmed: true, energy: 4, sleepMinutesV3: 420 },
        evening: { questionVersion: 3, confirmed: true, energy: 3, dayScore: 4 },
      },
    },
    NOW,
  );
  const tasks = Array.from({ length: 8 }, (_, i) => ({
    id: `task-${i}`,
    title: `Задача ${i}`,
    dueAt: '2026-10-17T20:00:00Z',
    resultKey: `result-${i}`,
    outcome: 'on-time',
    outcomeNote: 'Зроблено й перевірено',
  }));
  const summary = {
    expenseMinor: categories.reduce((n, row) => n + row.amountMinor, 0),
    count: 80,
  };
  return {
    todayKey: TODAY,
    cap: 50_000,
    sources,
    period,
    personalPeriods: personal,
    agg: {
      checkinRaw: {
        days: 90,
        records: Object.fromEntries(
          Array.from({ length: 90 }, (_, i) => [
            new Date(NOW - i * 86400000).toISOString().slice(0, 10),
            { morning: { note: 'Сирі особисті деталі '.repeat(200) } },
          ]),
        ),
      },
      checkinFill: { recordedDays: 0 },
      checkinWeekly: [{ n: 6, sleepAvg: 7 }],
      streaks: { current: 9, best: 12 },
      funnel: { applied: 7, interview: 2 },
      funnelList: Array.from({ length: 30 }, (_, i) => ({
        title: `Вакансія ${i}`,
        history: operations,
      })),
      mock: { seen: 12, weak: 3 },
      interests: [{ topic: 'Інженерія', count: 8 }],
      reliability: { onTime: 20, total: 21, deadman: 1, days: operations },
      checkinModel: { coefficients: [[0.25, 0.1, 0.4]], pairs: 24 },
    },
    plans: {
      complete: true,
      summary: { accepted: 8, uniqueResults: 8, onTime: 8 },
      tasks,
      explanations: tasks.map((t) => ({ taskId: t.id, reason: 'Уточнив обсяг перед початком' })),
    },
    finance: {
      period,
      summary,
      sourceTotals: {
        mono: { expenseMinor: 10000 },
        manual: { expenseMinor: summary.expenseMinor - 10000 },
      },
      categories,
      categoryBreakdown: { top: categories.slice(0, 3) },
      comparison: {
        complete: true,
        averageExpenseMinor: 20000,
        weeks: Array.from({ length: 4 }, (_, i) => ({
          period: { from: `baseline-${i}`, to: `cutoff-${i}` },
          expenseMinor: 20000,
          count: 50,
          repayment: { unverifiedCount: 40, unverifiedMinor: 4780, unverified: operations },
        })),
      },
      review: {
        outflows: { confirmedMinor: summary.expenseMinor - 4780, pendingMinor: 4780 },
        pending: { count: 40, expenseMinor: 4780, operations },
        unusual: { count: 40, operations },
      },
      context: {
        balances: { complete: true, ownedMinor: 90000 },
        reserves: { complete: true, availableAfterReservesMinor: 70000 },
        bankFreshness: { lastCompletedStatementRefreshAt: '2026-10-18T15:00:00Z' },
        upcoming: { complete: true, count: 40, amountMinor: 4780, payments: operations },
        overdue: { count: 0, payments: [] },
        detectedSubscriptions: { count: 0, items: [] },
      },
    },
    system: {
      runs: { total: 20, failed: 0, errors: [] },
      toolCalls: { total: 18, failed: 0, errors: [] },
      costs: { month: { records: 0, unpricedRecords: 0 }, selected: { records: 0 } },
      secrets: {
        entries: operations,
        counts: { configured: 7, needsReview: 40 },
        needsReview: operations,
      },
    },
    archive: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`2026-0${i + 1}`, { checkinDays: 20 }]),
    ),
    weeklyArchive: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        new Date(NOW - i * 7 * 86400000).toISOString().slice(0, 10),
        { checkinDays: 6, sleepAvg: 7 },
      ]),
    ),
  };
}

describe('bounded weekly packet retains decision summaries', () => {
  it('retains recent weeks with aligned interest series and marks reduced older context', () => {
    const weeks = Array.from({ length: 12 }, (_, i) =>
      new Date(NOW - (11 - i) * 7 * 86400000).toISOString().slice(0, 10),
    );
    const doc = {
      habits: { habitWeekly: weeks.map((week, i) => ({ week, active: i % 7 })) },
      interests: {
        trend: { weeks, topics: [{ topic: 'Інженерія', series: weeks.map((_, i) => i) }] },
      },
      personalPeriods: {
        current: {},
        previousWeeks: [
          {},
          {
            observationsV3: { 'morning.companyV3': { n: 5, counts: { alone: 2, family: 3 } } },
          },
        ],
      },
    };
    for (const level of [1, 2, 3, 4]) compactWeeklyDetails(doc, level);
    expect(doc.habits.habitWeekly.map((r) => r.week)).toEqual(weeks.slice(-3));
    expect(doc.interests.trend.weeks).toEqual(weeks.slice(-3));
    expect(doc.interests.trend.topics[0]?.series).toEqual([9, 10, 11]);
    expect(weeklyPacketQuality(doc).missing).toContain('personal-context-coverage');
  });

  it('fits a large packet while preserving finance, all four baselines and current task explanations', () => {
    const input = largeInput();
    const before = JSON.stringify(input);
    expect(before.length).toBeGreaterThan(150000);
    const { text } = buildWeeklyDigest(input);
    expect(text.length).toBeLessThanOrEqual(50000);
    const doc = JSON.parse(text);
    expect(doc.dropped).toEqual([]);
    expect(doc.compaction.summariesPreserved).toBe(true);
    for (const field of [
      'checkin',
      'index',
      'habits',
      'funnel',
      'mastery',
      'interests',
      'reliability',
      'plan',
      'archive',
      'personalPeriods',
      'finance',
      'system',
    ])
      expect(doc[field], field).not.toBeNull();
    expect(doc.finance.summary).toEqual(input.finance.summary);
    expect(doc.finance.sourceTotals).toEqual(input.finance.sourceTotals);
    expect(doc.finance.categories).toEqual(input.finance.categories);
    expect(doc.finance.review.outflows).toEqual(input.finance.review.outflows);
    expect(
      doc.finance.comparison.weeks.map((w: { expenseMinor: number; period: unknown }) => [
        w.expenseMinor,
        w.period,
      ]),
    ).toEqual(input.finance.comparison.weeks.map((w) => [w.expenseMinor, w.period]));
    expect(doc.finance.context.balances).toEqual(input.finance.context.balances);
    expect(doc.finance.context.bankFreshness).toEqual(input.finance.context.bankFreshness);
    expect(doc.finance.review.pending).toMatchObject({
      count: 40,
      expenseMinor: 4780,
      truncated: true,
    });
    expect(doc.finance.review.pending.operations.length).toBeGreaterThanOrEqual(8);
    expect(doc.plan).toEqual(input.plans);
    expect(doc.funnel.counts).toEqual(input.agg.funnel);
    expect(doc.reliability).toMatchObject({ onTime: 20, total: 21, deadman: 1 });
    expect(doc.checkin.fill).toMatchObject({ questionnaire: 'legacy', allVersionCoverage: false });
    expect(doc.personalPeriods).toMatchObject({
      current: { coverage: input.personalPeriods.current.coverage },
    });
    const quality = weeklyPacketQuality(doc);
    expect(quality.missing).toEqual(
      expect.arrayContaining(['finance-evidence-coverage', 'finance-context-coverage']),
    );
    expect(quality.missing).not.toEqual(expect.arrayContaining(['truncated-data']));
    expect(quality.missing.filter((code) => code.endsWith('-summary'))).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('does not call detail compaction an unavailable source or lose numeric denominators and tuples', () => {
    const input = largeInput();
    input.finance.review.pending.operations = [];
    input.finance.review.unusual.operations = [];
    input.finance.context.upcoming.payments = [];
    input.finance.comparison.weeks.forEach((w) => {
      w.repayment.unverified = [];
    });
    const numeric = {
      label: 'Енергія',
      n: 3,
      numericN: 3,
      sum: 12,
      average: 4,
      counts: { 3: 1, 4: 1, 5: 1 },
    };
    const doc = JSON.parse(buildWeeklyDigest(input).text);
    doc.personalPeriods.current.observationsV3['morning.energy'] = structuredClone(numeric);
    compactWeeklyDetails(doc, 3);
    expect(doc.personalPeriods.current.observationsV3['morning.energy']).toMatchObject({
      n: 3,
      sum: 12,
      average: 4,
      min: 3,
      max: 5,
    });
    expect(doc.index.coefficients).toEqual([[0.25, 0.1, 0.4]]);
    expect(weeklyPacketQuality(doc).missing).toEqual([]);
    doc.system.costs.month.unpricedRecords = 2;
    expect(weeklyPacketQuality(doc).missing).toContain('system-cost-coverage');
  });

  it('reports an unusable manifest when even summaries exceed the cap', () => {
    const doc = JSON.parse(buildWeeklyDigest({ ...largeInput(), cap: 500 }).text);
    expect(doc.truncated).toBe(true);
    expect(weeklyPacketQuality(doc).missing).toContain('truncated-data');
    expect(weeklyPacketQuality({ packetVersion: 2, sources }).missing).toEqual(
      expect.arrayContaining([
        'finance-summary',
        'system-summary',
        'plans-summary',
        'personal-summary',
      ]),
    );
  });

  it('marks shortened task explanations as partial evidence even when the list fits', () => {
    const doc = {
      sources,
      plan: {
        summary: { accepted: 1 },
        explanations: [{ taskId: 'task-1', reason: 'Довге пояснення '.repeat(100) }],
      },
    };
    compactWeeklyDetails(doc, 1);
    expect(doc.plan.explanations).toHaveLength(1);
    expect(doc.plan.explanations[0]?.reason.length).toBe(240);
    expect(weeklyPacketQuality(doc).missing).toContain('plan-coverage');
    expect(doc.plan.summary).toEqual({ accepted: 1 });
  });

  it('counts confirmed new questionnaire slots independently of legacy and unfinished answers', () => {
    const records = {
      '2026-10-12': {
        morning: { questionVersion: 3, confirmed: true, energy: 4 },
        evening: { questionVersion: 3, confirmed: true, dayScore: 4 },
      },
      '2026-10-13': { morning: { questionVersion: 3, confirmed: false, energy: 2 } },
      '2026-10-14': { afternoon: { questionVersion: 2, confirmed: true, energy: 3 } },
      '2026-10-18': {
        evening: {
          questionVersion: 3,
          confirmed: true,
          confirmedAtV3: '2026-10-18T18:00:00Z',
          dayScore: 1,
        },
      },
    };
    const before = JSON.stringify(records);
    const { current } = weeklyPersonalPeriods(records, NOW);
    expect(current.coverage).toEqual({
      legacy: { recordedDays: 0, scope: 'legacy-only' },
      v2: { recordedDays: 1, confirmedSlots: 1, bySlot: { morning: 0, afternoon: 1, evening: 0 } },
      v3: { recordedDays: 1, confirmedSlots: 2, bySlot: { morning: 1, afternoon: 0, evening: 1 } },
    });
    expect(JSON.stringify(records)).toBe(before);
  });
});
