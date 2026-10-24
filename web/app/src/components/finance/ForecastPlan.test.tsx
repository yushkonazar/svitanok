import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ForecastPlan } from './ForecastPlan.tsx';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { readFinanceDemo, writeFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import type { FinanceCommand } from '../../api/finance-schema.ts';
import { fetchFinanceProjection } from '../../api/client.ts';
import { financeForecast } from '../../lib/financeForecast.ts';
vi.mock('../../api/client.ts', () => ({
  fetchFinanceProjection: vi.fn(async (days: number) =>
    financeForecast(readFinanceDemo(), days, 1791633600000),
  ),
  postFinance: async (command: FinanceCommand) => {
    writeFinanceDemo(command);
    return { finance: readFinanceDemo(), demo: true };
  },
}));
beforeEach(() => {
  vi.mocked(fetchFinanceProjection).mockClear();
  resetFinanceDemo();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
it('refreshes its estimate when a bank snapshot changes without a new financial command version', async () => {
  const f = readFinanceDemo(),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <ForecastPlan finance={f} nowMs={1791633600000} onCalendar={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(fetchFinanceProjection).toHaveBeenCalledTimes(1));
  const updated = {
    ...f,
    generatedAt: '2026-10-24T15:00:00Z',
    accounts: f.accounts.map((a) =>
      a.id === 'cash' ? { ...a, balanceMinor: (a.balanceMinor ?? 0) + 10000 } : a,
    ),
  };
  vi.mocked(fetchFinanceProjection).mockImplementationOnce(async (days) =>
    financeForecast(updated, days, 1791633600000),
  );
  rerender(
    <QueryClientProvider client={client}>
      <ForecastPlan finance={updated} nowMs={1791633600000} onCalendar={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(fetchFinanceProjection).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/Прогноз оновився після зміни обліку/)).toHaveTextContent(
    /Кошти зараз: \+100/,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function App() {
  const { data } = useQuery({
    queryKey: FINANCE_QUERY,
    queryFn: async () => ({ finance: readFinanceDemo() }),
  });
  return data ? (
    <ForecastPlan finance={data.finance} nowMs={1791633600000} onCalendar={() => {}} />
  ) : null;
}
it('lets the user repair invalid future income input and saves a forecast without creating transactions or changing account balances', async () => {
  const before = readFinanceDemo();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Планові надходження' }));
  fireEvent.click(screen.getByRole('button', { name: 'Надходження +' }));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти сценарій' }));
  await screen.findByRole('alert');
  fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Зарплата' } });
  fireEvent.change(screen.getByLabelText('Сума, ₴'), { target: { value: 'abc' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти сценарій' }));
  expect(readFinanceDemo().forecast.incomes).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Сума, ₴'), { target: { value: '1 500,50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти сценарій' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const after = readFinanceDemo();
  expect(after.forecast.incomes[0]).toMatchObject({ name: 'Зарплата', amountMinor: 150050 });
  expect(after.transactions).toHaveLength(before.transactions.length);
  expect(after.accounts.map((a) => a.balanceMinor)).toEqual(
    before.accounts.map((a) => a.balanceMinor),
  );
});
