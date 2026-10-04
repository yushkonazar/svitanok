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
