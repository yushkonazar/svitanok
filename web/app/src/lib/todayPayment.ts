import type { Finance } from '../api/finance-schema.ts';
import { isDebtKind, paymentSchedule } from '../../../core/finance/payments.mjs';

function validDate(date: string) {
  const stamp = Date.parse(date);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(stamp) &&
    new Date(stamp).toISOString().slice(0, 10) === date
  );
}

/** Earliest unpaid contract, including overdue ones; reminder settings do not hide it. */
export function nextTodayPayment(payments: Finance['payments'], today: string) {
  const active = payments.filter(
    (payment) =>
      payment.status === 'active' &&
      !(
        isDebtKind(payment.kind) &&
        payment.remainingMinor === 0 &&
        (payment.overpaymentRemainingMinor ?? 0) === 0
      ),
  );
  const payment = active
    .filter((item) => validDate(item.nextDate))
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.id.localeCompare(b.id))[0];
  if (!payment) return { kind: active.length ? 'invalid-date' : 'empty' } as const;
  const amount = paymentSchedule(payment, 1)[0]?.payment;
  return {
    kind: 'payment' as const,
    payment,
    amountMinor: amount != null && Number.isSafeInteger(amount) && amount > 0 ? amount : null,
    days: Math.round((Date.parse(payment.nextDate) - Date.parse(today)) / 86400000),
  };
}
