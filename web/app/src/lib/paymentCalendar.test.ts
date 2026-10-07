import { expect, it } from 'vitest';
import { readFinanceDemo, resetFinanceDemo } from '../api/finance-demo.ts';
import { paymentCalendar } from './paymentCalendar.ts';
it('uses cent-exact due amounts, includes overdue items and excludes completed payments', () => {
  resetFinanceDemo();
  const f = readFinanceDemo();
  const base = f.payments[0]!;
  f.payments = [
    {
      ...base,
      id: 'a',
      name: 'Щотижня',
      status: 'active',
      nextDate: '2026-10-06',
      recurrence: 'week',
      installmentsLeft: null,
      remainingMinor: null,
      interestMethod: null,
      overpaymentRemainingMinor: null,
      amountMinor: 12500,
    },
    {
      ...base,
      id: 'b',
      name: 'Завершено',
      status: 'closed',
      nextDate: '2026-10-07',
      amountMinor: 100000,
    },
  ];
  const p = paymentCalendar(f, '2026-10-07', 7, 20000);
  expect(p.dates.map((x) => x.date)).toEqual(['2026-10-06', '2026-10-13']);
  expect(p.dates[0]?.overdue).toBe(true);
  expect(p.total).toBe(25000);
  expect(p.remaining).toBe(-5000);
  expect(paymentCalendar(f, '2026-10-07', 7, null).remaining).toBeNull();
});
