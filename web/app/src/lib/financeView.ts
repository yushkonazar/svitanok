import type { Finance } from '../api/finance-schema.ts';
import { budgetRows, orderedBudgets } from './budgetPlanning.ts';
import { interestDebtPayment, fixedDebtPayment } from '../../../core/finance/payments.mjs';
import { sumMoney, kyivParts, kyivInstant, shiftDate } from '../../../core/finance/planning.mjs';

export const moneyLabel = (minor: number, currency = 'UAH') =>
  ((minor || 0) / 100).toLocaleString('uk-UA', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  });
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
  const allocated = sumMoney(
    f.goalMoves.filter((m) => m.movementKind !== 'external').map((m) => m.amountMinor),
  );
  const available = sumMoney([owned, -allocated, -f.reserveMinor]);
  const unknownBalances =
    f.accounts.some((a) => a.currency === 'UAH' && a.balanceMinor === null) ||
    f.taxiWeeks.some((w) => !w.settled && !w.complete);
  const unclassified = txs.filter((t) => t.kind === 'unclassified');
  const budgets = orderedBudgets(budgetRows(f, nowMs));
  const chart = Array.from({ length: days }, (_, i) => {
    const date = shiftDate(today, i - days + 1);
    const expenses = txs.filter(
      (t) =>
        kyivParts(Date.parse(t.at)).date === date && t.kind === 'expense' && t.amountUah != null,
    );
    return { date, value: -sumMoney(expenses.map((t) => t.amountUah!)) / 100 };
  });
  const reminders = f.payments
    .filter(
      (p) =>
        p.status === 'active' &&
        Date.parse(p.nextDate) - Date.parse(today) <= p.remindDays * 86400000,
    )
    .map((p) => ({
      ...p,
      amountMinor:
        interestDebtPayment(p)?.amountMinor ?? fixedDebtPayment(p)?.amountMinor ?? p.amountMinor,
    }));
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
