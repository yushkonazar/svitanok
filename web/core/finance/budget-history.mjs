import { shiftDate, share, kyivParts } from './planning.mjs';
/** @param {string} period @param {string} date */
export function budgetPeriod(period, date) {
  if (period === 'day') return { start: date, end: date, days: 1 };
  if (period === 'week') {
    const start = shiftDate(date, -((new Date(date + 'T12:00Z').getUTCDay() + 6) % 7));
    return { start, end: shiftDate(start, 6), days: 7 };
  }
  const days = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
  ).getUTCDate();
  return {
    start: date.slice(0, 7) + '-01',
    end: date.slice(0, 7) + '-' + String(days).padStart(2, '0'),
    days,
  };
}
/** @param {any} b @param {any[]} budgets @param {string} date @param {Set<string>} [seen] @returns {number} */
export function budgetPlanLimit(b, budgets, date, seen = new Set()) {
  if (seen.has(b.id)) return 0;
  seen.add(b.id);
  if (b.limitMinor != null) return b.limitMinor;
  const parent = budgets.find((p) => p.id === b.parentId);
  const base = parent
    ? Math.round(
        (budgetPlanLimit(parent, budgets, date, seen) * budgetPeriod(b.period, date).days) /
          budgetPeriod(parent.period, date).days,
      )
    : (b.incomeBaseMinor ?? 0);
  return share(base, b.shareBps ?? 0);
}
/** Historic definitions only: no present-day plan is silently projected into the past.
 * @param {any} finance @param {string} budgetId @param {string} date */
export function budgetDefinitionAt(finance, budgetId, date) {
  const versions = (finance.budgetVersions ?? [])
    .filter(
      (/** @type {any} */ v) =>
        v.budgetId === budgetId && kyivParts(Date.parse(v.validFrom)).date <= date,
    )
    .sort(
      (/** @type {any} */ a, /** @type {any} */ b) =>
        b.validFrom.localeCompare(a.validFrom) || (b.sequence ?? 0) - (a.sequence ?? 0),
    );
  return versions[0] && !versions[0].removed ? versions[0].definition : null;
}
