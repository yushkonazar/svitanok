import type { Finance } from '../api/finance-schema.ts';
import {
  share,
  sumMoney,
  kyivParts,
  kyivInstant,
  shiftDate,
} from '../../../core/finance/planning.mjs';

export const moneyLabel = (minor: number, currency = 'UAH') =>
  (minor / 100).toLocaleString('uk-UA', { style: 'currency', currency, maximumFractionDigits: 2 });
export function financeView(f: Finance, days: number, nowMs = Date.now()) {
  const today = kyivParts(nowMs).date;
  const from = kyivInstant(shiftDate(today, -(days - 1)), 0);
  const txs = f.transactions.filter((t) => Date.parse(t.at) >= from && Date.parse(t.at) <= nowMs);
  const income = sumMoney(
    txs.filter((t) => t.kind === 'income' && t.amountUah != null).map((t) => t.amountUah!),
  );
  const expense = -sumMoney(
    txs.filter((t) => t.kind === 'expense' && t.amountUah != null).map((t) => t.amountUah!),
  );
  const owned = sumMoney(
    f.accounts
      .filter((a) => a.currency === 'UAH' && a.balanceMinor != null)
      .map((a) => a.balanceMinor!),
  );
  const allocated = sumMoney(f.goalMoves.map((m) => m.amountMinor));
  const available = sumMoney([owned, -allocated, -f.reserveMinor]);
  const unknownBalances =
    f.accounts.some((a) => a.currency === 'UAH' && a.balanceMinor === null) ||
    f.taxiWeeks.some((w) => !w.settled && !w.complete);
  const unclassified = txs.filter((t) => t.kind === 'unclassified');
  const budgets = f.budgets.map((b) => {
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const startDate =
      b.period === 'day'
        ? today
        : b.period === 'week'
          ? shiftDate(today, -dow)
          : `${today.slice(0, 7)}-01`;
    const start = kyivInstant(startDate, 0);
    const categories = b.categories.length ? b.categories : [b.category];
    const spent =
      b.purpose === 'saving'
        ? sumMoney(
            f.goalMoves
              .filter((m) => Date.parse(m.at) >= start && Date.parse(m.at) <= nowMs)
              .map((m) => m.amountMinor),
          )
        : -sumMoney(
            f.transactions
              .filter(
                (t) =>
                  t.kind === 'expense' &&
                  categories.includes(t.category) &&
                  t.amountUah != null &&
                  Date.parse(t.at) >= start &&
                  Date.parse(t.at) <= nowMs,
              )
              .map((t) => t.amountUah!),
          );
    const limit = b.limitMinor ?? share(b.incomeBaseMinor ?? 0, b.shareBps ?? 0);
    return {
      ...b,
      spent,
      limit,
      left: limit - spent,
      progress:
        limit === 0 ? (spent > 0 ? 100 : 0) : Math.min(100, Math.max(0, (spent / limit) * 100)),
    };
  });
  const chart = Array.from({ length: days }, (_, i) => {
    const date = shiftDate(today, i - days + 1);
    const expenses = txs.filter(
      (t) =>
        kyivParts(Date.parse(t.at)).date === date && t.kind === 'expense' && t.amountUah != null,
    );
    return { date, value: -sumMoney(expenses.map((t) => t.amountUah!)) / 100 };
  });
  const reminders = f.payments.filter(
    (p) =>
      p.status === 'active' &&
      Date.parse(p.nextDate) - Date.parse(today) <= p.remindDays * 86400000,
  );
  return {
    txs,
    income,
    expense,
    owned,
    allocated,
    available,
    unknownBalances,
    unclassified,
    budgets,
    chart,
    reminders,
  };
}
