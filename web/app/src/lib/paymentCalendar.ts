import type { Finance } from '../api/finance-schema.ts';
import { paymentSchedule } from './paymentSchedule.ts';
import { sumMoney, shiftDate } from '../../../core/finance/planning.mjs';
export function paymentCalendar(f: Finance, today: string, days: number, available: number | null) {
  const until = shiftDate(today, days - 1);
  const rows = f.payments
    .filter((p) => p.status === 'active')
    .flatMap((p) =>
      paymentSchedule(p, 1200)
        .filter((r) => r.date <= until)
        .map((r) => ({ ...r, id: p.id, name: p.name })),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  let remaining = available;
  const dates = [...new Set(rows.map((r) => r.date))].map((date) => {
    const payments = rows.filter((r) => r.date === date);
    const amount = sumMoney(payments.map((p) => p.payment));
    if (remaining !== null) remaining = sumMoney([remaining, -amount]);
    return { date, payments, amount, remaining, overdue: date < today };
  });
  return { until, dates, total: sumMoney(rows.map((r) => r.payment)), remaining };
}
