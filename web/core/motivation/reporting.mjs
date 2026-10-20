import { readPlanReportSource } from './store.mjs';
import { taskFacts, observedResultUnits } from './model.mjs';
import { planTaskState } from './status.mjs';

/** Current commitments and immutable event dates are separate from the report window.
 * No legacy day_plan migration, settlement, XP mutation or calendar request occurs.
 * @param {Env} env @param {ReturnType<typeof import('../report-period.mjs').reportPeriod>} period */
export async function readPlanReport(env, period) {
  const source = await readPlanReportSource(env, period);
  const asOfMs = Date.parse(period.asOf);
  const within = (/** @type {unknown} */ at) =>
    typeof at === 'string' &&
    Date.parse(at) >= Date.parse(period.from) &&
    Date.parse(at) < Date.parse(period.to);
  const known = (/** @type {unknown} */ at) =>
    typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) <= asOfMs;
  const state = { ...source.state, records: { ...source.state.records } };
  let unknownReportTimingCount = 0;
  for (const row of Object.values(state.records)) {
    if (row.kind !== 'result') continue;
    if (!Array.isArray(row.reports)) throw new Error('Unreadable plan results');
    unknownReportTimingCount += row.reports.filter(
      (/** @type {any} */ r) =>
        !Number.isFinite(Date.parse(r.recordedAt)) || !Number.isFinite(Date.parse(r.actualAt)),
    ).length;
    const reports = row.reports.filter(
      (/** @type {any} */ r) => known(r.recordedAt) && known(r.actualAt),
    );
    state.records[row.id] = {
      ...row,
      reports,
      units: Math.max(
        0,
        ...reports
          .filter((/** @type {any} */ r) => !r.retracted)
          .map((/** @type {any} */ r) => r.units),
      ),
    };
  }
  const events = source.events.filter((/** @type {any} */ e) => within(e.at));
  const touched = new Set(events.map((/** @type {any} */ e) => e.taskId ?? e.recordId));
  const tasks = Object.values(state.records)
    .filter((t) => t.kind === 'task' && known(t.createdAt))
    .map((t) => {
      const result = state.records[t.resultId];
      const facts = taskFacts(state, t);
      const reports = result.reports.filter(
        (/** @type {any} */ r) => !r.retracted && within(r.actualAt),
      );
      return {
        id: t.id,
        resultId: t.resultId,
        title: t.title,
        date: t.date,
        source: t.source ? 'finance' : 'manual',
        status: t.status,
        lifecycle: planTaskState({ ...t, facts }, asOfMs),
        dueAt: t.dueAt,
        acceptedAt: t.acceptedAt ?? null,
        criterion: t.criterion,
        unit: t.unit,
        units: facts.units,
        eligibleUnits: facts.eligibleUnits,
        target: facts.target,
        onTimeUnits: facts.onTimeUnits,
        estimateMinutes: t.estimateMinutes ?? null,
        outcomeNote: t.outcomeNote ?? '',
        exceptionReason: t.exceptionReason ?? '',
        fromTaskId: t.fromTaskId ?? null,
        deadlineChanges: (t.deadlineChanges ?? []).filter((/** @type {any} */ d) => known(d.at)),
        reportCount: reports.length,
        reportsTruncated: reports.length > 3,
        reports: reports.slice(0, 3).map((/** @type {any} */ r) => ({
          actualAt: r.actualAt,
          recordedAt: r.recordedAt,
          units: r.units,
          observedUnits: r.observedUnits ?? r.units,
        })),
      };
    });
  const selected = tasks.filter(
    (t) =>
      (t.date >= period.dateFrom && t.date <= period.dateTo) ||
      within(t.dueAt) ||
      within(t.acceptedAt) ||
      t.reports.length ||
      touched.has(t.id),
  );
  const accepted = selected.filter((t) => known(t.acceptedAt));
  const selectedIds = new Set(selected.map((t) => t.id));
  const upcoming = tasks
    .filter(
      (t) =>
        !selectedIds.has(t.id) &&
        Date.parse(t.dueAt) >= Date.parse(period.to) &&
        t.units < t.target,
    )
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const resultIds = new Set(accepted.map((t) => t.resultId));
  const lifecycle = Object.fromEntries(
    [
      'draft',
      'scheduled',
      'ready',
      'in-progress',
      'completed',
      'completed-late',
      'missed',
      'excepted',
    ].map((name) => [name, selected.filter((t) => t.lifecycle === name).length]),
  );
  const backlog = tasks.filter(
    (t) =>
      known(t.acceptedAt) &&
      Date.parse(t.dueAt) < Date.parse(period.from) &&
      t.onTimeUnits < t.target &&
      t.units < t.target &&
      t.status !== 'excepted',
  );
  const reasons = events
    .filter((/** @type {any} */ e) => typeof e.reason === 'string' && e.reason.trim())
    .map((/** @type {any} */ e) => ({
      at: e.at,
      kind: e.kind,
      taskId: e.taskId ?? e.recordId,
      reason: e.reason.slice(0, 500),
    }));
  const count = (/** @type {string} */ kind) =>
    Number(source.counts.find((row) => row.kind === kind)?.total ?? 0);
  return {
    source: 'motivation',
    period,
    snapshot: 'current-records-with-period-events',
    enabled: state.settings.enabled,
    dayBoundary: state.settings.dayBoundary,
    complete:
      !source.eventsTruncated &&
      !unknownReportTimingCount &&
      !(source.latestAt && Date.parse(String(source.latestAt)) > asOfMs),
    snapshotAfterCutoff: Boolean(source.latestAt && Date.parse(String(source.latestAt)) > asOfMs),
    unknownReportTimingCount,
    summary: {
      commitments: selected.length,
      acceptedCommitments: accepted.length,
      distinctResults: resultIds.size,
      completedDistinctResults: [...resultIds].filter(
        (id) => observedResultUnits(state.records[id]) >= state.records[id].target,
      ).length,
      lifecycle,
      manual: selected.filter((t) => t.source === 'manual').length,
      finance: selected.filter((t) => t.source === 'finance').length,
      rescheduled: count('task-rescheduled'),
      recommitted: count('recommit-draft'),
      deleted: count('draft-deleted'),
      estimatedMinutes: selected.reduce((sum, t) => sum + (t.estimateMinutes ?? 0), 0),
      actualMinutes: null,
      actualMinutesNote:
        'Поточний план не зберігає виміряну тривалість; оцінка не є фактичним часом.',
    },
    tasks: selected.slice(0, 40),
    tasksTruncated: selected.length > 40,
    upcomingOutsidePeriod: {
      count: upcoming.length,
      tasks: upcoming.slice(0, 10),
      truncated: upcoming.length > 10,
    },
    overdueBeforePeriod: {
      count: backlog.length,
      tasks: backlog.slice(0, 10),
      truncated: backlog.length > 10,
    },
    explanations: reasons.slice(0, 20),
    explanationsTruncated: reasons.length > 20 || source.eventsTruncated,
    note: 'Кількість обіцянок і унікальних результатів різні. Продовження може використовувати спільний результат. Пояснення не є автоматичним винятком чи зміною строку.',
  };
}
