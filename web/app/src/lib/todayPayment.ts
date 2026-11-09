import type { Finance } from '../api/finance-schema.ts';
import { isDebtKind, paymentSchedule } from '../../../core/finance/payments.mjs';
import { bankPaymentAmount } from '../../../core/finance/payment-link.mjs';
import { kyivParts } from '../../../core/finance/planning.mjs';

type Payment = Finance['payments'][number];
type Transaction = Finance['transactions'][number];

export function isPaymentDate(date: string) {
  const stamp = Date.parse(date);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(stamp) &&
    new Date(stamp).toISOString().slice(0, 10) === date
  );
}

export function isOpenPayment(payment: Payment) {
  return (
    payment.status === 'active' &&
    !(
      isDebtKind(payment.kind) &&
      payment.remainingMinor === 0 &&
      (payment.overpaymentRemainingMinor ?? 0) === 0
    )
  );
}

export function isDuePayment(payment: Payment, today: string) {
  return isOpenPayment(payment) && isPaymentDate(payment.nextDate) && payment.nextDate <= today;
}

export function isBankPayment(t: Transaction) {
  return (
    t.bank &&
    !t.bankMissingFromStatement &&
    !t.reference &&
    (bankPaymentAmount(t) ?? 0) < 0 &&
    ['expense', 'unclassified', 'transfer'].includes(t.kind)
  );
}

/** A suggestion still requires the owner's review and confirmation in the payment form. */
export function possibleBankPayment(payment: Payment, transactions: Transaction[]) {
  if (!isPaymentDate(payment.nextDate)) return null;
  const amount = paymentSchedule(payment, 1)[0]?.payment;
  if (!amount) return null;
  const merchantWords = payment.name.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const date = Date.parse(payment.nextDate);
  const matches = transactions.filter((t) => {
    if (!isBankPayment(t) || bankPaymentAmount(t) !== -amount) return false;
    const at = Date.parse(t.at);
    if (!Number.isFinite(at)) return false;
    const days = Math.abs(Date.parse(kyivParts(at).date) - date) / 86400000;
    const words: string[] = t.description.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    return days <= 3 && merchantWords.some((word) => words.includes(word));
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Earliest unpaid contract, including overdue ones; reminder settings do not hide it. */
export function nextTodayPayment(payments: Finance['payments'], today: string) {
  const active = payments.filter(isOpenPayment);
  const payment = active
    .filter((item) => isPaymentDate(item.nextDate))
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
