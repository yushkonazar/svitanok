import type { Finance } from '../api/finance-schema.ts';
import { kyivParts, kyivInstant, sumMoney } from '../../../core/finance/planning.mjs';
export type Budget = Finance['budgets'][number];
export {
  budgetPeriod as periodWindow,
  budgetPlanLimit as budgetLimit,
} from '../../../core/finance/budget-history.mjs';
import {
  budgetPeriod as periodWindow,
  budgetPlanLimit as budgetLimit,
} from '../../../core/finance/budget-history.mjs';
export function budgetRows(f: Finance, nowMs: number) {
  const date = kyivParts(nowMs).date;
  return f.budgets.map((b) => {
    const w = periodWindow(b.period, date);
    const from = kyivInstant(w.start, 0);
    const categorySet = new Set(b.categories);
    const children = f.budgets.filter((c) => c.parentId === b.id);
    // A parent includes the categories and goal targets of its descendants once.
    const goalIds = new Set<string>();
    const visit = (node: Budget, seen = new Set<string>()) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      if (node.goalId) goalIds.add(node.goalId);
      node.categories.forEach((category) => categorySet.add(category));
      f.budgets.filter((c) => c.parentId === node.id).forEach((c) => visit(c, seen));
    };
    visit(b);
    const categories = categorySet.size ? [...categorySet] : [b.category];
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
                  t.amountUah < 0 &&
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
      categories,
      goalIds: [...goalIds],
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
