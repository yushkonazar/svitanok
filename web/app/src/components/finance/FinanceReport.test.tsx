import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FinanceReport, previousFinancePeriod } from './FinanceReport.tsx';
import { fetchFinanceReport } from '../../api/client.ts';
vi.mock('../../api/client.ts', () => ({
  isSessionExpired: () => false,
  fetchFinanceReport: vi.fn(async (from: string, to: string) => ({
    ok: true,
    from,
    to,
    generatedAt: '2026-10-05T15:00:00Z',
    otherIncomeMinor: 100000,
    expenseMinor: 40000,
    taxiEarnedMinor: 200000,
    settlementDifferenceMinor: -80000,
    resultMinor: 180000,
    goalContributionsMinor: 20000,
    unclassifiedCount: 0,
    unknownCurrencyCount: 0,
    bankRetentionDays: 720,
    categories: [{ category: 'продукти', amountMinor: 40000, count: 2 }],
    daily: [{ date: from, expenseMinor: 40000, incomeMinor: 100000 }],
    taxiWeeks: [],
  })),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('uses completed calendar periods for history including previous-year months', () => {
  expect(previousFinancePeriod('week', '2026-10-05')).toEqual({
    from: '2026-09-28',
    to: '2026-10-04',
  });
  expect(previousFinancePeriod('month', '2026-01-05')).toEqual({
    from: '2025-12-01',
    to: '2025-12-31',
  });
});
it('does not fetch history until requested and only reloads after the chosen period is submitted', async () => {
  const back = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FinanceReport onBack={back} />
    </QueryClientProvider>,
  );
  expect(fetchFinanceReport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Минулий місяць' }));
  expect(fetchFinanceReport).not.toHaveBeenCalled();
  const from = (screen.getByLabelText('Від') as HTMLInputElement).value,
    to = (screen.getByLabelText('До включно') as HTMLInputElement).value;
  fireEvent.click(screen.getByRole('button', { name: 'Показати звіт' }));
  await waitFor(() => expect(fetchFinanceReport).toHaveBeenCalledWith(from, to));
  expect(await screen.findByRole('heading', { name: 'Результат періоду' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Від'), { target: { value: '2020-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Показати звіт' }));
  expect(screen.getByRole('alert')).toHaveTextContent('366');
  expect(fetchFinanceReport).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '← До фінансів' }));
  expect(back).toHaveBeenCalled();
});
