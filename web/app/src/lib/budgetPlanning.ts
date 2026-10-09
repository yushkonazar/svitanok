import type { Finance } from '../api/finance-schema.ts';
import {
  kyivParts,
  kyivInstant,
  shiftDate,
  share,
  sumMoney,
} from '../../../core/finance/planning.mjs';
export type Budget = Finance['budgets'][number];
export function periodWindow(period: Budget['period'], date: string) {
  if (period === 'day') return { start: date, end: date, days: 1 };
  if (period === 'week') {
    const offset = (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const start = shiftDate(date, -offset);
    return { start, end: shiftDate(start, 6), days: 7 };
  }
  const days = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
  ).getUTCDate();
  return { start: date.slice(0, 7) + '-01', end: date.slice(0, 7) + '-' + days, days };
}
export function budgetLimit(
  b: Budget,
  budgets: Budget[],
  date: string,
  seen = new Set<string>(),
): number {
  if (seen.has(b.id)) return 0;
  seen.add(b.id);
  if (b.limitMinor != null) return b.limitMinor;
  const parent = budgets.find((p) => p.id === b.parentId);
  const base = parent
    ? Math.round(
        (budgetLimit(parent, budgets, date, seen) * periodWindow(b.period, date).days) /
          periodWindow(parent.period, date).days,
      )
    : (b.incomeBaseMinor ?? 0);
  return share(base, b.shareBps ?? 0);
}
export function budgetRows(f: Finance, nowMs: number) {
  const date = kyivParts(nowMs).date;
  return f.budgets.map((b) => {
    const w = periodWindow(b.period, date);
    const from = kyivInstant(w.start, 0);
    const categories = b.categories.length ? b.categories : [b.category];
    const children = f.budgets.filter((c) => c.parentId === b.id);
    // A parent includes the categories and goal targets of its descendants once.
    const goalIds = new Set<string>();
    const visit = (node: Budget, seen = new Set<string>()) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      if (node.goalId) goalIds.add(node.goalId);
      f.budgets.filter((c) => c.parentId === node.id).forEach((c) => visit(c, seen));
    };
    visit(b);
    const spent =
      b.purpose === 'saving'
        ? sumMoney(
            f.goalMoves
              .filter(
                (m) =>
                  (!goalIds.size || goalIds.has(m.goalId)) &&
                  Date.parse(m.at) >= from &&
                  Date.parse(m.at) <= nowMs,
              )
              .map((m) => m.amountMinor),
          )
        : -sumMoney(
            f.transactions
              .filter(
                (t) =>
                  t.kind === 'expense' &&
                  categories.includes(t.category) &&
                  t.amountUah != null &&
                  Date.parse(t.at) >= from &&
                  Date.parse(t.at) <= nowMs,
              )
              .map((t) => t.amountUah!),
          );
    const limit = budgetLimit(b, f.budgets, date);
    const depth = (node: Budget, seen = new Set<string>()): number => {
      const p = f.budgets.find((x) => x.id === node.parentId);
      if (!p || seen.has(p.id)) return 0;
      seen.add(p.id);
      return 1 + depth(p, seen);
    };
    return {
      ...b,
      spent,
      limit,
      left: limit - spent,
      progress: limit ? Math.max(0, Math.min(100, (spent / limit) * 100)) : spent > 0 ? 100 : 0,
      depth: depth(b),
      children: children.length,
      childAllocation: Math.round(
        children.reduce(
          (sum, c) =>
            sum +
            (budgetLimit(c, f.budgets, date) * periodWindow(b.period, date).days) /
              periodWindow(c.period, date).days,
          0,
        ),
      ),
    };
  });
}
export function orderedBudgets<T extends Budget>(budgets: T[]): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null) =>
    budgets
      .filter((b) => (b.parentId ?? null) === parentId)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .forEach((b) => {
        if (seen.has(b.id)) return;
        seen.add(b.id);
        result.push(b);
        visit(b.id);
      });
  visit(null);
  budgets.forEach((b) => {
    if (!seen.has(b.id)) result.push(b);
  });
  return result;
}
