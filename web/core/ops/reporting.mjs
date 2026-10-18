import { readUsageLedger } from './usage-ledger.mjs';
import { readSystemPreferences } from './system-preferences.mjs';
import { readSystemBilling } from './system-billing.mjs';
import { readCredentials } from './credentials.mjs';
import { reportPeriod } from '../report-period.mjs';
import { kyivParts } from '../finance/planning.mjs';

/** No error messages, request arguments, notes or secret values leave this projection.
 * @param {unknown} error */
export function reportErrorClass(error) {
  const s = String(error ?? '').toLowerCase();
  if (/invalid.arguments|contract|http.?400|bad.request/.test(s)) return 'invalid-arguments';
  if (/timeout|timed.out|abort/.test(s)) return 'timeout';
  if (/429|rate.limit|too.many/.test(s)) return 'rate-limit';
  if (/401|403|unauthori|forbidden|auth/.test(s)) return 'access';
  if (/budget|credit|quota/.test(s)) return 'budget-or-quota';
  return 'failure';
}

/** @param {Env} env @param {{from:string,to:string}} period */
export async function readReportToolCalls(env, period) {
  if (!env.DB) throw new Error('storage');
  const [totals, details] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,SUM(CASE WHEN s.ok=0 THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN s.ok=1 THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN s.ok IS NULL THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN s.ok=0 AND r.finished_at IS NOT NULL AND r.finished_at<? AND COALESCE(r.error,'')='' THEN 1 ELSE 0 END) AS failedInCompletedRuns
      FROM run_steps s LEFT JOIN runs r ON r.id=s.run_id WHERE s.kind='tool' AND s.at>=? AND s.at<?`,
    )
      .bind(period.to, period.from, period.to)
      .first(),
    env.DB.prepare(
      `SELECT s.name,s.at,s.note,r.profile FROM run_steps s LEFT JOIN runs r ON r.id=s.run_id
      WHERE s.kind='tool' AND s.ok=0 AND s.at>=? AND s.at<? ORDER BY s.at DESC,s.id DESC LIMIT 21`,
    )
      .bind(period.from, period.to)
      .all(),
  ]);
  return {
    total: Number(totals?.total ?? 0),
    failed: Number(totals?.failed ?? 0),
    succeeded: Number(totals?.succeeded ?? 0),
    unknown: Number(totals?.unknown ?? 0),
    failedInCompletedRuns: Number(totals?.failedInCompletedRuns ?? 0),
    errors: (details.results ?? []).slice(0, 20).map((r) => ({
      name: /^[a-zA-Z][a-zA-Z0-9_.:-]{0,120}$/.test(String(r.name))
        ? String(r.name)
        : 'unknown-tool',
      at: String(r.at),
      profile: /^[a-zA-Z0-9_-]{1,80}$/.test(String(r.profile)) ? String(r.profile) : null,
      errorClass: reportErrorClass(r.note),
    })),
    detailsTruncated: (details.results?.length ?? 0) > 20,
    note: 'Успішне завершення прогону не скасовує невдалих інструментальних викликів. Вплив на результат потребує окремої перевірки.',
  };
}

/** @param {any} usage @param {ReturnType<typeof reportPeriod>} period */
function usageProjection(usage, period) {
  const amounts = (/** @type {any} */ row) => ({
    records: row.records,
    knownCostRecords: row.knownCosts,
    unpricedRecords: row.records - row.knownCosts,
    estimatedUsd: row.estimatedUsd,
    apiEquivalentUsd: row.equivalentUsd,
  });
  return {
    period,
    currency: 'USD',
    ...amounts(usage),
    providers: usage.providers.map((/** @type {any} */ row) => ({
      provider: row.provider,
      ...amounts(row),
    })),
    features: usage.features.map((/** @type {any} */ row) => ({
      feature: row.feature,
      ...amounts(row),
    })),
    coverage: {
      trackingSince: usage.trackingSince,
      historical: usage.historicalCoverage,
      legacyTruncated: usage.legacyTruncated,
      retentionDays: usage.retentionDays,
    },
    note: 'Оцінка журналу й API-еквівалент окремі; це не рахунок і не доступний баланс. Невідомі ціни не є нульовими витратами.',
  };
}

/** Current-month envelope, observed estimates and provider snapshots are never added.
 * This reads existing storage only: no refresh, provider calls or settings writes.
 * @param {Env} env @param {ReturnType<typeof reportPeriod>} selected @param {number} nowMs */
export async function readReportCosts(env, selected, nowMs) {
  const today = kyivParts(nowMs).date;
  const month = reportPeriod(`${today.slice(0, 7)}-01`, today, nowMs);
  const read = (/** @type {ReturnType<typeof reportPeriod>} */ p) =>
    readUsageLedger(env, { since: p.from, until: p.to });
  const monthRead = read(month);
  const selectedRead =
    selected.from === month.from && selected.to === month.to ? monthRead : read(selected);
  const parts = await Promise.allSettled([
    selectedRead,
    monthRead,
    readSystemPreferences(env),
    readSystemBilling(env, { from: month.dateFrom, to: month.dateTo }, nowMs),
  ]);
  /** @type {Record<string,any>} */ const data = {};
  /** @type {Record<string,any>} */ const sources = {};
  for (const [i, name] of ['selectedUsage', 'monthUsage', 'budgets', 'billing'].entries()) {
    const part = parts[i];
    data[name] = part?.status === 'fulfilled' ? part.value : null;
    sources[name] = { status: part?.status === 'fulfilled' ? 'available' : 'unavailable' };
  }
  const prefs = data.budgets;
  if (data.billing?.items.some((/** @type {any} */ item) => !item.cacheAvailable))
    sources.billing = { status: 'unavailable' };
  const validMoney = (/** @type {unknown} */ n) =>
    n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
  if (
    prefs &&
    (!validMoney(prefs.budgets?.overallUsd) ||
      !prefs.budgets?.features ||
      typeof prefs.budgets.features !== 'object' ||
      Array.isArray(prefs.budgets.features) ||
      Object.values(prefs.budgets.features).some((n) => !validMoney(n)))
  ) {
    sources.budgets = { status: 'unavailable' };
    data.budgets = null;
  }
  return {
    sources,
    selected: data.selectedUsage ? usageProjection(data.selectedUsage, selected) : null,
    month: data.monthUsage ? usageProjection(data.monthUsage, month) : null,
    budgets: data.budgets
      ? {
          period: month,
          overallUsd: data.budgets.budgets.overallUsd,
          features: data.budgets.budgets.features,
          enforcement: false,
          basis: 'owner-display-envelope',
        }
      : null,
    billing: data.billing
      ? {
          requestedPeriod: month,
          balanceUsd: null,
          combinedWithEstimates: false,
          providers: data.billing.items.map((/** @type {any} */ item) => ({
            provider: item.provider,
            configured: item.configured,
            supported: item.supported,
            snapshot: item.snapshot,
            errorClass: item.errorClass,
            cacheAvailable: item.cacheAvailable,
          })),
        }
      : null,
  };
}

/** Inventory locations are not a count of valid keys. Rotation is a chosen reminder.
 * @param {Env} env @param {number} nowMs */
export async function readReportCredentials(env, nowMs) {
  const registry = await readCredentials(env, nowMs);
  const current = registry.entries.filter((e) => !e.legacy);
  const relevant = current.filter((e) => e.configured !== false);
  const shape = (/** @type {typeof current[number]} */ e) => ({
    label: e.label,
    location: e.location,
    configuration:
      e.configured === true ? 'configured' : e.configured === false ? 'not-configured' : 'unknown',
    expiryKind: e.expiryKind,
    expiresAt: e.expiresAt,
    expiryDaysLeft: e.expiryDaysLeft,
    expiryState:
      e.expiryKind === 'non-expiring'
        ? 'non-expiring'
        : e.expiryDaysLeft == null
          ? 'unknown'
          : e.expiryDaysLeft < 0
            ? 'expired'
            : e.expiryDaysLeft <= 60
              ? 'expiring'
              : 'dated',
    rotationDaysLeft: e.rotationDaysLeft,
  });
  return {
    metadataAvailable: registry.available,
    inventory: {
      locations: registry.entries.length,
      currentLocations: current.length,
      legacyLocations: registry.entries.length - current.length,
      configuredLocations: current.filter((e) => e.configured === true).length,
      notConfiguredLocations: current.filter((e) => e.configured === false).length,
      presenceUnknownLocations: current.filter((e) => e.configured == null).length,
    },
    entries: current.map(shape),
    expiring: relevant.filter((e) => e.expiryDaysLeft != null && e.expiryDaysLeft <= 60).map(shape),
    rotationReminders: relevant
      .filter((e) => e.rotationDaysLeft != null && e.rotationDaysLeft <= 60)
      .map(shape),
    needsReview: relevant
      .filter((e) => e.configured == null || e.expiryKind === 'unknown')
      .map(shape),
    note: 'Реєстр містить місця зберігання, а не підтверджені активні ключі. Наявність у конфігурації не перевіряє чинність. Ротація не є строком дії.',
  };
}
