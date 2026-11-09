import type { Finance } from '../api/finance-schema.ts';
import {
  calculateTaxiWeek,
  sumMoney,
  taxiEarnings,
  taxiWeek,
  type TaxiTotals,
} from '../../../core/finance/planning.mjs';
import { forecastNextTaxiShift } from '../../../core/finance/income-forecast.mjs';
import { taxiVehicleName } from './taxiPeriods.ts';

type Entry = Finance['taxiEntries'][number];
type WorkPeriod = ReturnType<typeof taxiWeek>;

const DAY = 86_400_000;

function inPeriod(entry: Entry, period: WorkPeriod) {
  if (entry.periodKey) return entry.periodKey === period.key;
  const time = Date.parse(entry.at);
  return time >= period.from && time < period.to;
}

function shiftTotals(entry: Entry): TaxiTotals {
  return {
    grossMinor: entry.netCashMinor + entry.commissionMinor,
    commissionMinor: entry.commissionMinor,
    fuelMinor: entry.fuelMinor,
    tipsMinor: entry.tipsMinor,
    directMinor: entry.directMinor,
  };
}

export function taxiWork(finance: Finance, now: number) {
  const { policies } = finance;
  const occurred = finance.taxiEntries
    .filter((entry) => Date.parse(entry.at) <= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const period = taxiWeek(now, policies);
  const entries = occurred.filter((entry) => inPeriod(entry, period));
  const current = calculateTaxiWeek(entries, policies, now);
  const active = policies.filter((policy) => Date.parse(policy.effectiveAt) <= now).at(-1);
  const policyById = new Map(policies.map((policy) => [policy.id, policy]));
  const hasCommission = entries.every((entry) => entry.commissionReported !== false);
  const provisional = !hasCommission || entries.some((entry) => entry.dayComplete === false);
  const vehicle = taxiVehicleName(now, policies);
  const next = taxiWeek(period.to, policies);

  // Allocate the rounded period total across shifts without introducing rounding drift.
  const accumulated = new Map<string, TaxiTotals>();
  const fareByPolicy = new Map(current.groups.map((group) => [group.policyId, group.fareBps]));
  const shifts = entries.map((entry) => {
    const totals = shiftTotals(entry);
    const previous = accumulated.get(entry.policyId);
    const total = previous
      ? {
          grossMinor: sumMoney([previous.grossMinor, totals.grossMinor]),
          commissionMinor: sumMoney([previous.commissionMinor, totals.commissionMinor]),
          fuelMinor: sumMoney([previous.fuelMinor, totals.fuelMinor]),
          tipsMinor: sumMoney([previous.tipsMinor, totals.tipsMinor]),
          directMinor: sumMoney([previous.directMinor, totals.directMinor]),
        }
      : totals;
    const policy = policyById.get(entry.policyId)!;
    const fareBps = fareByPolicy.get(entry.policyId);
    const earnedMinor =
      taxiEarnings(total, policy, fareBps).earnedMinor -
      (previous ? taxiEarnings(previous, policy, fareBps).earnedMinor : 0);
    accumulated.set(entry.policyId, total);
    return { ...entry, grossMinor: totals.grossMinor, earnedMinor };
  });

  const previousPeriod = taxiWeek(period.from - 1, policies);
  const previousEntries = occurred.filter((entry) => inPeriod(entry, previousPeriod));
  const elapsed = now - period.from;
  const previousCutoff = previousPeriod.from + elapsed;
  const previousReady =
    previousEntries.length > 0 &&
    previousCutoff <= previousPeriod.to &&
    previousEntries.every((entry) => Date.parse(entry.at) < previousPeriod.to) &&
    previousEntries.every(
      (entry) =>
        Date.parse(entry.at) > previousCutoff ||
        (entry.commissionReported !== false && entry.dayComplete !== false),
    );
  const checkpoints = Math.max(3, Math.ceil(elapsed / DAY));
  const earnedBy = (rows: Entry[], from: number, at: number) =>
    calculateTaxiWeek(
      rows.filter((entry) => Date.parse(entry.at) <= at),
      policies,
      from,
    ).earnedMinor;
  const pace = Array.from({ length: elapsed > 0 ? checkpoints + 1 : 1 }, (_, index) => {
    const offset = Math.round((elapsed * index) / checkpoints);
    const at = period.from + offset;
    const previousAt = previousPeriod.from + offset;
    return {
      at,
      previousAt,
      earnedMinor: at === now ? current.earnedMinor : earnedBy(entries, period.from, at),
      previousMinor: previousReady
        ? earnedBy(previousEntries, previousPeriod.from, previousAt)
        : null,
    };
  });
  const previousMinor = pace.at(-1)?.previousMinor ?? null;
  const deltaMinor =
    previousMinor === null || !hasCommission || !entries.length
      ? null
      : current.earnedMinor - previousMinor;
  const previousVehicle = taxiVehicleName(previousPeriod.from, policies);
  const previousPolicy = policies
    .filter((policy) => Date.parse(policy.effectiveAt) <= previousPeriod.from)
    .at(-1);
  const terms = (policy: typeof active) =>
    policy &&
    [
      policy.fareBps,
      policy.commissionBps,
      policy.fuelBps,
      policy.tipsBps,
      policy.thresholdMinor,
      policy.bonusFareBps,
    ].join('/');
  const differentTerms =
    previousVehicle !== vehicle ||
    terms(previousPolicy) !== terms(active) ||
    previousEntries.some((entry) => terms(policyById.get(entry.policyId)) !== terms(active)) ||
    entries.some((entry) => terms(policyById.get(entry.policyId)) !== terms(active));

  const personalMinor = sumMoney(
    finance.transactions
      .filter((tx) => {
        const at = Date.parse(tx.at);
        return tx.personalTaxiType && tx.kind === 'income' && at >= period.from && at <= now;
      })
      .map((tx) => tx.amountUah ?? 0),
  );
  const fromFareMinor = current.earnedMinor - sumMoney(current.groups.map((g) => g.extrasMinor));
  const takeHomePer100 =
    hasCommission && current.grossMinor > 0 ? (100 * fromFareMinor) / current.grossMinor : null;
  const sameVehiclePolicies = new Set(
    policies
      .filter((policy) => taxiVehicleName(Date.parse(policy.effectiveAt), policies) === vehicle)
      .map((policy) => policy.id),
  );
  const comparable = occurred
    .filter(
      (entry) =>
        sameVehiclePolicies.has(entry.policyId) &&
        entry.dayComplete !== false &&
        entry.commissionReported !== false &&
        (entry.netCashMinor > 0 || entry.commissionMinor > 0 || entry.directMinor > 0),
    )
    .slice(-16);
  const forecastFare =
    active && active.thresholdMinor !== null && current.grossMinor > active.thresholdMinor
      ? active.bonusFareBps
      : active?.fareBps;
  const forecast = active
    ? forecastNextTaxiShift(
        comparable.map(
          (entry) => taxiEarnings(shiftTotals(entry), active, forecastFare).earnedMinor,
        ),
      )
    : null;
  const targetMinor = finance.forecast.taxiTargets?.[period.key] ?? null;
  const remainingMinor =
    targetMinor === null ? null : Math.max(0, targetMinor - current.earnedMinor);
  return {
    current,
    active,
    next,
    vehicle,
    provisional,
    hasCommission,
    shifts,
    pace,
    previousPeriod,
    previousReady,
    differentTerms,
    deltaMinor,
    personalMinor,
    totalMinor: current.earnedMinor + personalMinor,
    takeHomePer100,
    forecast,
    comparableCount: comparable.length,
    targetMinor,
    remainingMinor,
    nextTargetMinor: finance.forecast.taxiTargets?.[next.key] ?? null,
  };
}

export type TaxiWork = ReturnType<typeof taxiWork>;
