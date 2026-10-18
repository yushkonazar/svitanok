/** Compact only detail within every report section. Numeric aggregates, source
 * states, periods and the four finance baselines remain authoritative.
 * The caller owns doc; input snapshots must be cloned before this function.
 * @param {any} doc @param {number} level */
export function compactWeeklyDetails(doc, level) {
  const omitted = new Set(doc.compaction?.detailsOmitted ?? []);
  const mark = (/** @type {string} */ path) => omitted.add(path);
  const omit = (
    /** @type {any} */ parent,
    /** @type {string} */ key,
    /** @type {string} */ path,
  ) => {
    if (parent?.[key] == null) return;
    parent[key] = null;
    mark(path);
  };
  const limit = level === 1 ? 8 : level === 2 ? 3 : 1;
  const chars = level === 1 ? 240 : level === 2 ? 120 : 80;
  /** Bound supporting detail without converting missing facts into zero.
   * @param {any} value @param {string} path @returns {any} */
  const bound = (value, path) => {
    if (typeof value === 'string' && value.length > chars) {
      mark(path);
      return `${value.slice(0, chars - 1)}…`;
    }
    if (Array.isArray(value)) {
      // Keep recent context, not the oldest rows of chronological series.
      // Interests use parallel week/value arrays: slice both identically.
      if (
        path === 'interests.trend.weeks' ||
        /^interests\.trend\.topics\.\d+\.series$/.test(path) ||
        (value.length && value.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row?.week)))
      ) {
        const keep = level >= 3 ? 3 : Math.max(5, limit);
        if (value.length > keep) mark(path);
        return value.slice(-keep).map((v, i) => bound(v, `${path}.${i}`));
      }
      // Short scalar arrays can be tuples (date/value, coefficient/bounds).
      // Never shorten their shape while sampling arrays of records.
      if (value.length <= 4 && value.every((v) => v == null || typeof v !== 'object'))
        return value.map((v, i) => bound(v, `${path}.${i}`));
      if (value.length > limit) mark(path);
      return value.slice(0, limit).map((v, i) => bound(v, `${path}.${i}`));
    }
    if (value && typeof value === 'object') {
      let entries = Object.entries(value);
      if (path.startsWith('archive.')) {
        const dated = entries.filter(([key]) => /^\d{4}-\d{2}(?:-\d{2})?$/.test(key));
        const keep = path.startsWith('archive.monthly') ? 3 : 8;
        if (dated.length > keep) {
          const retained = dated
            .map(([key]) => key)
            .sort()
            .slice(-keep);
          entries = entries.filter(
            ([key]) => !dated.some(([date]) => date === key) || retained.includes(key),
          );
          doc.archive.coverage ??= {};
          doc.archive.coverage[path] ??= {
            total: dated.length,
            retained: keep,
            from: retained[0],
            to: retained.at(-1),
          };
          mark(path);
        }
      }
      return Object.fromEntries(entries.map(([k, v]) => [k, bound(v, `${path}.${k}`)]));
    }
    return value;
  };

  omit(doc.checkin, 'raw', 'checkin.raw');
  omit(doc.checkin, 'series', 'checkin.series');
  // Rolling legacy weeks duplicate the authoritative, versioned as-of slices
  // in personalPeriods and must not displace those comparable summaries.
  omit(doc.checkin, 'weekly', 'checkin.weekly');
  omit(doc.checkin, 'sleepLog', 'checkin.sleepLog');
  omit(doc.habits, 'heatmap', 'habits.heatmap');
  omit(doc.habits, 'openRhythm', 'habits.openRhythm');
  omit(doc.habits, 'readPerDay', 'habits.readPerDay');
  // Reliability is a daily operational series; retain its exact counters before
  // reducing examples, rather than dropping the whole reliability section.
  if (Array.isArray(doc.reliability?.days)) {
    doc.reliability.daysCount ??= doc.reliability.days.length;
  }
  for (const key of [
    'checkin',
    'index',
    'habits',
    'funnel',
    'mastery',
    'interests',
    'reliability',
    'levers',
  ]) {
    if (doc[key] != null) doc[key] = bound(doc[key], key);
  }
  for (const key of ['monthly', 'weekly']) {
    const source = doc.archive?.[key];
    if (!source || typeof source !== 'object') continue;
    const keys = Object.keys(source).sort();
    const keep = key === 'monthly' ? Math.max(3, limit) : Math.max(4, limit);
    if (keys.length > keep) {
      doc.archive[`${key}Total`] ??= keys.length;
      mark(`archive.${key}`);
    }
    doc.archive[key] = Object.fromEntries(
      keys.slice(-keep).map((k) => {
        const row = { ...source[k] };
        for (const version of ['observationsV2', 'observationsV3']) {
          if (!row[version]?.metrics) continue;
          const metrics = Object.entries(row[version].metrics);
          const core = metrics.filter(([name]) =>
            /^(?:morning\.(?:sleepMinutesV3|sleepQualityV3|energy|mood)|afternoon\.energy|evening\.(?:energy|mood|dayScore)|sleepHours|sleepQuality|satisfaction)$/.test(
              name,
            ),
          );
          if (core.length < metrics.length) mark(`archive.${key}.metricDetails`);
          row[version] = {
            ...row[version],
            metrics: Object.fromEntries(
              core.map(([name, value]) => {
                const metric = { .../** @type {any} */ (value) };
                if (metric.numericN > 0 && metric.numericN === metric.n) {
                  delete metric.counts;
                  delete metric.numericN;
                }
                return [name, metric];
              }),
            ),
          };
        }
        return [k, bound(row, `archive.${key}.${k}`)];
      }),
    );
  }

  // Registry locations are not active keys. Counts, expiry/review states and
  // rotation reminders remain; the long inventory is available in its own UI.
  omit(doc.system?.secrets, 'entries', 'system.secrets.entries');
  // Month-wide feature/provider detail is retained; selected-period totals,
  // coverage and its exact boundaries remain alongside it.
  omit(doc.system?.costs?.selected, 'features', 'system.costs.selected.features');
  omit(doc.system?.costs?.selected, 'providers', 'system.costs.selected.providers');
  omit(doc.system?.costs?.selected, 'note', 'system.costs.selected.note');
  // Every used quota already carries its own limit; unused code defaults are
  // neither a billing total nor a reason to evict a business summary.
  omit(doc.system?.quotas, 'limits', 'system.quotas.limits');
  const review = doc.system?.secrets?.needsReview;
  if (Array.isArray(review) && review.length > limit) {
    doc.system.secrets.needsReviewCount ??= review.length;
    doc.system.secrets.needsReview = review.slice(0, limit);
    mark('system.secrets.needsReview');
  }
  for (const key of ['errors']) {
    for (const parent of ['runs', 'toolCalls']) {
      const list = doc.system?.[parent]?.[key];
      if (Array.isArray(list) && list.length > limit) {
        doc.system[parent][`${key}Count`] ??= list.length;
        doc.system[parent][key] = list.slice(0, limit);
        mark(`system.${parent}.${key}`);
      }
    }
  }

  // Numeric histograms repeat the same averages and samples many times. Retain
  // n, sum/mean and exact extrema; categorical frequencies remain intact.
  const periods = doc.personalPeriods;
  if (periods) {
    const labels = new Set();
    for (const [index, period] of [periods.current, ...(periods.previousWeeks ?? [])].entries()) {
      for (const version of ['observationsV2', 'observationsV3']) {
        for (const [key, metric] of Object.entries(period?.[version] ?? {})) {
          const row = /** @type {any} */ (metric);
          if (typeof row.label === 'string') {
            const id = `${version}.${key}`;
            if (labels.has(id)) delete row.label;
            else labels.add(id);
          }
          if (row.numericN > 0 && row.numericN === row.n && row.counts) {
            const values = Object.keys(row.counts).map(Number).filter(Number.isFinite);
            if (values.length) {
              row.min = Math.min(...values);
              row.max = Math.max(...values);
              delete row.counts;
              mark('personalPeriods.numericHistograms');
            }
          }
          if (row.numericN > 0 && row.numericN === row.n) delete row.numericN;
          if (level >= 4 && index > 1 && row.average == null && row.counts) {
            delete row.counts;
            row.countsOmitted = true;
            mark('personalPeriods.olderContextFrequencies');
          }
        }
      }
    }
    periods.labelRule =
      'Відсутній label успадковується з того самого поля й версії у поточному або ближчому базовому періоді.';
    periods.numericRule =
      'У числових метриках без numericN знаменник дорівнює n. sum та average збережено.';
  }

  /** @param {any} parent @param {string} key @param {string} path @param {string} flag @param {number} [max] */
  const rows = (parent, key, path, flag, max = limit) => {
    const list = parent?.[key];
    if (!Array.isArray(list)) return;
    if (list.length > max) {
      parent[flag] = true;
      mark(path);
    }
    parent[key] = list.slice(0, max).map((row) => {
      const copy = { ...row };
      for (const field of [
        'description',
        'title',
        'name',
        'outcomeNote',
        'exceptionReason',
        'criterion',
        'reason',
      ]) {
        if (typeof copy[field] === 'string') {
          if (copy[field].length > chars) parent[flag] = true;
          copy[field] = bound(copy[field], `${path}.${field}`);
        }
      }
      return copy;
    });
  };
  const finance = doc.finance;
  if (finance) {
    if (Array.isArray(finance.categoryBreakdown?.top))
      finance.categoryBreakdown.top = finance.categoryBreakdown.top.map(
        (/** @type {any} */ row) => ({
          category: row.category,
          amountMinor: row.amountMinor,
          count: row.count,
        }),
      );
    if (Array.isArray(finance.largestCategoryChanges))
      finance.largestCategoryChanges = finance.largestCategoryChanges.map(
        (/** @type {any} */ row) => ({
          category: row.category,
          amountMinor: row.amountMinor,
          averageMinor: row.averageMinor,
          changeFourPeriodMinor: row.changeFourPeriodMinor,
        }),
      );
    rows(
      finance.review?.pending,
      'operations',
      'finance.review.pending.operations',
      'truncated',
      Math.max(limit, 8),
    );
    rows(finance.review?.unusual, 'operations', 'finance.review.unusual.operations', 'truncated');
    for (const repayment of [
      finance.review?.repayment,
      ...(finance.comparison?.weeks ?? []).map((/** @type {any} */ w) => w.repayment),
    ]) {
      rows(repayment, 'exclusions', 'finance.repayment.exclusions', 'exclusionsTruncated');
      rows(repayment, 'unverified', 'finance.repayment.unverified', 'unverifiedTruncated');
      // Bank-state fields belong to pending/unusual evidence. Repayment proof
      // keeps identity, money, contract, reason and original-accounting status.
      for (const key of ['exclusions', 'unverified']) {
        for (const row of repayment?.[key] ?? []) {
          for (const field of [
            'originalAmountMinor',
            'kind',
            'bankHold',
            'ownerVerified',
            'checkedAt',
            'checkSource',
            'missingFromStatement',
          ])
            delete row[field];
        }
      }
    }
    for (const key of ['upcoming', 'overdue'])
      rows(finance.context?.[key], 'payments', `finance.context.${key}.payments`, 'truncated');
    rows(
      finance.context?.detectedSubscriptions,
      'items',
      'finance.context.detectedSubscriptions.items',
      'truncated',
    );
  }
  const plan = doc.plan;
  if (plan) {
    rows(plan, 'tasks', 'plan.tasks', 'tasksTruncated', Math.max(limit, 10));
    rows(plan, 'explanations', 'plan.explanations', 'explanationsTruncated', Math.max(limit, 10));
    for (const key of ['overdueBeforePeriod', 'upcomingOutsidePeriod'])
      rows(plan[key], 'tasks', `plan.${key}.tasks`, 'truncated');
  }
  doc.compaction = {
    summariesPreserved: true,
    detailsOmitted: [...omitted].filter(
      (path) => ![...omitted].some((parent) => parent !== path && path.startsWith(`${parent}.`)),
    ),
    note: 'Скорочено лише деталізацію. Наявні підсумки блоків не є недоступними джерелами.',
  };
}
