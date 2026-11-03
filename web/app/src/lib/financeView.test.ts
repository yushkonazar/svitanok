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

it('subtracts a real goal transfer once and keeps only virtual goal reserves in available cash', () => {
  const initial = financeView(readFinanceDemo(), 7);
  writeFinanceDemo({
    id: 'external-goal-transfer',
    version: readFinanceDemo().version,
    type: 'goal-move',
    payload: { goalId: 'laptop', accountId: 'cash', amountMinor: 50000, movementKind: 'external' },
  });
  const f = readFinanceDemo(),
    view = financeView(f, 7);
  expect(view.available).toBe(initial.available - 50000);
  expect(view.allocated).toBe(initial.allocated);
  expect(view.expense).toBe(initial.expense);
  expect(
    f.goalMoves.filter((m) => m.goalId === 'laptop').reduce((n, m) => n + m.amountMinor, 0),
  ).toBe(350000);
});

it('keeps total funds unchanged when reserving, transferring and returning savings', () => {
  const initial = financeView(readFinanceDemo(), 7);
  let sequence = 0;
  const move = (amountMinor: number, movementKind: 'reserve' | 'external') =>
    writeFinanceDemo({
      id: 'saving-overview-' + sequence++,
      version: readFinanceDemo().version,
      type: 'goal-move',
      payload: { goalId: 'laptop', accountId: 'cash', amountMinor, movementKind },
    });
  move(50000, 'reserve');
  move(25000, 'external');
  let view = financeView(readFinanceDemo(), 7);
  expect(view.available).toBe(initial.available - 75000);
  expect(view.savings).toBe(initial.savings + 75000);
  expect(view.externalSavings).toBe(initial.externalSavings + 25000);
  expect(view.totalWithSavings).toBe(initial.totalWithSavings);
  move(-10000, 'reserve');
  move(-5000, 'external');
  view = financeView(readFinanceDemo(), 7);
  expect(view.savings).toBe(initial.savings + 60000);
  expect(view.available).toBe(initial.available - 60000);
  expect(view.totalWithSavings).toBe(initial.totalWithSavings);
});

it('counts net recorded savings across goals, including legacy reserves and archived goals', () => {
  const f = readFinanceDemo();
  f.goals = f.goals.map((goal) => ({ ...goal, status: 'archived', targetMinor: 99999999 }));
  const base = { accountId: 'cash', at: new Date().toISOString() };
  f.goalMoves = [
    { ...base, id: 'reserved', goalId: 'laptop', amountMinor: 20000 },
    { ...base, id: 'sent', goalId: 'other', amountMinor: 10000, movementKind: 'external' },
    { ...base, id: 'returned', goalId: 'other', amountMinor: -3000, movementKind: 'external' },
  ];
  const view = financeView(f, 7);
  expect(view.savings).toBe(27000);
  expect(view.allocated).toBe(20000);
  expect(view.externalSavings).toBe(7000);
  expect(view.totalWithSavings).toBe(view.owned - f.reserveMinor + 7000);
});
