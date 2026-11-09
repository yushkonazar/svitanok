import { expect, it } from 'vitest';
import type { Finance } from '../api/finance-schema.ts';
import { readFinanceDemo } from '../api/finance-demo.ts';
import { kyivInstant, taxiWeek } from '../../../core/finance/planning.mjs';
import { taxiWork } from './taxiWork.ts';

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
  const base = readFinanceDemo();
  const work = taxiWork(
    {
      ...base,
      policies,
      taxiEntries: [
        shift('before-cutoff', previous.from + DAY, old.id, 8000),
        shift('after-cutoff', previous.from + 5 * DAY, old.id, 10000),
        shift('one', current.from + DAY, fixed.id, 1),
        shift('two', current.from + 2 * DAY, fixed.id, 1),
        shift('future', now + 1000, fixed.id, 20000),
      ],
      transactions: [],
    },
    now,
  );
  expect(work.pace.at(-1)).toMatchObject({ earnedMinor: 1, previousMinor: 4000 });
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
  expect(work.forecast).toMatchObject({ estimateMinor: 4000, samples: 4 });
  expect(work.current.earnedMinor).toBe(5000);
  expect(work.totalMinor).toBe(8000);
  expect(work.remainingMinor).toBe(15000);
  expect(work.provisional).toBe(true);
  expect(work.deltaMinor).toBeNull();
});
