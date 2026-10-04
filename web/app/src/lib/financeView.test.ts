import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFinanceDemo, resetFinanceDemo, writeFinanceDemo } from '../api/finance-demo.ts';
import { financeView } from './financeView.ts';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T09:00:00Z'));
  resetFinanceDemo();
});
afterEach(() => {
  resetFinanceDemo();
  vi.useRealTimers();
});
it('recalculates available cash, income, category spending, reserves and goals from the same state', () => {
  let sequence = 0;
  const command = (type: string, payload: Record<string, unknown>) =>
    writeFinanceDemo({
      id: `linked-flow-${sequence++}`,
      version: readFinanceDemo().version,
      type,
      payload,
    });
  const initial = financeView(readFinanceDemo(), 7);
  command('taxi-personal-income', {
    accountId: 'cash',
    personalType: 'change',
    amountMinor: 10000,
  });
  const income = financeView(readFinanceDemo(), 7);
  expect(income.available).toBe(initial.available + 10000);
  expect(income.income).toBe(initial.income + 10000);
  expect(readFinanceDemo().reserveMinor).toBe(
    initial.owned - initial.allocated - initial.available,
  );
  command('transaction', {
    kind: 'expense',
    accountId: 'cash',
    amountMinor: 35000,
    category: 'продукти',
  });
  const expense = financeView(readFinanceDemo(), 7);
  expect(expense.available).toBe(income.available - 35000);
  expect(expense.expense).toBe(income.expense + 35000);
  expect(expense.budgets.find((b) => b.categories.includes('продукти'))!.left).toBe(
    income.budgets.find((b) => b.categories.includes('продукти'))!.left - 35000,
  );
  command('goal-move', { goalId: 'laptop', accountId: 'cash', amountMinor: 5000 });
  expect(financeView(readFinanceDemo(), 7).available).toBe(expense.available - 5000);
  const raw = readFinanceDemo().accounts.find((a) => a.kind === 'mono')!.availableMinor;
  command('credit-limit', { accountId: 'mono:demo', creditLimitMinor: 800000 });
  expect(readFinanceDemo().accounts.find((a) => a.kind === 'mono')!.availableMinor).toBe(raw);
  expect(financeView(readFinanceDemo(), 7).available).toBe(expense.available - 5000 - 100000);
  command('account-balance', { accountId: 'cash', balanceMinor: 200000 });
  const final = readFinanceDemo();
  expect(final.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(200000);
  expect(financeView(final, 7).income).toBe(income.income);
});
