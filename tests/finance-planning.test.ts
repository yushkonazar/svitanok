import { describe, expect, it } from 'vitest';
import {
  parseMoney,
  share,
  taxiWeek,
  calculateTaxiWeek,
  nextPaymentDate,
  type TaxiPolicy,
  type TaxiEntry,
} from '../web/core/finance/planning.mjs';

const policy: TaxiPolicy = {
  id: 'original',
  effectiveAt: '2026-01-01T00:00:00Z',
  fareBps: 5000,
  commissionBps: 5000,
  fuelBps: 5000,
  thresholdMinor: 2700000,
  bonusFareBps: 5500,
};
const day = (net: number, commission = 70000, fuel = 100000): TaxiEntry => ({
  id: 'day',
  at: '2026-10-06T18:00:00Z',
  policyId: policy.id,
  netCashMinor: net,
  commissionMinor: commission,
  fuelMinor: fuel,
  tipsMinor: 0,
  directMinor: 0,
});
const now = Date.parse('2026-10-08T10:00:00Z');

describe('personal finance arithmetic', () => {
  it('parses decimal/comma/space exactly, permits negative opening balance only explicitly', () => {
    expect(parseMoney('1 234,56')).toBe(123456);
    expect(parseMoney('0.29')).toBe(29);
    expect(parseMoney('-100,05', true)).toBe(-10005);
    for (const text of ['', '.', '-1', '1e3', 'Infinity', '1.001', '1,2.3'])
      expect(() => parseMoney(text)).toThrow();
    expect(share(9000000000000, 5500)).toBe(4950000000000);
  });
  it('confirmed examples: 4000 after commission, 700 commission, 1000 fuel', () => {
    expect(calculateTaxiWeek([day(400000)], [policy], now).earnedMinor).toBe(150000);
    const bonus = { ...policy, thresholdMinor: 0 };
    expect(calculateTaxiWeek([day(400000)], [bonus], now).earnedMinor).toBe(173500);
  });
  it('27000 exactly keeps 50%; one penny over recalculates ALL gross, not just the excess', () => {
    const exact = calculateTaxiWeek([day(2630000, 70000, 0)], [policy], now);
    expect(exact.groups[0]!.fareBps).toBe(5000);
    const over = calculateTaxiWeek([day(2630001, 70000, 0)], [policy], now);
    expect(over.groups[0]!.fareBps).toBe(5500);
    expect(over.earnedMinor).toBe(1450001);
  });
  it('app tips are split 50/50, legacy direct fares stay personal, and neither triggers the bonus', () => {
    const first = { ...day(100000, 0, 0), tipsMinor: 5000000, directMinor: 20000 };
    const fuel = { ...day(0, 0, 50000), id: 'fuel' };
    const result = calculateTaxiWeek([first, fuel], [policy], now);
    expect(result.grossMinor).toBe(100000);
    expect(result.earnedMinor).toBe(2545000);
    expect(result.groups[0]!.boosted).toBe(false);
  });
  it('the 55% fare bonus does not change the tip share, which can be configured for own-car work', () => {
    const entry = { ...day(400000), tipsMinor: 20000 };
    expect(calculateTaxiWeek([entry], [{ ...policy, thresholdMinor: 0 }], now).earnedMinor).toBe(
      183500,
    );
    expect(calculateTaxiWeek([entry], [{ ...policy, tipsBps: 10000 }], now).earnedMinor).toBe(
      170000,
    );
    expect(() => calculateTaxiWeek([entry], [{ ...policy, tipsBps: 10001 }], now)).toThrow();
  });
  it('new fixed-50 profile cannot change previous entries', () => {
    const hybrid = {
      ...policy,
      id: 'hybrid',
      effectiveAt: '2026-10-07T10:00:00Z',
      thresholdMinor: null,
    };
    const result = calculateTaxiWeek(
      [day(2630001, 70000, 0), { ...day(400000), id: 'hybrid-day', policyId: 'hybrid' }],
      [policy, hybrid],
      now,
    );
    expect(result.groups.map((g) => g.fareBps)).toEqual([5500, 5000]);
  });
});

describe('Kyiv business calendar', () => {
  it('Monday 12:59:59 belongs to the previous week; 13:00 starts the next', () => {
    expect(taxiWeek(Date.parse('2026-10-05T09:59:59Z')).key).toBe('2026-09-28');
    expect(taxiWeek(Date.parse('2026-10-05T10:00:00Z')).key).toBe('2026-10-05');
  });
  it('DST weeks span 167/169 hours rather than shifting Monday boundaries', () => {
    const spring = taxiWeek(Date.parse('2026-03-27T12:00:00Z'));
    const autumn = taxiWeek(Date.parse('2026-10-23T12:00:00Z'));
    expect((spring.to - spring.from) / 3600000).toBe(167);
    expect((autumn.to - autumn.from) / 3600000).toBe(169);
    expect(new Date(autumn.to).toISOString()).toBe('2026-10-26T11:00:00.000Z');
  });
  it('fixed billing day survives February and leap years', () => {
    expect(nextPaymentDate('2026-01-31', 31, 'month')).toBe('2026-02-28');
    expect(nextPaymentDate('2026-02-28', 31, 'month')).toBe('2026-03-31');
    expect(nextPaymentDate('2027-02-28', 29, 'year')).toBe('2028-02-29');
  });
});
