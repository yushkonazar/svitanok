import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { readFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import { postFinance } from '../../api/client.ts';
import {
  FinanceSaveUncertainError,
  FinanceCommandRejectedError,
} from '../../api/finance-errors.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { TransactionAmount } from './TransactionAmount.tsx';
import { TerminalSuggestions } from './TerminalSuggestions.tsx';
import { FinanceDisplaySettings } from './FinanceDisplaySettings.tsx';
import { FinanceMilestone } from './FinanceMilestone.tsx';
import { expenseBand, expensePalette } from '../../lib/expensePalette.ts';
vi.mock('../../api/client.ts', async (original) => ({
  ...(await original<typeof import('../../api/client.ts')>()),
  postFinance: vi.fn(),
}));
function mount(node: ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.mocked(postFinance).mockReset();
  resetFinanceDemo();
  sessionStorage.clear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(postFinance).mockResolvedValue({ finance: readFinanceDemo(), demo: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetFinanceDemo();
});
function foreign() {
  return {
    ...readFinanceDemo().transactions[0]!,
    id: 'foreign',
    kind: 'expense',
    currency: 'USD',
    amountMinor: -500,
    amountUah: -20715,
  };
}
it('cycles only the stored historical UAH debit and pauses while the page is hidden', () => {
  vi.useFakeTimers();
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  const { container } = render(<TransactionAmount transaction={foreign()} />);
  const amount = () => container.querySelector('.finance-currency-value')!.textContent;
  expect(amount()).toMatch(/5,00.*USD|5,00.*\$/);
  act(() => vi.advanceTimersByTime(3000));
  expect(amount()).toContain('207,15');
  visibility = 'hidden';
  act(() => vi.advanceTimersByTime(6000));
  expect(amount()).toContain('207,15');
  visibility = 'visible';
  act(() => vi.advanceTimersByTime(3000));
  expect(amount()).not.toContain('207,15');
  expect(container.querySelector('.sr-only')).toHaveTextContent('207,15');
});
it('shows both fixed currency values with reduced motion instead of hiding the historical debit', () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const { container } = render(<TransactionAmount transaction={foreign()} />);
  expect(container.querySelector('.finance-currency-value')).toHaveTextContent('207,15');
  expect(container.querySelector('.finance-currency-value')).toHaveTextContent('5,00');
});
it('does not invent a conversion or expense band when the UAH debit is unknown', () => {
  const { container } = render(
    <TransactionAmount transaction={{ ...foreign(), amountUah: null }} />,
  );
  expect(container.querySelector('.finance-currency-value')).not.toHaveTextContent('207,15');
  expect(container.querySelector('.finance-expense-tone')).toBeNull();
});
it('uses disjoint editable boundaries and regenerates an ordered palette for every added range', () => {
  expect(expenseBand(-20000, [20000, 100000]).rank).toBe(0);
  expect(expenseBand(-20001, [20000, 100000]).rank).toBe(1);
  expect(expenseBand(-100001, [20000, 100000]).rank).toBe(2);
  for (const n of [1, 4, 5, 21]) expect(new Set(expensePalette(n).map((p) => p.dark)).size).toBe(n);
});
it('validates custom boundaries before saving and keeps all settings explicit', async () => {
  const f = readFinanceDemo(),
    close = vi.fn();
  mount(<FinanceDisplaySettings finance={f} onClose={close} />);
  const inputs = screen.getAllByLabelText('До суми, ₴');
  fireEvent.change(inputs[1]!, { target: { value: '200' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/зростати/);
  expect(postFinance).not.toHaveBeenCalled();
  fireEvent.change(inputs[1]!, { target: { value: '1200' } });
  fireEvent.click(screen.getByRole('button', { name: 'Додати межу' }));
  fireEvent.change(screen.getAllByLabelText('До суми, ₴')[3]!, { target: { value: '10000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
  await waitFor(() =>
    expect(postFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'display-settings',
        payload: expect.objectContaining({ expenseThresholds: [20000, 120000, 300000, 1000000] }),
      }),
    ),
  );
  expect(close).toHaveBeenCalledOnce();
});
function terminalFinance() {
  const f = readFinanceDemo();
  f.transactions = [
    {
      ...foreign(),
      id: 'terminal',
      currency: 'UAH',
      amountMinor: 50000,
      amountUah: 50000,
      description: 'Термінал mono',
      kind: 'unclassified',
      bank: true,
      reference: null,
      bankHold: false,
    },
  ];
  return f;
}
it('offers terminal classification inline and links own cash with a single confirmed command', async () => {
  const f = terminalFinance();
  mount(<TerminalSuggestions finance={f} onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Моя готівка' }));
  await waitFor(() =>
    expect(postFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bank-transfer',
        payload: expect.objectContaining({ transactionId: 'terminal', accountId: 'cash' }),
      }),
    ),
  );
  expect(postFinance).toHaveBeenCalledTimes(1);
});
it('lets the user reject a suggested manual cash match when it belongs to a different transfer', async () => {
  const f = terminalFinance();
  f.transactions.push({
    ...f.transactions[0]!,
    id: 'manual',
    bank: false,
    accountId: 'cash',
    kind: 'transfer',
    amountMinor: -50000,
    amountUah: -50000,
  });
  mount(<TerminalSuggestions finance={f} onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /Використати знайдену готівкову/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Моя готівка' }));
  await waitFor(() => expect(postFinance).toHaveBeenCalledTimes(1));
  expect(vi.mocked(postFinance).mock.calls[0]![0].payload).not.toHaveProperty(
    'manualTransactionId',
  );
});
it('keeps an uncertain terminal choice immutable and retries the same operation identifier', async () => {
  vi.mocked(postFinance).mockRejectedValueOnce(new FinanceSaveUncertainError());
  mount(<TerminalSuggestions finance={terminalFinance()} onOpen={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Моя готівка' }));
  const retry = await screen.findByRole('button', { name: 'Перевірити попереднє підтвердження' });
  expect(screen.getByRole('button', { name: 'Інше надходження' })).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(postFinance).toHaveBeenCalledTimes(2));
  expect(vi.mocked(postFinance).mock.calls[1]![0]).toEqual(
    vi.mocked(postFinance).mock.calls[0]![0],
  );
});
it('reloads the canonical transaction after a conflicting choice from another device', async () => {
  const before = terminalFinance(),
    after = terminalFinance();
  after.transactions[0]!.kind = 'income';
  after.version++;
  const reload = vi.fn(async () => ({ finance: after, demo: true }));
  vi.mocked(postFinance).mockRejectedValueOnce(
    new FinanceCommandRejectedError(409, 'Дані змінилися'),
  );
  function App() {
    const { data } = useQuery({
      queryKey: FINANCE_QUERY,
      queryFn: reload,
      initialData: { finance: before, demo: true },
      staleTime: Infinity,
    });
    return <TerminalSuggestions finance={data.finance} onOpen={() => {}} />;
  }
  mount(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Моя готівка' }));
  await waitFor(() => expect(screen.queryByText('Уточнити поповнення')).not.toBeInTheDocument());
  expect(reload).toHaveBeenCalledOnce();
  expect(postFinance).toHaveBeenCalledOnce();
});
it('celebrates a completion without changing money and acknowledges its durable event', async () => {
  const f = readFinanceDemo();
  f.events = [
    {
      id: 'completed',
      kind: 'payment-completed',
      at: new Date().toISOString(),
      seenAt: null,
      data: {
        name: 'Борг',
        paidMinor: 6000,
        debtBeforeMinor: 100000,
        debtReducedMinor: 6000,
        monthlyReliefMinor: 6000,
      },
    },
  ];
  mount(<FinanceMilestone finance={f} />);
  expect(screen.getByRole('heading', { name: 'Борг закрито' })).toBeInTheDocument();
  expect(postFinance).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Чудово' }));
  await waitFor(() =>
    expect(postFinance).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'event-seen', payload: { eventId: 'completed' } }),
    ),
  );
});
