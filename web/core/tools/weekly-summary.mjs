// A finite projection, rather than recursive truncation of an unbounded object.
// No raw answers, ledger events, credentials or provider inventories are retained.
import { summarizeWeeklyPatterns } from '../brain/weekly-patterns.mjs';

export const WEEKLY_REPORT_FORMAT = 'compact-weekly-v1';
const PERIOD = ['from', 'to', 'dateFrom', 'dateTo', 'asOf', 'timeZone', 'complete'];
const MONEY = ['expenseMinor', 'incomeMinor', 'netMinor', 'count', 'amountMinor', 'categories'];
const COVERAGE = ['legacy', 'v2', 'v3'];
const METRICS = [
  'morning.sleepMinutesV3',
  'morning.sleepQualityV3',
  'morning.energy',
  'morning.mood',
  'afternoon.energy',
  'afternoon.mood',
  'evening.energy',
  'evening.mood',
  'evening.dayScore',
  'sleepHours',
  'sleepQuality',
  'satisfaction',
];

/** @param {any} value @param {string[]} keys @param {number} [chars] */
function pick(value, keys, chars = 120) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(
    keys
      .filter((key) => key in value)
      .flatMap((key) => {
        const v = value[key];
        if (v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
          return [[key, v]];
        return typeof v === 'string' ? [[key, v.slice(0, chars)]] : [];
      }),
  );
}
/** Finite application-defined maps (e.g. lifecycle counters), never raw strings.
 * @param {any} value @param {number} [max] */
function counters(value, max = 16) {
  return value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
          .slice(0, max)
          .map(([key, v]) => [key.slice(0, 50), v]),
      )
    : null;
}
/** @param {any} value */
function sources(value) {
  return Object.fromEntries(
    [
      'stats',
      'state',
      'archive',
      'weeklyArchive',
      'levers',
      'plans',
      'finance',
      'system',
      'runs',
      'quotas',
      'secrets',
      'toolCalls',
      'costs',
      'selectedUsage',
      'monthUsage',
      'budgets',
      'billing',
    ]
      .filter((key) => value?.[key])
      .map((key) => [key, pick(value[key], ['status', 'reason'], 100)]),
  );
}
/** @param {any} value @param {string[]} keys @param {number} [max] */
function rows(value, keys, max = 3) {
  return Array.isArray(value) ? value.slice(0, max).map((row) => pick(row, keys)) : [];
}
/** @param {any} value */
const weekDates = (value) =>
  Array.isArray(value)
    ? value
        .filter(
          (date) =>
            typeof date === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(date) &&
            Number.isFinite(Date.parse(date)),
        )
        .slice(0, 7)
    : [];
/** @param {any} value */
function weekHighlights(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(
      (item) =>
        ['sleep', 'mood', 'energy', 'plans'].includes(item?.key) &&
        typeof item.title === 'string' &&
        typeof item.text === 'string' &&
        Number.isFinite(item.samples),
    )
    .slice(0, 3)
    .map((item) => ({
      ...pick(item, ['key', 'title', 'text', 'samples'], 240),
      dates: weekDates(item.dates),
      context: Array.isArray(item.context)
        ? item.context
            .filter(
              (/** @type {any} */ evidence) =>
                ['observed', 'reported'].includes(evidence?.kind) &&
                typeof evidence.text === 'string',
            )
            .slice(0, 3)
            .map((/** @type {any} */ evidence) => ({
              ...pick(evidence, ['kind', 'text', 'idea'], 240),
              dates: weekDates(evidence.dates),
            }))
        : [],
    }));
}
/** @param {any} p */
function personalPeriod(p) {
  if (!p) return null;
  const metric = (/** @type {any} */ value) =>
    pick(value, ['n', 'sum', 'average', 'min', 'max', 'numericN']);
  const metrics = (/** @type {any} */ value, /** @type {string[]} */ names) =>
    Object.fromEntries(
      names.filter((name) => value?.[name]).map((name) => [name, metric(value[name])]),
    );
  return {
    period: pick(p.period, PERIOD),
    unknownTimingSlots: p.unknownTimingSlots,
    patterns: summarizeWeeklyPatterns(p.patterns),
    weekHighlights: weekHighlights(p.weekHighlights),
    legacy: metrics(p.legacy, [
      'sleepHours',
      'sleepQuality',
      'dayScore',
      'morningEnergy',
      'eveningEnergy',
      'mood',
    ]),
    observationsV2: metrics(p.observationsV2, METRICS),
    observationsV3: metrics(p.observationsV3, METRICS),
    coverage: Object.fromEntries(
      COVERAGE.map((version) => [
        version,
        {
          ...pick(p.coverage?.[version], ['recordedDays', 'confirmedSlots', 'scope']),
          bySlot: pick(p.coverage?.[version]?.bySlot, ['morning', 'afternoon', 'evening']),
        },
      ]),
    ),
  };
}
/** @param {any} plan */
function planSummary(plan) {
  if (!plan) return null;
  const tasks = (/** @type {any} */ list, /** @type {number} */ max) =>
    rows(
      list,
      [
        'id',
        'resultId',
        'title',
        'date',
        'source',
        'status',
        'lifecycle',
        'dueAt',
        'acceptedAt',
        'units',
        'eligibleUnits',
        'target',
        'onTimeUnits',
        'outcomeNote',
        'exceptionReason',
      ],
      max,
    );
  return {
    ...pick(plan, [
      'source',
      'snapshot',
      'enabled',
      'dayBoundary',
      'complete',
      'snapshotAfterCutoff',
      'unknownReportTimingCount',
      'tasksTruncated',
      'explanationsTruncated',
    ]),
    period: pick(plan.period, PERIOD),
    summary: { ...counters(plan.summary, 24), lifecycle: counters(plan.summary?.lifecycle) },
    tasks: tasks(plan.tasks, 10),
    taskDetailsOmitted: Boolean(plan.taskDetailsOmitted || (plan.tasks?.length ?? 0) > 10),
    explanations: rows(plan.explanations, ['at', 'kind', 'taskId', 'reason'], 3),
    explanationDetailsOmitted: Boolean(
      plan.explanationDetailsOmitted || (plan.explanations?.length ?? 0) > 3,
    ),
    overdueBeforePeriod: {
      ...pick(plan.overdueBeforePeriod, ['count', 'truncated']),
      tasks: tasks(plan.overdueBeforePeriod?.tasks, 3),
    },
    upcomingOutsidePeriod: {
      ...pick(plan.upcomingOutsidePeriod, ['count', 'truncated']),
      tasks: tasks(plan.upcomingOutsidePeriod?.tasks, 3),
    },
  };
}
/** @param {any} r */
function repayment(r) {
  return pick(r, [
    'policy',
    'principalMinor',
    'interestAndFeesMinor',
    'withoutPrincipalMinor',
    'exclusionCount',
    'exclusionsTruncated',
    'unverifiedCount',
    'unverifiedMinor',
    'unverifiedTruncated',
  ]);
}
/** @param {any} value */
function payments(value) {
  return value
    ? {
        ...pick(value, [
          'complete',
          'count',
          'amountMinor',
          'knownTotalMinor',
          'unknownAmountCount',
          'truncated',
          'from',
          'to',
          'currency',
        ]),
        payments: rows(value.payments, [
          'id',
          'name',
          'date',
          'amountMinor',
          'currency',
          'kind',
          'overdue',
        ]),
        detailsOmitted: Boolean(value.detailsOmitted || (value.payments?.length ?? 0) > 3),
      }
    : null;
}
/** @param {any} f */
export function weeklyFinanceSummary(f) {
  if (!f) return null;
  const category = ['category', 'amountMinor', 'count', 'averageMinor', 'changeFourPeriodMinor'];
  const c = f.context;
  return {
    scope: pick(f.scope, ['account', 'source', 'status', 'currency', 'unit']),
    period: pick(f.period, PERIOD),
    summary: pick(f.summary, MONEY),
    sourceTotals: Object.fromEntries(
      ['mono', 'manual'].map((source) => [source, pick(f.sourceTotals?.[source], MONEY)]),
    ),
    categories: rows(f.categories, category, 24),
    categoryDetailsOmitted: Boolean(f.categoryDetailsOmitted || (f.categories?.length ?? 0) > 24),
    categoryBreakdown: f.categoryBreakdown
      ? {
          top: rows(f.categoryBreakdown.top, category),
          rest: pick(f.categoryBreakdown.rest, MONEY),
          otherCategory: pick(f.categoryBreakdown.otherCategory, MONEY),
          expenseMinor: f.categoryBreakdown.expenseMinor,
          unclassifiedOutsideExpenses: pick(f.categoryBreakdown.unclassifiedOutsideExpenses, [
            'count',
            'outflowMinor',
            'inflowMinor',
            'unknownCurrencyCount',
          ]),
        }
      : null,
    quality: pick(f.quality, [
      'unknownCurrencyCount',
      'unclassifiedCount',
      'invalidDirectionCount',
      'unclassifiedOutflowMinor',
      'unclassifiedInflowMinor',
      'unclassifiedUnknownCurrencyCount',
    ]),
    coverage: pick(f.coverage, ['oldestTransactionAt', 'complete']),
    comparison: f.comparison
      ? {
          ...pick(f.comparison, ['method', 'complete', 'averageExpenseMinor', 'changeBps']),
          previousWeek: f.comparison.previousWeek
            ? {
                ...pick(f.comparison.previousWeek, [
                  'complete',
                  'expenseMinor',
                  'changeMinor',
                  'changeBps',
                ]),
                categoryChanges: rows(f.comparison.previousWeek.categoryChanges, [
                  'category',
                  'amountMinor',
                  'previousMinor',
                  'changeMinor',
                ]),
              }
            : null,
          weeks: (f.comparison.weeks ?? []).slice(0, 4).map((/** @type {any} */ week) => ({
            ...pick(week, ['week', 'status', 'expenseMinor', 'count']),
            period: pick(week.period, PERIOD),
            quality: pick(week.quality, [
              'unknownCurrencyCount',
              'unclassifiedCount',
              'invalidDirectionCount',
            ]),
            outflows: pick(week.outflows, [
              'expenseMinor',
              'confirmedExpenseMinor',
              'pendingExpenseMinor',
              'count',
            ]),
            repayment: repayment(week.repayment),
          })),
          excludingDebtPrincipal: pick(f.comparison.excludingDebtPrincipal, [
            'policy',
            'currentMinor',
            'averageMinor',
            'changeBps',
          ]),
        }
      : null,
    review: f.review
      ? {
          outflows: pick(f.review.outflows, [
            'expenseMinor',
            'count',
            'confirmedExpenseMinor',
            'confirmedExpenseCount',
            'pendingExpenseMinor',
            'pendingExpenseCount',
            'ownerConfirmedCount',
            'pendingIncludedInTotal',
          ]),
          pending: pick(f.review.pending, ['count', 'expenseMinor', 'truncated']),
          unusual: pick(f.review.unusual, ['count', 'truncated']),
          repayment: repayment(f.review.repayment),
          subscriptions: pick(f.review.subscriptions, MONEY),
        }
      : null,
    context: c
      ? {
          ...pick(c, ['snapshotPolicy', 'asOf']),
          balances: {
            ...pick(c.balances, [
              'complete',
              'ownedMinor',
              'knownOwnedMinor',
              'snapshot',
              'generatedAt',
            ]),
            accounts: rows(
              c.balances?.accounts,
              ['name', 'currency', 'ownedMinor', 'balanceMinor', 'asOf', 'at', 'updatedAt'],
              6,
            ),
          },
          reserves: pick(c.reserves, [
            'complete',
            'fleetMinor',
            'goalsMinor',
            'totalMinor',
            'availableAfterReservesMinor',
            'availableMinor',
          ]),
          bankFreshness: pick(c.bankFreshness, [
            'lastCompletedStatementRefreshAt',
            'lastSyncAt',
            'statementAgeHours',
            'refreshActive',
            'refreshPhase',
            'source',
            'stale',
          ]),
          upcoming: payments(c.upcoming),
          overdue: payments(c.overdue),
          detectedSubscriptions: {
            ...pick(c.detectedSubscriptions, ['count', 'truncated']),
            items: rows(c.detectedSubscriptions?.items, [
              'id',
              'name',
              'amountMinor',
              'currency',
              'nextDate',
            ]),
          },
        }
      : null,
  };
}
/** @param {any} system */
export function weeklySystemSummary(system) {
  if (!system) return null;
  const usage = (/** @type {any} */ value) =>
    value
      ? {
          ...pick(value, [
            'records',
            'knownCostRecords',
            'unpricedRecords',
            'estimatedUsd',
            'apiEquivalentUsd',
            'currency',
          ]),
          period: pick(value.period, PERIOD),
          coverage: pick(value.coverage, ['trackingSince', 'historical', 'legacyTruncated']),
        }
      : null;
  return {
    period: pick(system.period, PERIOD),
    sources: sources(system.sources),
    ...pick(system, ['truncated']),
    dropped: Array.isArray(system.dropped) ? system.dropped.slice(0, 8) : [],
    runs: {
      ...pick(system.runs, ['total', 'failed', 'unfinished', 'capped']),
      ...(typeof system.runs?.failed !== 'number' && Array.isArray(system.runs?.profiles)
        ? {
            failed: system.runs.profiles.reduce(
              (/** @type {number} */ n, /** @type {any} */ p) => n + p.errors,
              0,
            ),
            unfinished: system.runs.profiles.reduce(
              (/** @type {number} */ n, /** @type {any} */ p) => n + p.unfinished,
              0,
            ),
          }
        : {}),
      errors: rows(system.runs?.errors, ['profile', 'at', 'error'], 2),
    },
    toolCalls: {
      ...pick(system.toolCalls, [
        'total',
        'failed',
        'succeeded',
        'unknown',
        'failedInCompletedRuns',
      ]),
      errors: rows(system.toolCalls?.errors, ['name', 'at', 'profile', 'errorClass'], 2),
    },
    costs: system.costs
      ? {
          sources: sources(system.costs.sources),
          selected: usage(system.costs.selected),
          month: usage(system.costs.month),
          budgets: pick(system.costs.budgets, ['overallUsd', 'enforcement', 'basis']),
          billing: pick(system.costs.billing, ['balanceUsd', 'combinedWithEstimates']),
        }
      : null,
    secrets: {
      ...pick(system.secrets, ['metadataAvailable']),
      inventory: counters(system.secrets?.inventory),
      expiring: rows(system.secrets?.expiring, [
        'label',
        'expiresAt',
        'expiryDaysLeft',
        'expiryState',
      ]),
      rotationReminders: rows(system.secrets?.rotationReminders, ['label', 'rotationDaysLeft']),
    },
  };
}
/** A bounded decision snapshot; details remain in their canonical workspaces.
 * The explicit field/row/string limits give a size bound independent of input volume.
 * @param {any} doc */
export function weeklySummary(doc) {
  return {
    packetVersion: 3,
    reportFormat: WEEKLY_REPORT_FORMAT,
    scope: 'weekly',
    period: pick(doc.period, PERIOD),
    sources: sources(doc.sources),
    today: doc.today,
    week: pick(doc.week, ['from', 'to']),
    plan: planSummary(doc.plan),
    finance: weeklyFinanceSummary(doc.finance),
    system: weeklySystemSummary(doc.system),
    personalPeriods: doc.personalPeriods
      ? {
          current: personalPeriod(doc.personalPeriods.current),
          previousWeeks: (doc.personalPeriods.previousWeeks ?? []).slice(0, 4).map(personalPeriod),
        }
      : null,
    checkin: doc.checkin
      ? { fill: pick(doc.checkin.fill, ['recordedDays', 'questionnaire', 'allVersionCoverage']) }
      : null,
    habits: doc.habits ? { streaks: counters(doc.habits.streaks) } : null,
    funnel: doc.funnel ? { counts: counters(doc.funnel.counts) } : null,
    mastery: doc.mastery
      ? { roadmap: counters(doc.mastery.roadmap), mock: counters(doc.mastery.mock) }
      : null,
    interests: doc.interests ? { top: rows(doc.interests.top, ['topic', 'count']) } : null,
    reliability: pick(doc.reliability, ['onTime', 'total', 'deadman']),
    archive: { available: Boolean(doc.archive?.monthly || doc.archive?.weekly) },
    compaction: {
      summariesPreserved: true,
      detailsOmitted: ['supporting-detail'],
      note: 'Підсумки збережено; приклади й методика доступні у відповідних розділах застосунку.',
    },
    dropped: [],
  };
}
