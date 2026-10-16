import { describe, expect, it } from 'vitest';
import {
  taxiWeek,
  calculateTaxiWeek,
  type TaxiEntry,
  type TaxiPolicy,
} from '../web/core/finance/planning.mjs';
import { taxiIncomeForecast, chooseIncomeModel } from '../web/core/finance/income-forecast.mjs';
const DAY = 86400000,
  NOW = Date.parse('2026-10-08T10:00:00Z');
const policy: TaxiPolicy = {
  id: 'p',
  effectiveAt: '2026-01-01T00:00:00Z',
  fareBps: 5000,
  commissionBps: 5000,
  fuelBps: 5000,
  thresholdMinor: null,
  bonusFareBps: 5500,
};
function fixture(policies = [policy]) {
  const period = taxiWeek(NOW, policies);
  const entry = (at: number, id: string): TaxiEntry => ({
    id,
    at: new Date(at).toISOString(),
    policyId: policies[0]!.id,
    netCashMinor: 100000,
    commissionMinor: 0,
    fuelMinor: 0,
    tipsMinor: 0,
    directMinor: 0,
    receivedCashMinor: 0,
    commissionReported: true,
    cashReported: true,
  });
  const taxiEntries: TaxiEntry[] = [];
  for (let n = 1; n <= 6; n++) {
    const w = taxiWeek(NOW - n * 7 * DAY, policies);
    taxiEntries.push(entry(w.from + DAY, `a${n}`), entry(w.from + 4 * DAY, `b${n}`));
  }
  const taxiWeeks = Array.from({ length: 6 }, (_, i) => ({
    ...calculateTaxiWeek(taxiEntries, policies, NOW - (i + 1) * 7 * DAY),
    complete: true,
    closed: true,
  }));
  taxiEntries.push({ ...entry(period.from + DAY, 'actual'), receivedCashMinor: 20000 });
  return { policies, taxiEntries, taxiWeeks, settlements: [] };
}
describe('taxi cashflow forecast', () => {
  it('keeps missing work history explicitly unavailable rather than returning a fabricated forecast', () => {
    expect(taxiIncomeForecast({}, NOW)).toMatchObject({ status: 'unavailable' });
    expect(chooseIncomeModel([])).toMatchObject({ selected: 'median', folds: 0, mae: null });
    const f = fixture();
    f.taxiEntries = [];
    f.taxiWeeks = [];
    expect(taxiIncomeForecast(f, NOW)).toMatchObject({ status: 'insufficient', estimateMinor: 0 });
  });
  it('adds only unreceived current earnings plus future work, never owned cash twice', () => {
    const f = fixture(),
      out = taxiIncomeForecast(f, NOW);
    expect(out.status).toBe('estimated');
    expect(out.pendingMinor).toBe(30000);
    expect(out.futureEarnedMinor).toBe(50000);
    expect(out.estimateMinor).toBe(80000);
    expect(out.lowerMinor).toBe(80000);
    expect(out.date).toBe('2026-10-12');
    expect(out.validation?.folds).toBe(3);
  });
  it('respects a custom handover date and reprices old work with current shares', () => {
    const old = {
      ...policy,
      fareBps: 2500,
      periodStart: true,
      weekDay: 1,
      weekHour: 18,
      weekMinute: 0,
      vehicleName: 'Авто',
    };
    const current = {
      ...old,
      id: 'new',
      effectiveAt: '2026-10-01T00:00:00Z',
      fareBps: 6000,
      periodStart: false,
    };
    const f = fixture([old, current]),
      out = taxiIncomeForecast(f, NOW);
    expect(out.date).toBe('2026-10-13');
    expect(out.futureEarnedMinor).toBe(60000);
  });
  it('recalculates the entire current-period threshold rather than adding a flat historical average', () => {
    const p = { ...policy, thresholdMinor: 150000, bonusFareBps: 6000 },
      f = fixture([p]);
    expect(taxiIncomeForecast(f, NOW).futureEarnedMinor).toBe(70000);
  });
  it('shows sparse history as unknown future work and preserves only already earned pending cashflow', () => {
    const f = fixture();
    f.taxiWeeks = f.taxiWeeks.slice(0, 2);
    const out = taxiIncomeForecast(f, NOW);
    expect(out.status).toBe('insufficient');
    expect(out.estimateMinor).toBe(30000);
    expect(out.futureEarnedMinor).toBeUndefined();
  });
  it('rejects incomplete source weeks and does not use future or short transition periods for training', () => {
    const f = fixture();
    f.taxiWeeks[0]!.complete = false;
    f.taxiWeeks[1]!.to = f.taxiWeeks[1]!.from + 2 * DAY;
    f.taxiWeeks[2]!.to = NOW + DAY;
    expect(taxiIncomeForecast(f, NOW).historyPeriods).toBe(3);
    f.taxiEntries.at(-1)!.cashReported = false;
    expect(taxiIncomeForecast(f, NOW).status).toBe('incomplete');
  });
  it('uses rolling-origin errors from earlier periods and falls back to median with few folds', () => {
    expect(chooseIncomeModel([100, 100, 100, 10000]).selected).toBe('median');
    const validation = chooseIncomeModel([10, 20, 30, 40, 50, 60]);
    expect(validation.folds).toBe(3);
    expect(validation.selected).toBe('last');
    expect(validation.mae).toBe(10);
    expect(
      chooseIncomeModel([10, 20, 30, 40, 50, 60, 1000]).scores.find((s) => s.name === 'last')?.mae,
    ).toBe(243);
  });
});
