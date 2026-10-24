import { matchesAnalytics } from './analytics.mjs';
import { kyivParts, shiftDate, sumMoney } from './planning.mjs';
import { budgetPeriod, budgetDefinitionAt, budgetPlanLimit } from './budget-history.mjs';
/** @param {any} finance @param {any} selection */
export function budgetAnalysisAccumulator(finance, selection) {
  const dates = Array.from({ length: selection.days }, (_, i) => shiftDate(selection.from, i));
  const definitions = finance.budgets.filter((/** @type {any} */ b) => b.purpose === 'expense');
  /** @param {any} b @param {string} date @param {Set<string>} [seen] @returns {string[]} */
  const categoriesAt = (b, date, seen = new Set()) => {
    if (seen.has(b.id)) return [];
    seen.add(b.id);
    const definition = budgetDefinitionAt(finance, b.id, date) ?? b;
    return [
      ...new Set([
        ...(definition.categories ?? [definition.category]),
        ...definitions
          .filter(
            (/** @type {any} */ child) =>
              (budgetDefinitionAt(finance, child.id, date) ?? child).parentId === b.id,
          )
          .flatMap((/** @type {any} */ child) => categoriesAt(child, date, new Set(seen))),
      ]),
    ];
  };
  const scopes = new Map(
    definitions.map((/** @type {any} */ b) => [
      b.id,
      new Map(dates.map((date) => [date, new Set(categoriesAt(b, date))])),
    ]),
  );
  /** @type {Map<string,Map<string,number>>} */ const totals = new Map(
    definitions.map((/** @type {any} */ b) => [b.id, new Map(dates.map((d) => [d, 0]))]),
  );
  return {
    /** @param {any} tx */ consume(tx) {
      if (
        tx.kind !== 'expense' ||
        tx.amountUah == null ||
        tx.amountUah >= 0 ||
        !matchesAnalytics(tx, selection, finance.merchantAliases)
      )
        return;
      const date = kyivParts(Date.parse(tx.at)).date;
      if (date < selection.from || date > selection.to) return;
      for (const b of definitions) {
        if (scopes.get(b.id)?.get(date)?.has(tx.category)) {
          const days = totals.get(b.id);
          if (days) days.set(date, (days.get(date) ?? 0) - tx.amountUah);
        }
      }
    },
    finish() {
      return definitions.map((/** @type {any} */ b) => {
        const points = dates.map((date) => {
          const definition = budgetDefinitionAt(finance, b.id, date);
          const historic = finance.budgets
            .map((/** @type {any} */ p) => budgetDefinitionAt(finance, p.id, date))
            .filter(Boolean);
          return {
            date,
            amountMinor: totals.get(b.id)?.get(date) ?? 0,
            planMinor: definition
              ? Math.round(
                  budgetPlanLimit(definition, historic, date) /
                    budgetPeriod(definition.period, date).days,
                )
              : null,
          };
        });
        return {
          id: b.id,
          name: b.category,
          period: b.period,
          points,
          totalMinor: sumMoney(points.map((p) => p.amountMinor)),
          historyKnown: points.every((p) => p.planMinor != null),
          definitionScope:
            'Поточний склад категорій до початку збережених версій; далі історично чинний.',
        };
      });
    },
  };
}
