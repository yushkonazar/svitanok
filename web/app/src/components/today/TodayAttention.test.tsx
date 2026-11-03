import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TodayAttention } from './TodayAttention.tsx';
import { readFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { SessionExpiredError } from '../../api/client.ts';
import type { Finance } from '../../api/finance-schema.ts';
const label = (minor: number, currency = 'UAH') => moneyLabel(minor, currency).replace(/\s/g, ' ');

const now = vi.hoisted(() => Date.parse('2026-11-03T08:00:00Z'));
const state = vi.hoisted(() => ({
  data: undefined as unknown,
  loading: false,
  error: null as Error | null,
  confirmed: false,
}));
vi.mock('../../lib/useTick.ts', () => ({ useTick: () => now }));
vi.mock('../../api/finance-hooks.ts', () => ({
  useFinance: () => ({
    data: state.data,
    isLoading: state.loading,
    isError: !!state.error,
    error: state.error,
  }),
}));
vi.mock('../../api/hooks.ts', () => ({
  useStats: () => ({
    data: {
      stats: {
        checkinDate: '2026-11-03',
        checkinSlot: 'morning',
        checkinToday: { morning: { confirmed: state.confirmed } },
      },
    },
  }),
}));
vi.mock('./TodaySpendingPulse.tsx', () => ({
  TodaySpendingPulse: () => <button>Витрати тижня</button>,
}));
let f: Finance;
let cache: QueryClient;
beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  resetFinanceDemo();
  f = readFinanceDemo();
  f.accounts = [
    { ...f.accounts[0]!, id: 'cash', kind: 'cash', currency: 'UAH', balanceMinor: 100000 },
  ];
  f.reserveMinor = 10000;
  f.taxiWeeks = [];
  f.transactions = [];
  f.goals = [
    { id: 'one', name: 'Ноутбук', targetMinor: 1000000, deadline: null, status: 'active' },
    { id: 'two', name: 'Подорож', targetMinor: 1000000, deadline: null, status: 'archived' },
  ];
  f.goalMoves = [
    {
      id: 'reserve',
      goalId: 'one',
      accountId: 'cash',
      amountMinor: 20000,
      at: '2026-11-01T10:00:00Z',
    },
    {
      id: 'external',
      goalId: 'two',
      accountId: 'cash',
      amountMinor: 5000,
      movementKind: 'external',
      at: '2026-11-01T10:00:00Z',
    },
  ];
  const base = f.payments[0]!;
  f.payments = [
    { ...base, id: 'later', name: 'Оренда', nextDate: '2026-11-10', amountMinor: 50000 },
    { ...base, id: 'nearest/id', name: 'Інтернет', nextDate: '2026-11-05', amountMinor: 30000 },
  ];
  state.data = { finance: f, demo: true };
  state.loading = false;
  state.error = null;
  state.confirmed = false;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  cache.clear();
  resetFinanceDemo();
  vi.restoreAllMocks();
});
const setup = () =>
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <TodayAttention />
      </MemoryRouter>
    </QueryClientProvider>,
  );

it('stacks a compact check-in and exact nearest payment, without duplicating the old list', () => {
  const { container } = setup();
  const stack = container.querySelector('.today-side-stack')!;
  expect(within(stack as HTMLElement).getAllByRole('link')).toHaveLength(2);
  expect(screen.getByRole('link', { name: /Чек-іни\. Ранок: є чернетка/ })).toHaveAttribute(
    'href',
    '/checkin?date=2026-11-03&slot=morning',
  );
  const payment = screen.getByRole('link', { name: /Платіж Інтернет/ });
  expect(payment).toHaveAttribute('href', '/finance?payment=nearest%2Fid');
  expect(payment).toHaveTextContent('Через 2 дні');
  expect(payment).toHaveTextContent(label(30000));
  expect(screen.queryByText('Найближчі платежі')).not.toBeInTheDocument();
  expect(screen.queryByText('Оренда')).not.toBeInTheDocument();
});
it('shows savings and the combined personal total once, with all goals in the details', () => {
  setup();
  expect(screen.getByRole('link', { name: /Вільні кошти/ })).toHaveTextContent(label(70000));
  const summary = screen.getByRole('button', { name: /У цілях/ });
  expect(summary).toHaveTextContent(label(25000));
  expect(summary).toHaveTextContent(label(95000));
  summary.focus();
  fireEvent.click(summary);
  const sheet = screen.getByRole('dialog', { name: 'Мої кошти' });
  expect(within(sheet).getByText('Ноутбук')).toBeInTheDocument();
  expect(within(sheet).getByText('Подорож')).toBeInTheDocument();
  expect(within(sheet).getByRole('link', { name: 'Мої цілі →' })).toHaveAttribute(
    'href',
    '/finance?analytics=goals',
  );
  fireEvent.click(within(sheet).getByRole('button', { name: 'Закрити підсумок' }));
  expect(summary).toHaveFocus();
});
it('keeps other currencies separate and withholds totals until balances are known', () => {
  f.accounts.push({ ...f.accounts[0]!, id: 'usd', currency: 'USD', balanceMinor: 50000 });
  f.accounts[0]!.balanceMinor = null;
  setup();
  expect(screen.getByRole('link', { name: /Вільні кошти/ })).toHaveTextContent('Мої рахунки');
  const summary = screen.getByRole('button', { name: /У цілях/ });
  expect(summary).toHaveTextContent(label(25000));
  expect(summary).toHaveTextContent('Разом у ₴');
  expect(summary).not.toHaveTextContent(label(95000));
  fireEvent.click(summary);
  const sheet = screen.getByRole('dialog', { name: 'Мої кошти' });
  expect(within(sheet).getByText('USD')).toBeInTheDocument();
  expect(within(sheet).getByText(label(50000, 'USD'))).toBeInTheDocument();
  expect(within(sheet).getByText(/потрібно підтвердити гривневі залишки/)).toBeInTheDocument();
});
it('offers the creation form for an empty schedule and a compact confirmed check-in', () => {
  f.payments = [];
  state.confirmed = true;
  setup();
  expect(screen.getByRole('link', { name: /Немає запланованих/ })).toHaveAttribute(
    'href',
    '/finance?action=payment',
  );
  expect(screen.getByRole('link', { name: /Чек-іни\. Ранок: підтверджено/ })).toHaveTextContent(
    '✓',
  );
  expect(screen.queryByText('Наступний слот з’явиться за розкладом')).not.toBeInTheDocument();
});
it('does not replace loading or expired data with a zero balance or an empty payment claim', () => {
  state.data = undefined;
  state.loading = true;
  const { rerender } = setup();
  expect(screen.getByRole('status')).toHaveTextContent('Завантажую');
  expect(screen.queryByText('Немає запланованих')).not.toBeInTheDocument();
  state.data = { finance: f, demo: false };
  state.loading = false;
  state.error = new SessionExpiredError(401);
  rerender(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <TodayAttention />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button', { name: /У цілях/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Платіж Інтернет/ })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Вільні кошти/ })).toHaveTextContent('Мої рахунки');
});
