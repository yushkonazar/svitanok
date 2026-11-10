import { forecastMoneySample } from '../../../core/finance/income-forecast.mjs';
import {
  calculateTaxiTotals,
  kyivParts,
  MAX_MINOR,
  share,
  sumMoney,
  TAXI_COMMISSION_BPS,
} from '../../../core/finance/planning.mjs';
import type { TaxiWork } from './taxiWork.ts';
import { recordedWorkdays, suggestTaxiDates } from './taxiCalendar.ts';

const grossRate = (days: ReturnType<typeof recordedWorkdays>) =>
  days
    .filter((day) => day.worked && day.complete && day.commissionKnown && day.units >= 0.25)
    .map((day) => Math.round(day.grossMinor / day.units));
const cashFor = (grossMinor: number) => ({
  grossMinor,
  netMinor: grossMinor - share(grossMinor, TAXI_COMMISSION_BPS),
});

export function taxiCashPlan(work: TaxiWork, workdays = work.workdays) {
  const { current, active, now, targetMinor, comparable } = work;
  const days = recordedWorkdays(current, current.entries);
  const selectedDates = new Set(
    suggestTaxiDates(work.planSettings, work.policies, current, current.entries, now, workdays),
  );
  const earnings = new Map<string, number>();
  for (const shift of work.shifts) {
    const date = kyivParts(Date.parse(shift.at)).date;
    earnings.set(date, (earnings.get(date) ?? 0) + shift.earnedMinor);
  }
  const calendar = days.map((day) => ({
    ...day,
    planned: selectedDates.has(day.date),
    locked: day.to <= now || (day.worked && day.complete),
    earnedMinor: earnings.get(day.date) ?? null,
  }));
  const today = calendar.find((day) => day.from <= now && day.to > now);
  const worked = calendar.filter((day) => day.worked && day.locked);
  const slots = calendar.filter((day) => day.planned && !day.locked);
  const handover = slots.find((day) => day.handover);
  const leftUnits = slots.reduce((total, slot) => total + slot.units, 0);
  const doneUnits = worked.reduce((total, slot) => total + slot.units, 0);
  const actualFuel = sumMoney(current.groups.map((group) => group.fuelMinor));

  // Use entire handovers for fuel so a day without a refill is still represented.
  const pastDays = comparable.slice(-16).map((record) => ({
    record,
    days: recordedWorkdays(record.period, record.entries),
  }));
  const fuelRates = pastDays.flatMap(({ record, days: past }) => {
    const work = past.filter((day) => day.worked);
    if (!work.length || work.some((day) => !day.complete)) return [];
    const units = work.reduce((total, day) => total + day.units, 0);
    if (units < 1) return [];
    return [Math.round(sumMoney(record.entries.map((entry) => entry.fuelMinor)) / units)];
  });
  const fuelSample = fuelRates.some((rate) => rate > 0) ? forecastMoneySample(fuelRates, 1) : null;
  const activeUnits = slots
    .filter((slot) => slot.worked)
    .reduce((total, slot) => total + slot.units, 0);
  const observedUnits = doneUnits + activeUnits;
  const fuelRate =
    fuelSample?.estimateMinor ??
    (actualFuel > 0 && observedUnits > 0 ? actualFuel / observedUnits : null);
  const fuelMinor =
    leftUnits === 0
      ? actualFuel
      : Math.min(
          MAX_MINOR,
          Math.max(actualFuel, Math.round((fuelRate ?? 0) * (doneUnits + leftUnits))),
        );
  const fuelLeftMinor = fuelMinor - actualFuel;

  const group = current.groups.find((row) => row.policyId === active?.id);
  const fare = group?.fareBps ?? active?.fareBps ?? 0;
  const grossSoFar = group?.grossMinor ?? 0;
  const feeSoFar = group?.commissionMinor ?? 0;
  const fuelSoFar = group?.fuelMinor ?? 0;
  const retainedRate = active
    ? (fare - (active.commissionBps * TAXI_COMMISSION_BPS) / 10000) / 10000
    : 0;
  const maxFutureGross = MAX_MINOR - current.grossMinor;
  const futureEarned = (grossMinor: number, fuel: number) => {
    if (!active) return 0;
    const fee = share(grossMinor, TAXI_COMMISSION_BPS);
    const earnedFare = share(grossSoFar + grossMinor, fare) - share(grossSoFar, fare);
    const feeShare =
      share(feeSoFar + fee, active.commissionBps) - share(feeSoFar, active.commissionBps);
    const fuelShare = share(fuelSoFar + fuel, active.fuelBps) - share(fuelSoFar, active.fuelBps);
    return earnedFare - feeShare - fuelShare;
  };

  // Solve against the same cent-rounded shares as the ledger. Plans round cash up to hryvnias.
  const requiredFor = (gap: number, fuel: number) => {
    if (!active) return null;
    if (futureEarned(0, fuel) >= gap) return 0;
    if (leftUnits === 0 || retainedRate <= 0) return null;
    let low = 0;
    let high = Math.min(
      Math.floor(maxFutureGross / 100),
      Math.ceil((gap + share(fuel, active.fuelBps) + 3) / retainedRate / 100),
    );
    if (high <= 0 || futureEarned(high * 100, fuel) < gap) return null;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (futureEarned(mid * 100, fuel) >= gap) high = mid;
      else low = mid + 1;
    }
    return high * 100;
  };
  const requiredGross =
    targetMinor === null ? null : requiredFor(targetMinor - current.earnedMinor, fuelLeftMinor);

  const plannedCash = requiredGross === null ? null : cashFor(requiredGross);
  const projectedCash = plannedCash && {
    netMinor: current.netCashMinor + plannedCash.netMinor,
    grossMinor: current.grossMinor + plannedCash.grossMinor,
  };
  const fullDay =
    requiredGross !== null && leftUnits > 0
      ? cashFor(Math.min(maxFutureGross, Math.ceil(requiredGross / leftUnits / 100) * 100))
      : null;
  const handoverCash =
    requiredGross !== null && handover && leftUnits > 0
      ? cashFor(Math.round((requiredGross * handover.units) / leftUnits / 100) * 100)
      : null;
  const first = slots[0];
  const firstCash =
    requiredGross !== null && first && leftUnits > 0
      ? Math.round((requiredGross * first.units) / leftUnits / 100) * 100
      : null;
  const firstFuel =
    first && leftUnits > 0 ? Math.round((fuelLeftMinor * first.units) / leftUnits) : 0;
  let daily = null;
  if (today?.planned && !today.locked && targetMinor !== null && leftUnits > 0) {
    const before = calculateTaxiTotals(
      current.entries.filter((entry) => Date.parse(entry.at) < today.from),
      work.policies,
    ).earnedMinor;
    // Keep today's target anchored to the opening balance until the date closes.
    const goalMinor = Math.round((Math.max(0, targetMinor - before) * today.units) / leftUnits);
    const earnedMinor = current.earnedMinor - before;
    const remainingMinor = Math.max(0, goalMinor - earnedMinor);
    const gross = remainingMinor > 0 ? requiredFor(remainingMinor, firstFuel) : 0;
    daily = {
      goalMinor,
      earnedMinor,
      remainingMinor,
      cash: gross === null ? null : cashFor(gross),
    };
  }
  const firstTargetMinor =
    daily?.remainingMinor ?? (firstCash === null ? null : futureEarned(firstCash, firstFuel));

  const earlierRates = pastDays.flatMap(({ days: past }) => grossRate(past)).slice(-16);
  const currentRates = grossRate(days);
  const rates = [...earlierRates, ...currentRates].slice(-16);
  const baseline = forecastMoneySample(earlierRates, 1);
  const recent = forecastMoneySample(currentRates, 1);
  const historical = forecastMoneySample(rates);
  let forecast = null;
  if (historical && first && active) {
    // Two prior observations stabilize a new period, then the current period takes the lead.
    const expectedRate =
      recent && baseline
        ? (recent.estimateMinor * recent.samples + baseline.estimateMinor * 2) /
          (recent.samples + 2)
        : (recent ?? baseline ?? historical).estimateMinor;
    const sortedRates = [...rates].sort((a, b) => a - b);
    const strongRate = Math.max(
      expectedRate,
      sortedRates[Math.ceil(sortedRates.length * 0.75) - 1]!,
    );
    const scenario = (firstRate: number) => {
      let gross = 0;
      let nextGross = 0;
      for (const [index, slot] of slots.entries()) {
        const dailyRate = index === 0 ? firstRate : expectedRate;
        const additional = Math.max(0, Math.round(dailyRate * slot.units) - slot.grossMinor);
        if (index === 0) nextGross = Math.min(maxFutureGross, additional);
        gross = Math.min(maxFutureGross, gross + additional);
      }
      return {
        nextMinor: futureEarned(nextGross, firstFuel),
        closingMinor: current.earnedMinor + futureEarned(gross, fuelLeftMinor),
      };
    };
    forecast = {
      normal: scenario(expectedRate),
      strong: scenario(strongRate),
      samples: rates.length,
      currentSamples: currentRates.length,
    };
  }
  return {
    slots,
    calendar,
    today,
    daily,
    projectedCash,
    plannedCash,
    fullDay,
    handoverCash,
    firstTargetMinor,
    fuelMinor,
    fuelLeftMinor,
    fuelKnown: leftUnits === 0 || fuelRate !== null || active?.fuelBps === 0,
    fuelPeriods: fuelSample?.samples ?? 0,
    forecast,
    samples: rates.length,
  };
}

export type TaxiCashPlan = ReturnType<typeof taxiCashPlan>;
