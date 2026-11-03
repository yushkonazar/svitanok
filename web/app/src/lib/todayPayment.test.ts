import { expect, it } from 'vitest';
import { nextTodayPayment } from './todayPayment.ts';
import type { Finance } from '../api/finance-schema.ts';

const payment = (
  id: string,
  nextDate: string,
  extra: Partial<Finance['payments'][number]> = {},
): Finance['payments'][number] => ({
  id,
  name: id,
  nextDate,
  kind: 'bill',
  amountMinor: 30000,
  remainingMinor: null,
  installmentsLeft: null,
  anchorDay: 3,
  recurrence: 'month',
  category: 'житло',
  remindDays: 0,
  status: 'active',
  ...extra,
});
it('prioritises the oldest unpaid date without mutating source order or hiding distant payments', () => {
  const input = [
    payment('later', '2026-12-10'),
    payment('paused', '2026-10-01', { status: 'paused' }),
    payment('oldest', '2026-11-01'),
    payment('today', '2026-11-03'),
  ];
  const result = nextTodayPayment(input, '2026-11-03');
  expect(result).toMatchObject({
    kind: 'payment',
    payment: { id: 'oldest' },
    days: -2,
    amountMinor: 30000,
  });
  expect(input[0]!.id).toBe('later');
  expect(nextTodayPayment([input[0]!], '2026-11-03')).toMatchObject({ kind: 'payment', days: 37 });
});
it('uses calendar days across DST and the current debt schedule including the final remainder', () => {
  expect(nextTodayPayment([payment('tomorrow', '2026-10-26')], '2026-10-25')).toMatchObject({
    days: 1,
  });
  expect(nextTodayPayment([payment('today', '2026-11-03')], '2026-11-03')).toMatchObject({
    days: 0,
  });
  const last = payment('last', '2026-11-03', {
    kind: 'installment',
    amountMinor: 1000,
    remainingMinor: 1700,
    overpaymentRemainingMinor: 100,
    installmentsLeft: 1,
  });
  expect(nextTodayPayment([last], '2026-11-03')).toMatchObject({ amountMinor: 1800 });
});
it('distinguishes missing dates and amounts from an empty or completed schedule', () => {
  expect(nextTodayPayment([], '2026-11-03')).toEqual({ kind: 'empty' });
  expect(nextTodayPayment([payment('bad', '2026-02-30')], '2026-11-03')).toEqual({
    kind: 'invalid-date',
  });
  expect(
    nextTodayPayment(
      [
        payment('paid', '2026-11-03', {
          kind: 'loan',
          remainingMinor: 0,
          overpaymentRemainingMinor: 0,
        }),
      ],
      '2026-11-03',
    ),
  ).toEqual({ kind: 'empty' });
  expect(
    nextTodayPayment(
      [
        payment('unknown', '2026-11-03', {
          kind: 'loan',
          interestMethod: 'annuity',
          remainingMinor: null,
        }),
      ],
      '2026-11-03',
    ),
  ).toMatchObject({ kind: 'payment', amountMinor: null });
});
