import type { Finance } from '../api/finance-schema.ts';
import { financeView } from './financeView.ts';
import { budgetRows, budgetLimit, periodWindow, type Budget } from './budgetPlanning.ts';
import { paymentSchedule } from './paymentSchedule.ts';
import {
  kyivParts,
  shiftDate,
  nextPaymentDate,
  sumMoney,
} from '../../../core/finance/planning.mjs';

/** Remaining plans, not past spending, are deducted from today's actual free balance. */
export function financeForecast(f: Finance, days: number, nowMs: number) {
  const today = kyivParts(nowMs).date,
    until = shiftDate(today, days - 1),
    view = financeView(f, days, nowMs);
  const payments = f.payments
    .filter((p) => p.status === 'active')
    .flatMap((p) =>
      paymentSchedule(p, 1200)
        .filter((r) => r.date <= until)
        .map((r) => ({ ...r, category: p.category, name: p.name })),
    );
  const obligations = sumMoney(payments.map((r) => r.payment));
  const rows = budgetRows(f, nowMs);
  const enabled = rows.filter((b) => b.forecastEnabled);
  const parentOf = (b: Budget) => f.budgets.find((p) => p.id === b.parentId);
  const selectedRoots = enabled.filter((b) => {
    let p = parentOf(b);
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      if (p.forecastEnabled) return false;
      seen.add(p.id);
      p = parentOf(p);
    }
    return true;
  });
  const isInside = (b: Budget, root: Budget) => {
    let p: Budget | undefined = b;
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      if (p.id === root.id) return true;
      seen.add(p.id);
      p = parentOf(p);
    }
    return false;
  };
  const daily = (b: Budget, date: string) => {
    const w = periodWindow(b.period, date),
      remainingDays =
        Math.round(
          (Date.parse(w.end) - Date.parse(w.start <= today ? today : w.start)) / 86400000,
        ) + 1;
    const row = rows.find((r) => r.id === b.id)!;
    const spent = w.start <= today && w.end >= today ? row.spent : 0;
    return Math.max(0, budgetLimit(b, f.budgets, date) - spent) / remainingDays;
  };
  const branch = (b: Budget, date: string): number => {
    const children = f.budgets.filter((c) => c.parentId === b.id && c.forecastEnabled);
    // Parent is the envelope; child allocations are included, never added twice.
    return Math.max(
      daily(b, date),
      children.reduce((n, c) => n + branch(c, date), 0),
    );
  };
  const plans = selectedRoots.map((b) => {
    const planned = Math.round(
      Array.from({ length: days }, (_, i) => branch(b, shiftDate(today, i))).reduce(
        (a, v) => a + v,
        0,
      ),
    );
    const covered =
      b.purpose === 'expense'
        ? sumMoney(payments.filter((p) => b.categories.includes(p.category)).map((p) => p.payment))
        : 0;
    return {
      id: b.id,
      name: b.category,
      purpose: b.purpose,
      categories: b.categories,
      amount: Math.max(0, planned - covered),
      covered,
      goalIds: f.budgets.filter((c) => isInside(c, b) && c.goalId).map((c) => c.goalId!),
    };
  });
  // Separate roots watching the same categories are alternative envelopes, not additive.
  const overlaps: string[] = [];
  // Ancestor envelopes intentionally overlap. Parallel branches must not
  // forecast the same purchases or goal contributions more than once.
  enabled.forEach((a, i) =>
    enabled.slice(i + 1).forEach((b) => {
      if (a.purpose !== b.purpose || isInside(a, b) || isInside(b, a)) return;
      const shared =
        a.purpose === 'expense'
          ? a.categories.some((c) => b.categories.includes(c))
          : !a.goalId || !b.goalId || a.goalId === b.goalId;
      if (shared) overlaps.push(a.category, b.category);
    }),
  );
  const groups: Array<{ plans: typeof plans; amount: number; categories: Set<string> }> = [];
  for (const plan of plans.filter((p) => p.purpose === 'expense')) {
    const matches = groups.filter((g) => plan.categories.some((c) => g.categories.has(c)));
    if (!matches.length) {
      groups.push({ plans: [plan], amount: plan.amount, categories: new Set(plan.categories) });
      continue;
    }
    const merged = {
      plans: [plan, ...matches.flatMap((g) => g.plans)],
      amount: Math.max(plan.amount, ...matches.map((g) => g.amount)),
      categories: new Set([...plan.categories, ...matches.flatMap((g) => [...g.categories])]),
    };
    overlaps.push(...merged.plans.map((p) => p.name));
    matches.forEach((g) => groups.splice(groups.indexOf(g), 1));
    groups.push(merged);
  }
  const plannedExpense = sumMoney(groups.map((g) => g.amount));
  const savings = plans.filter((p) => p.purpose === 'saving');
  const goalPlans = f.goals
    .filter((g) => g.status === 'active' && g.planAmountMinor != null && g.planPeriod)
    .map((g) => {
      let planned = 0;
      for (let i = 0; i < days; i++) {
        const date = shiftDate(today, i),
          w = periodWindow(g.planPeriod!, date),
          leftDays =
            Math.round(
              (Date.parse(w.end) - Date.parse(w.start <= today ? today : w.start)) / 86400000,
            ) + 1;
        const already =
          w.start <= today
            ? sumMoney(
                f.goalMoves
                  .filter(
                    (m) =>
                      m.goalId === g.id &&
                      kyivParts(Date.parse(m.at)).date >= w.start &&
                      Date.parse(m.at) <= nowMs,
                  )
                  .map((m) => m.amountMinor),
              )
            : 0;
        planned += Math.max(0, g.planAmountMinor! - already) / leftDays;
      }
      return { id: g.id, name: g.name, amount: Math.round(planned) };
    });
  const savingGroups = new Map<string, number>();
  let genericSaving = 0;
  for (const s of savings) {
    if (s.goalIds.length === 1)
      savingGroups.set(s.goalIds[0], Math.max(s.amount, savingGroups.get(s.goalIds[0]) ?? 0));
    else genericSaving += s.amount;
  }
  goalPlans.forEach((g) => savingGroups.set(g.id, Math.max(g.amount, savingGroups.get(g.id) ?? 0)));
  const targetedSaving = sumMoney([...savingGroups.values()]);
  const saving = Math.max(genericSaving, targetedSaving);
  const incomes = f.forecast.incomes.flatMap((p) => {
    const results: Array<{ name: string; date: string; amount: number }> = [];
    let date = p.nextDate;
    for (let i = 0; i < 1200 && date <= until; i++) {
      if (date >= today) results.push({ name: p.name, date, amount: p.amountMinor });
      if (p.recurrence === 'once') break;
      date = nextPaymentDate(date, Number(p.nextDate.slice(8)), p.recurrence);
    }
    return results;
  });
  const expectedIncome = sumMoney(incomes.map((i) => i.amount));
  const incomplete =
    view.unknownBalances ||
    overlaps.length > 0 ||
    f.payments.some(
      (p) =>
        p.status === 'active' &&
        p.installmentsLeft === 0 &&
        (p.remainingMinor ?? 0) + (p.overpaymentRemainingMinor ?? 0) > 0,
    );
  return {
    today,
    until,
    available: view.available,
    obligations,
    plannedExpense,
    saving,
    expectedIncome,
    result: incomplete
      ? null
      : sumMoney([view.available, expectedIncome, -obligations, -plannedExpense, -saving]),
    plans,
    goalPlans,
    incomes,
    payments,
    overlaps: [...new Set(overlaps)],
    incomplete,
    hasPlans: enabled.length > 0 || goalPlans.length > 0,
  };
}
