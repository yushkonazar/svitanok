import { completedWeekPeriod } from '../report-period.mjs';
import { weeklySummary, WEEKLY_REPORT_FORMAT } from '../tools/weekly-summary.mjs';
import { renderWeeklyOverview, parseWeeklyDecision } from './weekly-report-format.mjs';

/** Conservative classification also protects unmodified historical rows.
 * @param {string} text @returns {'ready'|'partial'|'failed'} */
export function weeklyTextStatus(text) {
  const title = (text.trim().split('\n')[0] ?? '').replace(/[*_]/gu, '').replace(/^#{1,6}\s*/u, '');
  const hasTitle = /^\s*(?:📊\s*)?(?:Тиждень|Тижневий звіт)(?=\s|$)/iu.test(title);
  const has = (/** @type {string} */ heading) =>
    new RegExp(`^\\s*(?:#{1,4}\\s*|\\*\\*)?${heading}(?:\\*\\*)?\\s*$`, 'mu').test(text);
  // New reports are rendered by the core from a bounded decision document.
  // Historical free text still needs the old conservative shape check.
  if (hasTitle && /\n• (?:Справи|Стан|Гроші): /u.test(text))
    return /\nДані неповні[.:]/u.test(text) ? 'partial' : 'ready';
  if (!has('ГРОШІ') || !has('СИСТЕМА')) return 'failed';
  return hasTitle && has('ЩО ЗРОБИТИ') && !has('ЧОГО Я НЕ БАЧИВ') ? 'ready' : 'partial';
}

/** Persist bounded decision summaries and coverage, never raw answers or inventories.
 * @param {any} packet */
export function weeklyPacketQuality(packet) {
  const missing = [
    'stats',
    'state',
    'archive',
    'weeklyArchive',
    'levers',
    'plans',
    'finance',
    'system',
  ].filter((name) => !['available', 'empty'].includes(packet.sources?.[name]?.status));
  if (packet.dropped?.length || packet.truncated) missing.push('truncated-data');
  if (packet.compaction?.detailsOmitted?.includes('personalPeriods.olderContextFrequencies'))
    missing.push('personal-context-coverage');
  if ([2, 3].includes(packet.packetVersion)) {
    for (const [source, field] of /** @type {[string, string][]} */ ([
      ['finance', 'finance'],
      ['system', 'system'],
      ['plans', 'plan'],
    ])) {
      if (packet.sources?.[source]?.status === 'available' && !packet[field])
        missing.push(`${source}-summary`);
    }
    if (
      packet.sources?.stats?.status === 'available' &&
      [
        'personalPeriods',
        'checkin',
        'habits',
        'funnel',
        'mastery',
        'interests',
        'reliability',
      ].some((key) => !packet[key])
    )
      missing.push('personal-summary');
  }
  if (packet.finance?.quality?.unknownCurrencyCount) missing.push('finance-conversion');
  if (packet.finance?.quality?.unclassifiedCount || packet.finance?.quality?.invalidDirectionCount)
    missing.push('finance-classification');
  if (
    [packet.personalPeriods?.current, ...(packet.personalPeriods?.previousWeeks ?? [])].some(
      (period) => period?.unknownTimingSlots > 0,
    )
  )
    missing.push('personal-time-coverage');
  if (packet.finance && !packet.finance.comparison?.complete) missing.push('finance-comparison');
  const finance = packet.finance;
  if (
    finance?.context?.balances?.complete === false ||
    finance?.context?.reserves?.complete === false
  )
    missing.push('finance-balances');
  if (finance?.context?.upcoming?.complete === false) missing.push('finance-payment-amounts');
  if (
    finance?.context?.detectedSubscriptions?.truncated ||
    finance?.context?.upcoming?.truncated ||
    finance?.context?.overdue?.truncated
  )
    missing.push('finance-context-coverage');
  if (
    finance?.review?.pending?.truncated ||
    finance?.review?.unusual?.truncated ||
    [
      finance?.review?.repayment,
      ...(finance?.comparison?.weeks ?? []).map((/** @type {any} */ w) => w.repayment),
    ].some((r) => r?.exclusionsTruncated || r?.unverifiedTruncated)
  )
    missing.push('finance-evidence-coverage');
  if (packet.system?.runs?.capped || packet.system?.truncated || packet.system?.dropped?.length)
    missing.push('system-coverage');
  if (
    Object.values(packet.system?.sources ?? {}).some(
      (/** @type {any} */ s) => s.status === 'unavailable',
    )
  )
    missing.push('system-sources');
  if (
    Object.values(packet.system?.costs?.sources ?? {}).some(
      (/** @type {any} */ s) => s.status === 'unavailable',
    )
  )
    missing.push('system-cost-sources');
  const usage = packet.system?.costs?.month;
  if (
    usage &&
    (usage.unpricedRecords > 0 ||
      usage.coverage?.legacyTruncated ||
      (usage.records > 0 &&
        (!usage.coverage?.trackingSince || usage.coverage.trackingSince > usage.period.from)))
  )
    missing.push('system-cost-coverage');
  if (packet.system?.secrets?.metadataAvailable === false) missing.push('system-credentials');
  if (
    packet.plan &&
    (packet.plan.complete === false ||
      packet.plan.tasksTruncated ||
      packet.plan.explanationsTruncated ||
      packet.plan.overdueBeforePeriod?.truncated ||
      packet.plan.upcomingOutsidePeriod?.truncated)
  )
    missing.push('plan-coverage');
  const retryable = ['stats', 'plans', 'finance'].filter(
    (name) => packet.sources?.[name]?.status === 'unavailable',
  );
  return {
    period: packet.period,
    sources: packet.sources,
    missing,
    retryable: packet.truncated || packet.dropped?.length ? [] : retryable,
    ...(packet.reportFormat === WEEKLY_REPORT_FORMAT
      ? {
          reportFormat: WEEKLY_REPORT_FORMAT,
          details: weeklySummary(packet),
          overviewMissing: overviewMissing(packet, missing),
        }
      : {}),
  };
}

/** Optional inventories/price history stay visible in details. Core life facts
 * retain strict partial/failed status when their actual coverage is incomplete.
 * @param {any} packet @param {string[]} missing */
function overviewMissing(packet, missing) {
  return missing.filter(
    (code) =>
      [
        'stats',
        'plans',
        'finance',
        'truncated-data',
        'prepared-data-not-read',
        'personal-summary',
        'plans-summary',
        'finance-summary',
        'finance-conversion',
        'finance-classification',
        'personal-time-coverage',
      ].includes(code) ||
      (code === 'plan-coverage' && packet.plan?.complete === false),
  );
}

/** @param {Env} env @param {string} runId @param {number} fallbackMs */
export async function weeklyRunAnchor(env, runId, fallbackMs) {
  if (!env.DB) return null;
  let row;
  try {
    row = await env.DB.prepare('SELECT profile, started_at FROM runs WHERE id = ?')
      .bind(runId)
      .first();
  } catch {
    return null;
  }
  if (row?.profile !== 'weekly-review') return null;
  let context = null;
  try {
    context = (
      await env.DB.prepare('SELECT weekly_context_json FROM runs WHERE id = ?').bind(runId).first()
    )?.weekly_context_json;
  } catch {
    /* Expand migration unavailable: no report can be declared ready. */
  }
  const started = Date.parse(String(row.started_at));
  return { asOfMs: Number.isFinite(started) ? started : fallbackMs, context };
}

/** The runtime may report an explicit failure. Text never overrides that signal.
 * @param {Env} env @param {string} text @param {number} nowMs
 * @param {{runId?:string, failed?:boolean}} [options] */
export async function evaluateWeeklyReport(env, text, nowMs, options = {}) {
  const anchor = options.runId ? await weeklyRunAnchor(env, options.runId, nowMs) : null;
  const asOfMs = anchor?.asOfMs ?? nowMs;
  let context = null;
  try {
    context = anchor?.context ? JSON.parse(String(anchor.context)) : null;
  } catch {
    /* unverified */
  }
  const missing = Array.isArray(context?.missing) ? context.missing : ['prepared-data-not-read'];
  const period = context?.period?.dateFrom ? context.period : completedWeekPeriod(asOfMs);
  const overview =
    context?.reportFormat === WEEKLY_REPORT_FORMAT || parseWeeklyDecision(text) != null
      ? renderWeeklyOverview(
          text,
          { ...context, period, missing: context?.overviewMissing ?? missing },
          options.failed,
        )
      : null;
  const contentStatus = overview ? (overview.valid ? 'ready' : 'failed') : weeklyTextStatus(text);
  const status =
    options.failed || contentStatus === 'failed'
      ? 'failed'
      : (overview ? (context?.overviewMissing ?? missing).length : missing.length) ||
          contentStatus === 'partial'
        ? 'partial'
        : 'ready';
  return {
    status,
    periodFrom: period.dateFrom,
    periodTo: period.dateTo,
    period,
    missing,
    sources: context?.sources ?? {},
    retryable: context?.retryable ?? [],
    ...(overview
      ? {
          reportFormat: WEEKLY_REPORT_FORMAT,
          details: context?.details,
          overviewMissing: context?.overviewMissing ?? missing,
          overview,
        }
      : {}),
  };
}

/** Merge only evidence with the exact frozen report window and all-source scope.
 * Expense-only fallback queries do not prove balances, repayment or four baselines.
 * @param {any} context @param {string} tool @param {any} args @param {any} result */
export function mergeWeeklyEvidence(context, tool, args, result) {
  if (!context?.period || !context.reportFormat) return context;
  const period = tool === 'finance.query' ? result?.selection?.period : result?.period;
  if (period?.from !== context.period.from || period?.to !== context.period.to) return context;
  const next = structuredClone(context);
  if (tool === 'finance.query') {
    if (
      result.mode !== 'analytics' ||
      args.id ||
      args.category ||
      args.merchant ||
      args.flags?.length ||
      ['account', 'source', 'status'].some((key) => (args[key] ?? 'all') !== 'all')
    )
      return context;
    if (!result.summary || !result.sourceTotals || !Array.isArray(result.categories))
      return context;
    const existing = next.details?.finance ?? {};
    next.details ??= {};
    next.details.finance = {
      ...existing,
      period,
      summary: result.summary,
      sourceTotals: result.sourceTotals,
      categories: result.categories,
      quality: result.quality,
      coverage: result.coverage,
    };
    // The tool deliberately does not return the complete report context.
    next.missing = [
      ...new Set(
        next.missing.filter(
          (/** @type {string} */ code) =>
            ![
              'finance',
              'finance-summary',
              'finance-conversion',
              'finance-classification',
            ].includes(code),
        ),
      ),
    ];
    if (result.quality?.unknownCurrencyCount) next.missing.push('finance-conversion');
    if (result.quality?.unclassifiedCount || result.quality?.invalidDirectionCount)
      next.missing.push('finance-classification');
    if (!existing.context) next.missing.push('finance-context-coverage');
    if (!existing.comparison) next.missing.push('finance-comparison');
    if (!existing.review) next.missing.push('finance-evidence-coverage');
    next.sources.finance = { status: 'available', coverage: 'expenses-only' };
    next.retryable = (next.retryable ?? []).filter(
      (/** @type {string} */ code) => code !== 'finance',
    );
  } else if (tool === 'runs.query' && result.runs && !result.truncated && !result.dropped?.length) {
    next.details ??= {};
    next.details.system = result;
    const check = weeklyPacketQuality({
      ...next.details,
      sources: { ...next.sources, system: { status: 'available' } },
    });
    next.missing = [
      ...next.missing.filter(
        (/** @type {string} */ code) => code !== 'system' && !code.startsWith('system-'),
      ),
      ...check.missing.filter((code) => code.startsWith('system-')),
    ];
    next.sources.system = { status: 'available' };
  } else return context;
  next.details = weeklySummary({ ...next.details, sources: next.sources, period: next.period });
  next.missing = [...new Set(next.missing)];
  next.overviewMissing = overviewMissing(next.details, next.missing);
  return next;
}

/** Legacy error messages are kept but never returned as a usable review.
 * @param {Env} env @param {string} where @param {string[]} bindings */
export async function usableWeeklyReports(env, where, bindings) {
  if (!env.DB) return [];
  let results;
  try {
    ({ results } = await env.DB.prepare(
      `SELECT id, period_from, period_to, text_md, status FROM reports
     WHERE kind = 'weekly' AND (status IS NULL OR status IN ('ready','partial')) AND ${where}
     ORDER BY period_from DESC, created_at DESC LIMIT 100`,
    )
      .bind(...bindings)
      .all());
  } catch (error) {
    if (!String(error).includes('no such column: status')) throw error;
    // Compatibility while the additive migration is pending: legacy errors
    // are still filtered, and an unverified row cannot suppress a retry.
    ({ results } = await env.DB.prepare(
      `SELECT id, period_from, period_to, text_md, NULL AS status FROM reports
      WHERE kind = 'weekly' AND ${where} ORDER BY period_from DESC, created_at DESC LIMIT 100`,
    )
      .bind(...bindings)
      .all());
  }
  return (results ?? []).filter((row) => weeklyTextStatus(String(row.text_md ?? '')) !== 'failed');
}
