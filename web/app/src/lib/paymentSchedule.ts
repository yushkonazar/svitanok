import type { Finance } from '../api/finance-schema.ts';
import { nextPaymentDate } from '../../../core/finance/planning.mjs';
export function paymentSchedule(p: Finance['payments'][number], cap = 24) {
  const result: { date: string; payment: number; remaining: number | null }[] = [];
  let date = p.nextDate,
    remaining = p.remainingMinor;
  const count = p.installmentsLeft ?? (p.recurrence === 'once' ? 1 : 12);
  const known = (p.rateBps ?? 0) === 0,
    fee = p.feeMinor ?? 0;
  for (let i = 0; i < Math.min(cap, count); i++) {
    if (remaining === 0) break;
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
