import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { readFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import { OverviewAnalytics } from './AnalyticsSections.tsx';
import { GoalHistory } from './GoalHistory.tsx';
import { budgetRows } from '../../lib/budgetPlanning.ts';
import { analyticsSelection, buildExpenseAnalytics } from '../../../../core/finance/analytics.mjs';
import { buildFinanceReport } from '../../../../core/finance/reporting.mjs';
const NOW = Date.parse('2026-10-14T12:00:00Z');
afterEach(() => {
  cleanup();
  resetFinanceDemo();
  vi.restoreAllMocks();
});
it('shows before/after counts, all change contributions and the remainder without inventing causes', () => {
  const f = readFinanceDemo();
  f.transactions = Array.from({ length: 9 }, (_, i) => ({
    id: String(i),
    at: '2026-10-10T12:00:00Z',
    amountMinor: -10000,
    amountUah: -10000,
    currency: 'UAH',
    category: 'Категорія ' + i,
    description: 'Оплата',
    kind: 'expense',
    bank: false,
    accountId: 'cash',
    reference: null,
  }));
  const s = analyticsSelection(new URLSearchParams({ from: '2026-10-08', to: '2026-10-14' }), NOW),
    a = buildExpenseAnalytics(f.transactions, s),
    onCategory = vi.fn();
  render(
    <OverviewAnalytics
      onCategory={onCategory}
      data={{
        ok: true,
        generatedAt: new Date(NOW).toISOString(),
        ...a,
        report: buildFinanceReport(f, s.from, s.to, NOW),
        reportScope: 'all-accounts',
        coverage: {
          bankRetentionDays: 720,
          oldestTransactionAt: null,
          beyondBankRetention: false,
          previousBeforeFirstRecord: false,
        },
      }}
    />,
  );
  expect(screen.getByText('Решта 3 категорій')).toBeInTheDocument();
  expect(screen.getByText('Загальна зміна').parentElement).toHaveTextContent('900,00');
  fireEvent.click(screen.getAllByRole('button')[0]!);
  expect(onCategory).toHaveBeenCalledWith('Категорія 0');
});
it('includes child budget categories once and opens a goal contribution by its linked transaction id', () => {
  const f = readFinanceDemo(),
    base = f.budgets[0]!;
  f.budgets = [
    { ...base, id: 'root', category: 'План', categories: [], parentId: null },
    { ...base, id: 'child', category: 'Їжа', categories: ['продукти'], parentId: 'root' },
  ];
  f.transactions = [
    {
      id: 'food',
      at: '2026-10-14T10:00:00Z',
      amountMinor: -5000,
      amountUah: -5000,
      currency: 'UAH',
      category: 'продукти',
      description: 'Маркет',
      kind: 'expense',
      bank: false,
      accountId: 'cash',
      reference: null,
    },
  ];
  expect(budgetRows(f, NOW).find((b) => b.id === 'root')?.spent).toBe(5000);
  f.goalMoves = [
    {
      id: 'move',
      goalId: f.goals[0]!.id,
      accountId: 'cash',
      at: '2026-10-14T10:00:00Z',
      amountMinor: 10000,
      movementKind: 'external',
      transactionId: 'bank-id',
    },
  ];
  const onTransaction = vi.fn();
  render(
    <GoalHistory
      finance={f}
      request={{ goalIds: [f.goals[0]!.id], from: '2026-10-08', to: '2026-10-14' }}
      onClose={vi.fn()}
      onMove={vi.fn()}
      onTransaction={onTransaction}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Переглянути операцію ↗' }));
  expect(onTransaction).toHaveBeenCalledWith('bank-id', '2026-10-14', {
    limit: 50,
    scrollTop: 0,
    all: false,
  });
});
