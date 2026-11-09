import { afterEach, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BudgetPlan } from './BudgetPlan.tsx';
import { readFinanceDemo, resetFinanceDemo, writeFinanceDemo } from '../../api/finance-demo.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
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
    queryFn: async () => ({ finance: readFinanceDemo(), demo: true }),
  });
  return data ? <BudgetPlan finance={data.finance} nowMs={1791633600000} /> : null;
}
it('reveals the exact amount only for the chosen day and opens that plan’s operations', () => {
  const finance = readFinanceDemo();
  const budget = finance.budgets.find((row) => row.purpose === 'expense')!;
  finance.budgets = [budget];
  finance.transactions = [
    {
      ...finance.transactions[0],
      at: '2026-10-08T09:00:00.000Z',
      kind: 'expense',
      currency: 'UAH',
      amountMinor: -24350,
      amountUah: -24350,
      category: budget.categories[0],
    },
  ];
  const onDay = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BudgetPlan finance={finance} nowMs={Date.parse('2026-10-09T11:00:00Z')} onDay={onDay} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button', { name: /Операції дня/ })).not.toBeInTheDocument();
  const chart = screen.getByRole('group', { name: 'Вибрати день витрат' });
  fireEvent.click(within(chart).getByRole('button', { name: /8 жовтня.*243,50/ }));
  expect(within(chart).getByRole('button', { name: /8 жовтня.*243,50/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: /Операції дня/ }));
  expect(onDay).toHaveBeenCalledWith('2026-10-08', budget.categories);
  fireEvent.click(within(chart).getByRole('button', { name: /9 жовтня.*0,00.*День триває/ }));
  expect(screen.queryByRole('button', { name: /Операції дня/ })).not.toBeInTheDocument();
});
it('updates the visible plan immediately, preserves its hierarchy, reconfigures the template and deletes planning without deleting transactions', async () => {
  const initialTxs = readFinanceDemo().transactions.length;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Налаштувати основний план · 50 / 30 / 20' }),
  );
  fireEvent.change(screen.getByLabelText('Плановий дохід за місяць, ₴'), {
    target: { value: '40000' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірив — зберегти план' }));
  await screen.findByText('Основні витрати');
  const root = readFinanceDemo().budgets.find((b) => b.templateRole === 'needs')!;
  expect(readFinanceDemo().budgets.find((b) => b.category === 'Продукти на місяць')?.parentId).toBe(
    root.id,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Налаштувати основний план · 50 / 30 / 20' }));
  fireEvent.change(screen.getByLabelText('Плановий дохід за місяць, ₴'), {
    target: { value: '50000' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірив — зберегти план' }));
  await waitFor(() =>
    expect(readFinanceDemo().budgets.find((b) => b.id === root.id)?.incomeBaseMinor).toBe(5000000),
  );
  expect(readFinanceDemo().budgets).toHaveLength(5);
  expect(readFinanceDemo().transactions).toHaveLength(initialTxs);
  const article = screen.getByText('Основні витрати').closest('article')!;
  fireEvent.click(within(article).getByRole('button', { name: 'Налаштувати' }));
  fireEvent.click(screen.getByRole('button', { name: 'Видалити план' }));
  fireEvent.click(screen.getByRole('button', { name: 'Прибрати план' }));
  await waitFor(() => expect(readFinanceDemo().budgets.some((b) => b.id === root.id)).toBe(false));
  expect(readFinanceDemo().budgets.some((b) => b.parentId === root.id)).toBe(false);
  expect(readFinanceDemo().transactions).toHaveLength(initialTxs);
});
