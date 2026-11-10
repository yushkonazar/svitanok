import type { Finance } from '../api/finance-schema.ts';
import {
  calculateTaxiTotals,
  kyivInstant,
  kyivParts,
  shiftDate,
  sumMoney,
  taxiEarnings,
  taxiEntryWeek,
  taxiWeek,
  TAXI_DEFAULT_WORKDAYS,
  type TaxiPolicy,
  type TaxiEntry,
  type TaxiTotals,
} from '../../../core/finance/planning.mjs';
import { taxiVehicleName } from './taxiPeriods.ts';

type Entry = Finance['taxiEntries'][number];
type WorkPeriod = ReturnType<typeof taxiWeek>;
export type TaxiRecord = { period: WorkPeriod; entries: Entry[] };

export function taxiShiftEarnings<T extends TaxiEntry>(
  entries: T[],
  totals: ReturnType<typeof calculateTaxiTotals>,
  policyById: Map<string, TaxiPolicy>,
) {
  // Allocate the rounded period earnings without introducing rounding drift.
  const accumulated = new Map<string, TaxiTotals>();
  const fareByPolicy = new Map(totals.groups.map((group) => [group.policyId, group.fareBps]));
  return entries.map((entry) => {
    const grossMinor = entry.netCashMinor + entry.commissionMinor;
    const previous = accumulated.get(entry.policyId);
    const total = {
      grossMinor: (previous?.grossMinor ?? 0) + grossMinor,
      commissionMinor: (previous?.commissionMinor ?? 0) + entry.commissionMinor,
      fuelMinor: (previous?.fuelMinor ?? 0) + entry.fuelMinor,
      tipsMinor: (previous?.tipsMinor ?? 0) + entry.tipsMinor,
      directMinor: (previous?.directMinor ?? 0) + entry.directMinor,
    };
    const policy = policyById.get(entry.policyId)!;
    const fareBps = fareByPolicy.get(entry.policyId);
    const earnedMinor =
      taxiEarnings(total, policy, fareBps).earnedMinor -
      (previous ? taxiEarnings(previous, policy, fareBps).earnedMinor : 0);
    accumulated.set(entry.policyId, total);
    return { ...entry, grossMinor, earnedMinor };
  });
}

const commissionKnown = (entry: Entry) => entry.commissionReported !== false;
const comparableEntry = (entry: Entry) => commissionKnown(entry) && entry.dayComplete !== false;
const within = (entry: Entry, period: WorkPeriod) => {
  const at = Date.parse(entry.at);
  return at >= period.from && at < period.to;
};
const incomeTotal = (earnedMinor: number, personalMinor: number, provisional: boolean) => ({
  earnedMinor,
  personalMinor,
  totalMinor: earnedMinor + personalMinor,
  provisional,
});

export function taxiWork(finance: Finance, now: number) {
  const { policies } = finance;
  const occurred = finance.taxiEntries
    .filter((entry) => Date.parse(entry.at) <= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const period = taxiWeek(now, policies);
  const records = new Map<string, TaxiRecord>();
  let implicit = period;
  for (const entry of occurred) {
    const at = Date.parse(entry.at);
    if (!entry.periodKey && (at < implicit.from || at >= implicit.to))
      implicit = taxiWeek(at, policies);
    const existing = records.get(entry.periodKey ?? implicit.key);
    if (existing) existing.entries.push(entry);
    else {
      const owner = entry.periodKey ? taxiEntryWeek(entry, policies) : implicit;
      records.set(owner.key, { period: owner, entries: [entry] });
    }
  }

  const policyById = new Map<string, TaxiPolicy>(policies.map((policy) => [policy.id, policy]));
  const totalsFor = (entries: Entry[]) => {
    const ids = new Set(entries.map((entry) => entry.policyId));
    return calculateTaxiTotals(
      entries,
      policies.filter((policy) => ids.has(policy.id)),
    );
  };
  const entries = records.get(period.key)?.entries ?? [];
  const current = { ...period, ...totalsFor(entries), entries };
  const shifts = taxiShiftEarnings(entries, current, policyById);
  const active = policies.filter((policy) => Date.parse(policy.effectiveAt) <= now).at(-1);
  const hasCommission = entries.every(commissionKnown);
  const provisional = entries.some((entry) => !comparableEntry(entry));
  const vehicle = taxiVehicleName(now, policies);
  const next = taxiWeek(period.to, policies);

  const history = [...records.values()]
    .filter((record) => record.period.to <= period.from)
    .sort((a, b) => a.period.from - b.period.from);
  const previousPeriod = taxiWeek(period.from - 1, policies);
  const previousEntries = records.get(previousPeriod.key)?.entries ?? [];
  const elapsed = now - period.from;
  const previousCutoff = previousPeriod.from + elapsed;
  const previousReady =
    previousEntries.length > 0 &&
    previousCutoff <= previousPeriod.to &&
    previousEntries.every((entry) => within(entry, previousPeriod)) &&
    previousEntries.every(
      (entry) => Date.parse(entry.at) > previousCutoff || comparableEntry(entry),
    );
  const benchmark = history.filter(
    (record) =>
      record.period.to - record.period.from >= elapsed &&
      record.entries.every((entry) => comparableEntry(entry) && within(entry, record.period)),
  );

  const startDate = kyivParts(period.from).date;
  const today = kyivParts(now).date;
  const checkpoints = [period.from];
  for (let day = startDate; day < today; day = shiftDate(day, 1)) {
    checkpoints.push(kyivInstant(shiftDate(day, 1), 0) - 1);
  }
  if (checkpoints.at(-1) !== now) checkpoints.push(now);

  const earnedBy = (rows: Entry[], at: number) =>
    totalsFor(rows.filter((entry) => Date.parse(entry.at) <= at)).earnedMinor;
  const pace = checkpoints.map((at) => {
    const offset = at - period.from;
    const previousAt = previousPeriod.from + offset;
    return {
      at,
      previousAt,
      earnedMinor: at === now ? current.earnedMinor : earnedBy(entries, at),
      previousMinor: previousReady ? earnedBy(previousEntries, previousAt) : null,
      averageMinor: benchmark.length
        ? Math.round(
            benchmark.reduce(
              (total, record) => total + earnedBy(record.entries, record.period.from + offset),
              0,
            ) / benchmark.length,
          )
        : null,
    };
  });
  const previousMinor = pace.at(-1)?.previousMinor ?? null;
  const deltaMinor =
    previousMinor === null || !hasCommission || !entries.length
      ? null
      : current.earnedMinor - previousMinor;
  const terms = (policy: TaxiPolicy | undefined) =>
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
    taxiVehicleName(previousPeriod.from, policies) !== vehicle ||
    [...previousEntries, ...entries].some(
      (entry) => terms(policyById.get(entry.policyId)) !== terms(active),
    );

  const month = today.slice(0, 7);
  const monthStart = kyivInstant(shiftDate(today, 1 - Number(today.slice(8))), 0);
  const personal = finance.transactions.filter(
    (tx) => tx.personalTaxiType && tx.kind === 'income' && Date.parse(tx.at) <= now,
  );
  const personalSince = (from: number) =>
    sumMoney(personal.filter((tx) => Date.parse(tx.at) >= from).map((tx) => tx.amountUah ?? 0));
  const income = finance.taxiPersonalIncome;
  let monthEarned = 0;
  let allEarned = 0;
  let monthIncomplete = false;
  let allIncomplete = false;
  for (const record of records.values()) {
    const isCurrent = record.period.key === period.key;
    const totals = isCurrent ? current : totalsFor(record.entries);
    allEarned += totals.earnedMinor;
    const incomplete = record.entries.some((entry) => !comparableEntry(entry));
    allIncomplete ||= incomplete;
    if (Date.parse(record.entries.at(-1)!.at) < monthStart) continue;
    monthIncomplete ||= incomplete;
    if (Date.parse(record.entries[0]!.at) >= monthStart) {
      monthEarned += totals.earnedMinor;
    } else {
      const contributions = isCurrent
        ? shifts
        : taxiShiftEarnings(record.entries, totals, policyById);
      const monthShifts = contributions.filter((entry) => Date.parse(entry.at) >= monthStart);
      monthEarned += sumMoney(monthShifts.map((entry) => entry.earnedMinor));
    }
  }

  const fromFareMinor =
    current.earnedMinor - sumMoney(current.groups.map((group) => group.extrasMinor));
  const takeHomePer100 =
    hasCommission && current.grossMinor > 0 ? (100 * fromFareMinor) / current.grossMinor : null;
  const sameVehicle = new Set(
    policies
      .filter((policy) => taxiVehicleName(Date.parse(policy.effectiveAt), policies) === vehicle)
      .map((policy) => policy.id),
  );
  const comparable = history
    .map((record) => ({
      period: record.period,
      entries: record.entries.filter(
        (entry) => within(entry, record.period) && sameVehicle.has(entry.policyId),
      ),
    }))
    .filter((record) => record.entries.length > 0);
  const targetMinor = finance.forecast.taxiTargets?.[period.key] ?? null;
  return {
    now,
    policies,
    planSettings: finance.forecast,
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
    averagePeriods: benchmark.length,
    differentTerms,
    deltaMinor,
    income: {
      period: incomeTotal(current.earnedMinor, personalSince(period.from), provisional),
      month: incomeTotal(
        monthEarned,
        income?.month === month ? income.monthMinor : personalSince(monthStart),
        monthIncomplete,
      ),
      all: incomeTotal(allEarned, income?.allMinor ?? personalSince(-Infinity), allIncomplete),
    },
    takeHomePer100,
    comparable,
    targetMinor,
    remainingMinor: targetMinor === null ? null : Math.max(0, targetMinor - current.earnedMinor),
    nextTargetMinor: finance.forecast.taxiTargets?.[next.key] ?? null,
    workdays: finance.forecast.taxiWorkdays?.[period.key] ?? TAXI_DEFAULT_WORKDAYS,
  };
}

export type TaxiWork = ReturnType<typeof taxiWork>;
