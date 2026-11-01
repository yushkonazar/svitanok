import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import type { Finance } from '../../api/finance-schema.ts';
import { fetchFinanceAnalytics, fetchAnalyticsOperations } from '../../api/client.ts';
import { analyticsSelection, buildExpenseAnalytics } from '../../../../core/finance/analytics.mjs';
import { budgetAnalysisAccumulator } from '../../../../core/finance/budget-analysis.mjs';
import { buildFinanceReport } from '../../../../core/finance/reporting.mjs';
import { projectFinances } from '../../../../core/finance/projection.mjs';
import { FinanceAnalytics } from './FinanceAnalytics.tsx';
import { BudgetPlan } from './BudgetPlan.tsx';
import { ProjectionChart } from './ProjectionChart.tsx';
import { Sheet } from './FinanceSheet.tsx';
import { ExpenseCalendar } from './ExpenseCalendar.tsx';
import { FinanceForm } from './FinanceForm.tsx';
import { counted, financeDate } from './analytics-format.ts';

vi.mock('../../api/client.ts', () => ({
  fetchFinanceAnalytics: vi.fn(),
  fetchAnalyticsOperations: vi.fn(),
  postFinance: vi.fn(),
  isSessionExpired: () => false,
}));
const NOW = Date.parse('2026-11-01T14:00:00Z');
let finance: Finance;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  finance = readFinanceDemo();
  finance.transactions = [
    {
      id: 'oct-card',
      at: '2026-10-30T12:00:00Z',
      amountMinor: -123456,
      amountUah: -123456,
      currency: 'UAH',
      category: 'продукти',
      description: 'Маркет',
      kind: 'expense',
      accountId: 'mono:demo',
      bank: true,
      reference: null,
    },
    {
      id: 'previous',
      at: '2026-10-23T12:00:00Z',
      amountMinor: -50000,
      amountUah: -50000,
      currency: 'UAH',
      category: 'інше',
      description: 'Покупка',
      kind: 'expense',
      accountId: 'cash',
      bank: false,
      reference: null,
    },
  ];
  finance.budgets = [
    {
      ...finance.budgets[0]!,
      id: 'food-budget',
      category: 'Харчування',
      categories: ['продукти'],
      period: 'month',
      purpose: 'expense',
      limitMinor: 900000,
    },
  ];
  vi.mocked(fetchFinanceAnalytics).mockImplementation(async (input) => {
    const selection = analyticsSelection(new URLSearchParams(Object.entries(input)), NOW);
    const budgets = budgetAnalysisAccumulator(finance, selection);
    finance.transactions.forEach((t) => budgets.consume(t));
    return {
      ok: true,
      generatedAt: new Date(NOW).toISOString(),
      ...buildExpenseAnalytics(finance.transactions, selection),
      budgetAnalysis: budgets.finish(),
      report: buildFinanceReport(finance, selection.from, selection.to, NOW),
      reportScope: 'all-accounts',
      coverage: {
        bankRetentionDays: 720,
        oldestTransactionAt: '2026-09-01T10:00:00Z',
        beyondBankRetention: false,
        previousBeforeFirstRecord: false,
      },
    };
  });
  vi.mocked(fetchAnalyticsOperations).mockResolvedValue({
    ok: true,
    generatedAt: new Date(NOW).toISOString(),
    items: [],
    nextCursor: null,
  });
});
afterEach(() => {
  cleanup();
  resetFinanceDemo();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function provider(node: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>,
  );
}

it('keeps exact seven-day amounts and dates visible without hovering or selecting a bar', () => {
  provider(<BudgetPlan finance={finance} nowMs={NOW} />);
  const list = screen.getByRole('list', { name: 'Щоденні витрати за останні сім днів' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(7);
  expect(within(list).getByText('1 234,56', { exact: false })).toBeVisible();
  expect(within(list).getByText('30.10')).toBeVisible();
  expect(
    within(list).getByRole('listitem', { name: /01\.11.*сьогодні, день триває/ }),
  ).toBeVisible();
});

it('keeps the chosen budget period, account, source and confirmation filter in the explorer', async () => {
  provider(
    <FinanceAnalytics
      finance={finance}
      initialTab="budgets"
      initialRequest={{
        from: '2026-10-26',
        to: '2026-11-01',
        account: 'cash',
        source: 'manual',
        status: 'confirmed',
      }}
      onBack={() => {}}
    />,
  );
  const picker = await screen.findByLabelText('Період бюджету');
  fireEvent.change(picker, { target: { value: '2026-11-01' } });
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: '2026-11-01',
        to: '2026-11-01',
        account: 'cash',
        source: 'manual',
        status: 'confirmed',
      }),
      expect.objectContaining({ budgetId: 'food-budget', kind: 'expense' }),
    ),
  );
});

it('does not present fragments of two months as a typical full month', async () => {
  provider(
    <FinanceAnalytics
      finance={finance}
      initialTab="budgets"
      initialRequest={{ from: '2026-10-26', to: '2026-11-01' }}
      onBack={() => {}}
    />,
  );
  expect(await screen.findByText('Недостатньо повних періодів')).toBeVisible();
  expect(screen.getByText(/Повних спостережень: 0/)).toBeVisible();
});

it('returns to daily grouping when a six-month chart is narrowed to seven days', async () => {
  provider(
    <FinanceAnalytics
      finance={finance}
      initialTab="dynamics"
      initialRequest={{ from: '2026-10-26', to: '2026-11-01' }}
      onBack={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Місяці.*розширити/ }));
  await waitFor(() =>
    expect(fetchFinanceAnalytics).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-06-01' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '7 днів' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Дні' })).toHaveAttribute('aria-pressed', 'true'),
  );
});

it('labels a calendar subtotal as selected days and opens the month containing most of them', () => {
  render(
    <ExpenseCalendar
      daily={Array.from({ length: 7 }, (_, i) => ({
        date: i === 6 ? '2026-11-01' : `2026-10-${26 + i}`,
        expenseMinor: 10000,
        count: 1,
      }))}
      onSelect={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('Календар витрат'));
  expect(screen.getByLabelText('Місяць')).toHaveValue('2026-10');
  expect(screen.getByText('За вибрані дні місяця')).toBeVisible();
  expect(screen.getByText(/26 жовтня 2026.*31 жовтня 2026/)).toBeVisible();
});

it('labels manual credit values in the selected USD account currency', () => {
  finance.accounts.push({
    ...finance.accounts[0]!,
    id: 'mono:usd',
    kind: 'mono',
    name: 'USD card',
    currency: 'USD',
    creditLimitMinor: 0,
  });
  provider(
    <FinanceForm
      finance={finance}
      request={{ kind: 'credit-limit', id: 'mono:usd' }}
      onClose={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText('Як визначати ліміт'), { target: { value: 'manual' } });
  expect(screen.getByLabelText('Повний кредитний ліміт, USD')).toBeVisible();
  expect(screen.queryByLabelText('Повний кредитний ліміт, ₴')).not.toBeInTheDocument();
});

it('preserves the previous series when opening a category comparison', async () => {
  provider(
    <FinanceAnalytics
      finance={finance}
      initialTab="expenses"
      initialRequest={{ from: '2026-10-26', to: '2026-11-01' }}
      onBack={() => {}}
    />,
  );
  const compare = await screen.findByRole('button', { name: /до попереднього періоду/ });
  fireEvent.click(compare);
  fireEvent.click(await screen.findByRole('button', { name: /Інше · Попередній/ }));
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-10-26', to: '2026-11-01', category: 'інше' }),
      expect.objectContaining({ series: 'previous' }),
    ),
  );
  expect(screen.getByRole('button', { name: 'Попередній' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

it('selects the first and last dates on a dense forecast without overlapping hit circles', () => {
  const projection = projectFinances(finance, 30, NOW);
  render(<ProjectionChart projection={projection} />);
  const chart = screen.getByRole('img', { name: 'Сценарії вільних коштів за днями' });
  vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 320,
    bottom: 245,
    width: 320,
    height: 245,
    toJSON: () => ({}),
  });
  const picker = screen.getByLabelText('Розрахунок дня');
  fireEvent.change(picker, { target: { value: '2026-11-10' } });
  fireEvent.click(chart, { clientX: 68, clientY: 120 });
  expect(picker).toHaveValue('2026-11-01');
  fireEvent.click(chart, { clientX: 293, clientY: 120 });
  expect(picker).toHaveValue('2026-11-30');
  fireEvent.click(screen.getByRole('button', { name: '← День' }));
  expect(picker).toHaveValue('2026-11-29');
});

it('supplies a single visible close control where a finance sheet had none', () => {
  const close = vi.fn();
  render(
    <Sheet label="Інші категорії" onClose={close}>
      <div>
        <h2>Інші категорії</h2>
        <p>Категорія</p>
      </div>
    </Sheet>,
  );
  expect(screen.getAllByRole('heading', { name: 'Інші категорії' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Закрити вікно' }));
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  [1, '1 оплата'],
  [2, '2 оплати'],
  [11, '11 оплат'],
  [14, '14 оплат'],
  [21, '21 оплата'],
  [22, '22 оплати'],
  [25, '25 оплат'],
] as const)('localizes Ukrainian counters for %s', (n, expected) => {
  expect(counted(n, 'оплата', 'оплати', 'оплат')).toBe(expected);
  expect(financeDate('2026-11-01')).toContain('листопада');
});
