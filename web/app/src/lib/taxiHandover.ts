import type { Finance } from '../api/finance-schema.ts';
import {
  calculateTaxiWeek,
  kyivParts,
  sumMoney,
  taxiPeriodStart,
  taxiPlanDays,
  taxiWorked,
  taxiWeek,
  type TaxiEntry,
} from '../../../core/finance/planning.mjs';
import { taxiVehicleName } from './taxiPeriods.ts';
import { taxiShiftEarnings } from './taxiWork.ts';

const reliable = (entry: TaxiEntry) =>
  entry.commissionReported !== false && entry.dayComplete !== false;
const workedDays = (entries: TaxiEntry[]) =>
  new Set(entries.filter(taxiWorked).map((entry) => kyivParts(Date.parse(entry.at)).date)).size;

export function taxiHandover(finance: Finance, key: string, now: number) {
  const { policies } = finance;
  const period = taxiWeek(taxiPeriodStart(key, policies), policies);
  if (period.to > now) return null;
  const entries = finance.taxiEntries
    .filter((entry) => Date.parse(entry.at) <= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const week = calculateTaxiWeek(entries, policies, period.from);
  const schedule = finance.forecast.taxiSchedules?.[key];
  const targetMinor = finance.forecast.taxiTargets?.[key] ?? null;
  if (!week.entries.length && !schedule && targetMinor === null) return null;
  const shifts = taxiShiftEarnings(
    week.entries,
    week,
    new Map(policies.map((policy) => [policy.id, policy])),
  );
  const planDays = taxiPlanDays(period);
  const planned = new Set(schedule?.dates);
  const original = new Set(schedule?.originalDates);
  const originalTarget = schedule?.initialTargetMinor ?? null;
  const originalUnits = planDays.reduce(
    (sum, day) => sum + (original.has(day.date) ? day.units : 0),
    0,
  );
  let units = 0;
  let priorPlanMinor = 0;
  const days = planDays.map((day) => {
    const actual = shifts.filter((shift) => {
      const at = Date.parse(shift.at);
      return at >= day.from && at < day.to;
    });
    let planMinor = null;
    if (original.has(day.date) && originalTarget !== null && originalUnits > 0) {
      units += day.units;
      const cumulative = Math.round((originalTarget * units) / originalUnits);
      planMinor = cumulative - priorPlanMinor;
      priorPlanMinor = cumulative;
    }
    return {
      ...day,
      planMinor,
      planned: planned.has(day.date),
      earnedMinor: actual.length ? sumMoney(actual.map((shift) => shift.earnedMinor)) : null,
      worked: actual.some(taxiWorked),
    };
  });
  const previousPeriod = taxiWeek(period.from - 1, policies);
  const previous = calculateTaxiWeek(entries, policies, previousPeriod.from);
  const workCount = workedDays(week.entries);
  const previousCount = workedDays(previous.entries);
  const comparable =
    workCount > 0 &&
    previousCount > 0 &&
    week.entries.every(reliable) &&
    previous.entries.every(reliable);
  const vehicle = taxiVehicleName(period.from, policies);
  const settlement = finance.settlements.find((item) => item.weekKey === key);
  const savedWeek = finance.taxiWeeks.find((item) => item.key === key);
  const heldMinor = sumMoney(
    week.entries.map((entry) => (entry.receivedCashMinor ?? 0) - (entry.paidWorkMinor ?? 0)),
  );
  return {
    ...week,
    vehicle,
    days,
    workedDays: workCount,
    plannedDays: schedule ? days.filter((day) => day.planned).length : null,
    originalDays: schedule?.originalDates.length ?? null,
    missingDays: days.filter((day) => day.planned && day.earnedMinor === null).length,
    lateMinor: sumMoney(
      shifts.filter((shift) => Date.parse(shift.at) >= period.to).map((shift) => shift.earnedMinor),
    ),
    bestDay: days
      .filter((day) => day.worked && day.earnedMinor !== null)
      .sort((a, b) => b.earnedMinor! - a.earnedMinor!)[0],
    previousDayDelta: comparable
      ? Math.round(week.earnedMinor / workCount - previous.earnedMinor / previousCount)
      : null,
    previousNetDelta: comparable
      ? Math.round(week.netCashMinor / workCount - previous.netCashMinor / previousCount)
      : null,
    previousVehicle: taxiVehicleName(previousPeriod.from, policies),
    targetMinor,
    originalTarget,
    provisional: !week.entries.length || week.entries.some((entry) => !reliable(entry)),
    settlement,
    heldMinor,
    settlementMinor: week.earnedMinor - heldMinor,
    canSettle:
      savedWeek?.complete !== false &&
      week.entries.length > 0 &&
      week.entries.every(
        (entry) => entry.commissionReported !== false && entry.cashReported !== false,
      ),
  };
}

export type TaxiHandover = NonNullable<ReturnType<typeof taxiHandover>>;
