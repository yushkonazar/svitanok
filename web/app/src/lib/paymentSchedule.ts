import type { Finance } from '../api/finance-schema.ts';
import { nextPaymentDate } from '../../../core/finance/planning.mjs';
import { fixedDebtPayment } from '../../../core/finance/payments.mjs';
export function paymentSchedule(p: Finance['payments'][number], cap = 24) {
  const result: {
    date: string;
    payment: number;
    remaining: number | null;
    overpayment?: number;
    extraRemaining?: number;
  }[] = [];
  let date = p.nextDate,
    remaining = p.remainingMinor;
  let extra = p.overpaymentRemainingMinor ?? null;
  const count = p.installmentsLeft ?? (p.recurrence === 'once' ? 1 : 12);
  const known = (p.rateBps ?? 0) === 0,
    fee = p.feeMinor ?? 0;
  for (let i = 0; i < Math.min(cap, count); i++) {
    if (remaining === 0 && (extra ?? 0) === 0) break;
    const fixed = fixedDebtPayment({
      ...p,
      remainingMinor: remaining,
      overpaymentRemainingMinor: extra,
      installmentsLeft: count - i,
    });
    if (fixed && remaining != null && extra != null) {
      remaining -= fixed.principalMinor;
      extra -= fixed.overpaymentMinor;
      result.push({
        date,
        payment: fixed.amountMinor,
        remaining,
        overpayment: fixed.overpaymentMinor,
        extraRemaining: extra,
      });
      if (p.recurrence === 'once') break;
      date = nextPaymentDate(date, p.anchorDay, p.recurrence);
      continue;
    }
    const principal =
      remaining == null || !known ? null : Math.min(remaining, Math.max(0, p.amountMinor - fee));
    const amount = principal == null ? p.amountMinor : principal + fee;
    if (principal != null && remaining != null) remaining -= principal;
    result.push({ date, payment: amount, remaining: known ? remaining : null });
    if (p.recurrence === 'once') break;
    date = nextPaymentDate(date, p.anchorDay, p.recurrence);
  }
  return result;
}
