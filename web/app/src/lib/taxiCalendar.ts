import type { Finance } from '../api/finance-schema.ts';
import {
  kyivParts,
  shiftDate,
  TAXI_DEFAULT_WORKDAYS,
  taxiPlanDays,
  taxiWeek,
  taxiWorked,
} from '../../../core/finance/planning.mjs';

type Entry = Finance['taxiEntries'][number];
type Period = ReturnType<typeof taxiWeek>;

export function recordedWorkdays(period: Period, entries: Entry[]) {
  const days = new Map(
    taxiPlanDays(period).map((day) => [
      day.date,
      { ...day, worked: false, complete: true, commissionKnown: true, grossMinor: 0 },
    ]),
  );
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (at < period.from || at >= period.to || !taxiWorked(entry)) continue;
    const day = days.get(kyivParts(at).date)!;
    day.worked = true;
    day.grossMinor += entry.netCashMinor + entry.commissionMinor;
    day.complete &&= entry.dayComplete !== false;
    day.commissionKnown &&= entry.commissionReported !== false;
  }
  return [...days.values()];
}

export function suggestTaxiDates(
  forecast: Finance['forecast'],
  policies: Finance['policies'],
  period: Period,
  entries: Entry[],
  now: number,
  legacyCount = forecast.taxiWorkdays?.[period.key] ?? TAXI_DEFAULT_WORKDAYS,
) {
  const saved = forecast.taxiSchedules?.[period.key];
  if (saved) return saved.dates;
  const days = recordedWorkdays(
    period,
    entries.filter(
      (entry) =>
        (!entry.periodKey || entry.periodKey === period.key) && Date.parse(entry.at) <= now,
    ),
  );
  const today = kyivParts(now).date;
  const worked = days.filter((day) => day.worked && (day.date < today || day.complete));
  const available = days.filter((day) => day.to > now && !worked.includes(day));

  // Reuse a confirmed pattern for a fresh period with the same handover layout.
  const previous = taxiWeek(period.from - 1, policies);
  const previousPlan = forecast.taxiSchedules?.[previous.key];
  if (previousPlan?.dates.length && !forecast.taxiWorkdays?.[period.key]) {
    const previousDays = taxiPlanDays(previous);
    if (
      previousDays.length === days.length &&
      shiftDate(kyivParts(previous.from).date, 7) === kyivParts(period.from).date &&
      kyivParts(previous.from).hour === kyivParts(period.from).hour &&
      kyivParts(previous.from).minute === kyivParts(period.from).minute &&
      kyivParts(previous.to).hour === kyivParts(period.to).hour &&
      kyivParts(previous.to).minute === kyivParts(period.to).minute
    ) {
      const template = new Set(
        previousDays.flatMap((day, i) =>
          previousPlan.dates.includes(day.date) ? [days[i]!.date] : [],
        ),
      );
      return [...worked, ...available.filter((day) => template.has(day.date) || day.worked)].map(
        (day) => day.date,
      );
    }
  }

  // Existing count-only plans remain usable as suggestions until dates are confirmed.
  const regular = available.filter((day) => !day.handover);
  const regularCount = Math.max(
    legacyCount - worked.filter((day) => !day.handover).length,
    regular[0]?.worked ? 1 : 0,
  );
  return [
    ...worked,
    ...regular.slice(0, regularCount),
    ...available.filter((day) => day.handover),
  ].map((day) => day.date);
}
