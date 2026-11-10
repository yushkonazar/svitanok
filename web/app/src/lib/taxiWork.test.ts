import { expect, it } from 'vitest';
import type { Finance } from '../api/finance-schema.ts';
import { readFinanceDemo } from '../api/finance-demo.ts';
import { kyivInstant, share, taxiWeek } from '../../../core/finance/planning.mjs';
import { taxiWork } from './taxiWork.ts';
import { taxiCashPlan } from './taxiCashPlan.ts';
import { taxiHandover } from './taxiHandover.ts';

const DAY = 86_400_000;
const now = kyivInstant('2026-10-08', 13);
const fixed: Finance['policies'][number] = {
  id: 'fixed',
  effectiveAt: '2026-10-05T10:00:00.000Z',
  fareBps: 5000,
  commissionBps: 5000,
  fuelBps: 5000,
  tipsBps: 5000,
  bonusFareBps: 5000,
  thresholdMinor: null,
};
function shift(
  id: string,
  at: number,
  policyId: string,
  netCashMinor: number,
): Finance['taxiEntries'][number] {
  return {
    id,
    at: new Date(at).toISOString(),
    policyId,
    netCashMinor,
    commissionMinor: 0,
    fuelMinor: 0,
    tipsMinor: 0,
    directMinor: 0,
    receivedCashMinor: 0,
    paidWorkMinor: 0,
    commissionReported: true,
    cashReported: false,
    accountId: 'cash',
    note: '',
    revision: 0,
  };
}

it('compares equal elapsed time without using a bonus earned later, and apportions cents across shifts', () => {
  const old = {
    ...fixed,
    id: 'old',
    effectiveAt: '2026-01-01T00:00:00Z',
    bonusFareBps: 6000,
    thresholdMinor: 10000,
  };
  const policies = [old, fixed];
  const current = taxiWeek(now, policies);
  const previous = taxiWeek(current.from - 1, policies);
  const earlier = taxiWeek(previous.from - 1, policies);
  const base = readFinanceDemo();
  const work = taxiWork(
    {
      ...base,
      policies,
      taxiEntries: [
        shift('before-cutoff', previous.from + DAY, old.id, 8000),
        shift('after-cutoff', previous.from + 5 * DAY, old.id, 10000),
        shift('earlier', earlier.from + DAY, old.id, 10000),
        shift('one', current.from + DAY, fixed.id, 1),
        shift('two', current.from + 2 * DAY, fixed.id, 1),
        shift('future', now + 1000, fixed.id, 20000),
      ],
      transactions: [],
    },
    now,
  );
  expect(work.pace.at(-1)).toMatchObject({ earnedMinor: 1, previousMinor: 4000 });
  expect(work.pace.at(-2)?.previousMinor).toBe(4000);
  expect(work.pace.at(-1)?.averageMinor).toBe(4500);
  expect(work.averagePeriods).toBe(2);
  expect(work.deltaMinor).toBe(-3999);
  expect(work.differentTerms).toBe(true);
  expect(work.shifts.map((entry) => entry.earnedMinor)).toEqual([1, 0]);
});

it('reprices comparable completed shifts and totals only separate personal income', () => {
  const otherCar = {
    ...fixed,
    id: 'other',
    vehicleName: 'Інше авто',
    effectiveAt: '2026-09-01T10:00:00Z',
    periodStart: true,
    weekDay: 0,
    weekHour: 13,
    weekMinute: 0,
  };
  const old = {
    ...otherCar,
    id: 'old',
    vehicleName: 'Гібрид',
    effectiveAt: '2026-09-28T10:00:00Z',
    fareBps: 5500,
  };
  const policies = [otherCar, old, fixed];
  const period = taxiWeek(now, policies);
  const base = readFinanceDemo();
  const tx = { ...base.transactions[0]!, at: new Date(now).toISOString(), personalTaxiType: 'tip' };
  const work = taxiWork(
    {
      ...base,
      policies,
      taxiEntries: [
        shift('other-car', Date.parse(old.effectiveAt) - DAY, otherCar.id, 999999),
        ...Array.from({ length: 4 }, (_, i) => ({
          ...shift(`past-${i}`, period.from - (i + 1) * DAY, old.id, 10000),
          commissionMinor: 2000,
          fuelMinor: 2000,
        })),
        { ...shift('in-progress', period.from + DAY, fixed.id, 6000), dayComplete: false },
        {
          ...shift('missing-fee', period.from + 2 * DAY, fixed.id, 2000),
          commissionReported: false,
          directMinor: 1000,
        },
      ],
      transactions: [
        { ...tx, id: 'tip', kind: 'income', amountUah: 3000 },
        { ...tx, id: 'settlement', kind: 'taxi-settlement', amountUah: 50000 },
      ],
      forecast: { incomes: [], taxiTargets: { [period.key]: 20000 } },
    },
    now,
  );
  const plan = taxiCashPlan(work, 6);
  expect(plan.forecast).toMatchObject({ samples: 4, currentSamples: 0 });
  expect(plan.fuelPeriods).toBe(1);
  const firstFuel = Math.round(
    (plan.fuelLeftMinor * plan.slots[0]!.units) / plan.slots.reduce((n, slot) => n + slot.units, 0),
  );
  expect(plan.forecast?.normal.nextMinor).toBe(6000 - 1380 - share(firstFuel, 5000));
  expect(work.current.earnedMinor).toBe(5000);
  expect(work.income.period.totalMinor).toBe(8000);
  expect(work.remainingMinor).toBe(15000);
  expect(work.provisional).toBe(true);
  expect(work.deltaMinor).toBeNull();
});

it('plans the required cash with 23% commission and fuel, reserving Wednesday morning', () => {
  const policy = {
    ...fixed,
    effectiveAt: '2026-09-30T09:00:00.000Z',
    periodStart: true,
    weekDay: 2,
    weekHour: 12,
    weekMinute: 0,
    vehicleName: 'Гібрид',
  };
  const policies = [policy];
  const first = kyivInstant('2026-11-04', 12);
  const period = taxiWeek(first, policies);
  const previous = taxiWeek(first - 1, policies);
  const history = [1, 2, 3, 4, 5].map((day) => ({
    ...shift(`prior-${day}`, previous.from + day * DAY, policy.id, 154000),
    commissionMinor: 46000,
    fuelMinor: day === 2 ? 100000 : 0,
  }));
  const finance = {
    ...readFinanceDemo(),
    policies,
    taxiEntries: history,
    transactions: [],
    forecast: { incomes: [], taxiTargets: { [period.key]: 1_000_000 } },
  };
  const start = taxiCashPlan(taxiWork(finance, first), 6);
  expect(start.fuelMinor).toBe(120000);
  expect(start.projectedCash).toEqual({ netMinor: 2120041, grossMinor: 2753300 });
  const fewDays = taxiCashPlan(taxiWork(finance, first), 5);
  expect(fewDays.fullDay!.grossMinor).toBeGreaterThan(start.fullDay!.grossMinor);

  const today = kyivInstant('2026-11-10', 8);
  const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09'];
  const current = days.map((date, i) => ({
    ...shift(`now-${i}`, kyivInstant(date, 18), policy.id, 308000),
    commissionMinor: 92000,
    fuelMinor: i === 1 ? 90000 : 0,
  }));
  const work = taxiWork({ ...finance, taxiEntries: [...history, ...current] }, today);
  const end = taxiCashPlan(work, 6);
  expect(end.slots.map(({ date, units, handover }) => [date, units, handover])).toEqual([
    ['2026-11-10', 1, false],
    ['2026-11-11', 0.5, true],
  ]);
  expect(end.fuelLeftMinor).toBe(30000);
  expect(end.forecast!.currentSamples).toBe(5);
  expect(end.forecast!.normal.nextMinor).toBeGreaterThan(120000);
  expect(end.forecast!.strong.nextMinor).toBeGreaterThanOrEqual(end.forecast!.normal.nextMinor);
  expect(end.handoverCash!.grossMinor).toBeLessThan(end.fullDay!.grossMinor);
  const gross = end.plannedCash!.grossMinor;
  const afterFuel =
    work.current.earnedMinor +
    share(gross, 5000) -
    share(share(gross, 2300), 5000) -
    share(end.fuelLeftMinor, 5000);
  expect(afterFuel).toBeGreaterThanOrEqual(1_000_000);
  expect(afterFuel).toBeLessThan(1_000_040);
  expect(taxiCashPlan(work, 5).slots.map(({ date }) => date)).toEqual(['2026-11-11']);
});

it('keeps the daily goal anchored while recording a partial day and carries the gap to handover morning', () => {
  const policy = {
    ...fixed,
    effectiveAt: '2026-09-30T09:00:00.000Z',
    periodStart: true,
    weekDay: 2,
    weekHour: 12,
    weekMinute: 0,
    vehicleName: 'Гібрид',
  };
  const policies = [policy];
  const tuesday = kyivInstant('2026-11-10', 14);
  const period = taxiWeek(tuesday, policies);
  const dates = ['2026-11-09', '2026-11-10', '2026-11-11'];
  const initial = shift('monday', kyivInstant(dates[0]!, 19), policy.id, 1_560_000);
  const today = {
    ...shift('tuesday', kyivInstant(dates[1]!, 13), policy.id, 120000),
    dayComplete: false,
  };
  const finance = {
    ...readFinanceDemo(),
    policies,
    taxiEntries: [initial],
    taxiWeeks: [],
    forecast: {
      incomes: [],
      taxiTargets: { [period.key]: 1_000_000 },
      taxiSchedules: {
        [period.key]: { dates, originalDates: dates, initialTargetMinor: 1_000_000 },
      },
    },
  };
  const opening = taxiCashPlan(taxiWork(finance, tuesday));
  const progress = taxiCashPlan(taxiWork({ ...finance, taxiEntries: [initial, today] }, tuesday));
  expect(opening.daily).toMatchObject({ goalMinor: 146667, remainingMinor: 146667 });
  expect(progress.daily).toMatchObject({
    goalMinor: 146667,
    earnedMinor: 60000,
    remainingMinor: 86667,
  });
  expect(progress.daily!.cash!.netMinor).toBeLessThan(opening.daily!.cash!.netMinor);

  finance.taxiEntries.push({ ...today, dayComplete: true });
  const done = taxiCashPlan(taxiWork(finance, tuesday));
  expect(done.daily).toBeNull();
  expect(done.slots.map(({ date }) => date)).toEqual(['2026-11-11']);
  const morning = taxiCashPlan(taxiWork(finance, period.to - 1));
  expect(morning.today).toMatchObject({ date: '2026-11-11', handover: true });
  expect(morning.daily?.remainingMinor).toBe(160000);
  expect(taxiHandover(finance, period.key, period.to - 1)).toBeNull();
  const report = taxiHandover(finance, period.key, period.to);
  expect(report).toMatchObject({
    earnedMinor: 840000,
    targetMinor: 1_000_000,
    workedDays: 2,
    missingDays: 1,
  });
  expect(report?.days.reduce((total, day) => total + (day.planMinor ?? 0), 0)).toBe(1_000_000);
});

it('allocates a period crossing a month exactly once and uses the all-time personal aggregate', () => {
  const policy = { ...fixed, effectiveAt: '2026-01-01T00:00:00.000Z' };
  const work = taxiWork(
    {
      ...readFinanceDemo(),
      policies: [policy],
      taxiEntries: [
        shift('september', kyivInstant('2026-09-30', 23), policy.id, 1),
        shift('october', kyivInstant('2026-10-01', 2), policy.id, 1),
        shift('this-week', kyivInstant('2026-10-07', 19), policy.id, 4000),
      ],
      transactions: [],
      taxiPersonalIncome: { month: '2026-10', monthMinor: 222, allMinor: 555 },
    },
    now,
  );
  expect(work.income.month).toMatchObject({ earnedMinor: 2000, totalMinor: 2222 });
  expect(work.income.all).toMatchObject({ earnedMinor: 2001, totalMinor: 2556 });
});
