import { describe, expect, it } from 'vitest';
import { paymentSchedule } from './paymentSchedule.ts';
import type { Finance } from '../api/finance-schema.ts';
const base: Finance['payments'][number] = {
  id: 'p',
  name: 'Credit',
  kind: 'installment',
  amountMinor: 10050,
  remainingMinor: 25001,
  installmentsLeft: 3,
  nextDate: '2027-01-31',
  anchorDay: 31,
  recurrence: 'month',
  category: 'кредити',
  remindDays: 3,
  status: 'active',
  rateBps: 0,
  feeMinor: 50,
};
describe('contract payment schedule', () => {
  it('amortizes a selected annual-interest method and corrects the final rounded payment', () => {
    const rows = paymentSchedule({
      ...base,
      kind: 'loan',
      amountMinor: 10662,
      remainingMinor: 120000,
      totalMinor: 120000,
      installmentsLeft: 12,
      feeMinor: 0,
      rateBps: 1200,
      interestMethod: 'annuity',
    });
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ payment: 10662, remaining: 110538, overpayment: 1200 });
    expect(rows.at(-1)).toMatchObject({ payment: 10660, remaining: 0 });
    expect(rows.reduce((sum, r) => sum + r.payment, 0)).toBe(127942);
    expect(rows.reduce((sum, r) => sum + (r.overpayment ?? 0), 0)).toBe(7942);
  });
  it('projects the whole surcharge without changing the 550 UAH principal', () => {
    const rows = paymentSchedule({
      ...base,
      amountMinor: 5625,
      remainingMinor: 55000,
      totalMinor: 55000,
      feeMinor: 0,
      installmentsLeft: 12,
      overpaymentTotalMinor: 12500,
      overpaymentRemainingMinor: 12500,
      overpaymentPaidMinor: 0,
      termMonths: 12,
    });
    expect(rows).toHaveLength(12);
    expect(rows.reduce((sum, r) => sum + r.payment, 0)).toBe(67500);
    expect(rows.reduce((sum, r) => sum + (r.overpayment ?? 0), 0)).toBe(12500);
    expect(rows.at(-1)).toMatchObject({ remaining: 0, extraRemaining: 0, payment: 5625 });
  });
  it('preserves the 31st anchor and kopecks, reducing only principal', () => {
    expect(paymentSchedule(base)).toEqual([
      { date: '2027-01-31', payment: 10050, remaining: 15001 },
      { date: '2027-02-28', payment: 10050, remaining: 5001 },
      { date: '2027-03-31', payment: 5051, remaining: 0 },
    ]);
  });
  it('does not invent amortization from an interest rate', () => {
    expect(paymentSchedule({ ...base, rateBps: 2400 }).map((r) => r.remaining)).toEqual([
      null,
      null,
      null,
    ]);
  });
  it('keeps a once-only contract to one payment and leaves uncertain outstanding debt visible', () => {
    expect(paymentSchedule({ ...base, recurrence: 'once' })).toHaveLength(1);
    expect(paymentSchedule({ ...base, installmentsLeft: 0 })).toEqual([]);
  });
});
