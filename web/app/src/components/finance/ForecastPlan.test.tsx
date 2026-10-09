import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ForecastPlan } from './ForecastPlan.tsx';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { readFinanceDemo, writeFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import type { FinanceCommand } from '../../api/finance-schema.ts';
vi.mock('../../api/client.ts', () => ({
  postFinance: async (command: FinanceCommand) => {
    writeFinanceDemo(command);
    return { finance: readFinanceDemo(), demo: true };
  },
}));
beforeEach(() => {
  resetFinanceDemo();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
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
