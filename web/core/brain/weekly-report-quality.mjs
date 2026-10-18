import { weekBounds } from '../tools/weekly.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
import { reportPeriod } from '../report-period.mjs';

/** Conservative classification also protects unmodified historical rows.
 * @param {string} text @returns {'ready'|'partial'|'failed'} */
export function weeklyTextStatus(text) {
  const title = (text.trim().split('\n')[0] ?? '').replace(/[*_]/gu, '').replace(/^#{1,6}\s*/u, '');
  const hasTitle = /^\s*(?:📊\s*)?(?:Тиждень|Тижневий звіт)(?=\s|$)/iu.test(title);
  const has = (/** @type {string} */ heading) =>
    new RegExp(`^\\s*(?:#{1,4}\\s*|\\*\\*)?${heading}(?:\\*\\*)?\\s*$`, 'mu').test(text);
  if (!has('ГРОШІ') || !has('СИСТЕМА')) return 'failed';
  return hasTitle && has('ЩО ЗРОБИТИ') && !has('ЧОГО Я НЕ БАЧИВ') ? 'ready' : 'partial';
}

/** Only metadata is persisted; the prepared personal/financial payload is not.
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
  return { period: packet.period, sources: packet.sources, missing };
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
  const today = kyivDateKey(new Date(asOfMs));
  const week = weekBounds(today);
  let context = null;
  try {
    context = anchor?.context ? JSON.parse(String(anchor.context)) : null;
  } catch {
    /* unverified */
  }
  const missing = Array.isArray(context?.missing) ? context.missing : ['prepared-data-not-read'];
  const contentStatus = weeklyTextStatus(text);
  const status =
    options.failed || contentStatus === 'failed'
      ? 'failed'
      : missing.length || contentStatus === 'partial'
        ? 'partial'
        : 'ready';
  return {
    status,
    periodFrom: week.from,
    periodTo: week.to,
    period: reportPeriod(week.from, today, asOfMs),
    missing,
    sources: context?.sources ?? {},
  };
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
