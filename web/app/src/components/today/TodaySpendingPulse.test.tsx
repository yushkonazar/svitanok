import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../api/client.ts';
import { readFinanceDemo } from '../../api/finance-demo.ts';
import type { FinanceAnalytics } from '../../api/finance-analytics-schema.ts';
import { todaySpendingRequest } from '../../lib/todaySpending.ts';
import { TodaySpendingPulse } from './TodaySpendingPulse.tsx';

let cache: QueryClient;
let data: FinanceAnalytics;
beforeEach(async () => {
  const now = Date.now();
  data = await api.fetchFinanceAnalytics(todaySpendingRequest(now));
  data.summary = {
    ...data.summary,
    expenseMinor: 88000,
    previousExpenseMinor: 100000,
    changeMinor: -12000,
    changeBps: -1200,
  };
  data.coverage = {
    ...data.coverage,
    oldestTransactionAt: '2020-01-01T12:00:00Z',
    previousBeforeFirstRecord: false,
  };
  data.quality.comparisonIncomplete = false;
  data.categories = [
    {
      category: 'продукти',
      amountMinor: 20000,
      previousMinor: 32000,
      deltaMinor: -12000,
      count: 1,
      previousCount: 1,
    },
  ];
  vi.spyOn(api, 'fetchFinanceAnalytics').mockResolvedValue(data);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  cache.clear();
  vi.restoreAllMocks();
});
function setup() {
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <TodaySpendingPulse finance={readFinanceDemo()} nowMs={Date.now()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it('opens the explanation and preserves period, comparison, category and confirmed status in analytics', async () => {
  setup();
  const button = await screen.findByRole('button', { name: /−12%/ });
  button.focus();
  fireEvent.click(button);
  const sheet = screen.getByRole('dialog', { name: 'Витрати цього тижня' });
  expect(within(sheet).getByText('Витрати менші на 12%.')).toBeInTheDocument();
  const link = within(sheet).getByRole('link', { name: 'Переглянути категорію →' });
  const params = new URLSearchParams(link.getAttribute('href')!.split('?')[1]);
  expect(params.get('category')).toBe('продукти');
  expect(params.get('comparison')).toBe('week');
  expect(params.get('status')).toBe('confirmed');
  expect(params.get('from')).toBe(todaySpendingRequest(Date.now()).from);
  expect(api.fetchFinanceAnalytics).toHaveBeenCalledWith(todaySpendingRequest(Date.now()));
  fireEvent.click(within(sheet).getByRole('button', { name: 'Закрити порівняння' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(button).toHaveFocus();
});
it('shows a partial-history explanation instead of a fabricated percentage or category driver', async () => {
  data.coverage.previousBeforeFirstRecord = true;
  setup();
  const button = await screen.findByRole('button', { name: /880/ });
  expect(button).not.toHaveTextContent('%');
  fireEvent.click(button);
  expect(screen.getByText(/недостатньо збереженої історії/)).toBeInTheDocument();
  expect(screen.queryByText('Найбільший внесок у зміну')).not.toBeInTheDocument();
});
it('withholds comparisons while an operation in either period needs review', async () => {
  data.quality.comparisonIncomplete = true;
  setup();
  fireEvent.click(await screen.findByRole('button', { name: /880/ }));
  expect(screen.getByText(/Відсоток поки прихований/)).toBeInTheDocument();
  expect(screen.queryByText('Витрати менші на 12%.')).not.toBeInTheDocument();
});

it('does not retry an expired Telegram session or substitute zero expenses', async () => {
  vi.mocked(api.fetchFinanceAnalytics).mockRejectedValue(new api.SessionExpiredError(401));
  setup();
  fireEvent.click(await screen.findByRole('button', { name: /Переглянути/ }));
  expect(screen.getByText(/Сесію завершено/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Спробувати ще раз' })).not.toBeInTheDocument();
  expect(screen.queryByText('0,00')).not.toBeInTheDocument();
  expect(api.fetchFinanceAnalytics).toHaveBeenCalledTimes(1);
});
