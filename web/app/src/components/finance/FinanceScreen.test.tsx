import { refreshFinanceBank } from '../../api/client.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FinanceScreen } from './FinanceScreen.tsx';
import { readFinanceDemo } from '../../api/finance-demo.ts';
import { setVerticalSwipes } from '../../telegram.ts';
import { useFinance } from '../../api/finance-hooks.ts';
import type { Finance } from '../../api/finance-schema.ts';
import { calculateTaxiWeek, taxiPeriodStart } from '../../../../core/finance/planning.mjs';
vi.mock('../../api/client.ts', async (original) => ({
  ...(await original<typeof import('../../api/client.ts')>()),
  refreshFinanceBank: vi.fn(),
}));
vi.mock('../../api/finance-hooks.ts', () => ({ FINANCE_QUERY: ['finance'], useFinance: vi.fn() }));
vi.mock('../../telegram.ts', async (original) => ({
  ...(await original<typeof import('../../telegram.ts')>()),
  setVerticalSwipes: vi.fn(),
}));
vi.mock('./PaymentDetail.tsx', () => ({
  PaymentDetail: ({ payment }: { payment: Finance['payments'][number] }) => (
    <section data-testid="payment-detail">
      {payment.id} · {payment.name} · {payment.amountMinor}
    </section>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(refreshFinanceBank).mockReset();
});

function renderFinance(path: string, finance = readFinanceDemo()) {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(useFinance).mockReturnValue({
    data: { finance, demo: false },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useFinance>);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient()}>
        <FinanceScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
function taxiHistoryFixture() {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T11:00:00Z'));
  const f = readFinanceDemo(),
    original = f.policies[0]!;
  const cut = '2026-10-16T09:00:00.000Z';
  f.policies = [
    original,
    {
      ...original,
      id: 'hybrid',
      effectiveAt: cut,
      periodStart: true,
      weekDay: 2,
      weekHour: 12,
      weekMinute: 0,
      vehicleName: 'Гібрид',
      thresholdMinor: null,
      bonusFareBps: 5000,
    },
  ];
  f.taxiEntries = ['2026-10-14', '2026-10-07', '2026-09-30'].map((date, i) => ({
    id: `history-shift-${i}`,
    at: `${date}T15:00:00.000Z`,
    policyId: original.id,
    netCashMinor: 400000,
    commissionMinor: 70000,
    fuelMinor: 100000,
    tipsMinor: 0,
    directMinor: 0,
    receivedCashMinor: 260000,
    paidWorkMinor: 0,
    commissionReported: true,
    cashReported: true,
    accountId: 'cash',
    note: '',
    revision: 0,
  }));
  f.taxiWeeks = [cut, '2026-10-12', '2026-10-05', '2026-09-28'].map((key, i) => {
    const w = calculateTaxiWeek(f.taxiEntries, f.policies, taxiPeriodStart(key, f.policies));
    const held = w.entries.reduce((n, e) => n + (e.receivedCashMinor ?? 0), 0);
    return {
      key,
      from: w.from,
      to: w.to,
      grossMinor: w.grossMinor,
      earnedMinor: w.earnedMinor,
      heldMinor: held,
      settlementMinor: w.earnedMinor - held,
      complete: true,
      closed: i > 0,
      settled: i > 1,
    };
  });
  f.settlements = f.taxiWeeks
    .filter((w) => w.settled)
    .map((w) => ({
      id: `settled-${w.key}`,
      weekKey: w.key,
      amountMinor: w.settlementMinor,
      expectedMinor: w.settlementMinor,
      accountId: 'cash',
      at: new Date(w.to!).toISOString(),
    }));
  return f;
}
it('opens taxi terms from the taxi shortcut and keeps general finance settings separate', () => {
  renderFinance('/finance');
  fireEvent.click(screen.getByRole('button', { name: 'Налаштувати таксі ↗' }));
  const taxi = screen.getByRole('dialog', { name: 'Умови роботи таксі' });
  expect(within(taxi).getByLabelText('Профіль')).toBeInTheDocument();
  expect(within(taxi).getByLabelText('Початок дії')).toBeInTheDocument();
  expect(
    within(taxi).queryByLabelText('Типовий період фінансового огляду'),
  ).not.toBeInTheDocument();
  fireEvent.click(within(taxi).getByRole('button', { name: 'Закрити' }));
  fireEvent.click(screen.getByRole('button', { name: 'Налаштування фінансів' }));
  const settings = screen.getByRole('dialog', { name: 'Налаштування фінансів' });
  expect(within(settings).getByLabelText('Типовий період фінансового огляду')).toBeInTheDocument();
  expect(within(settings).queryByLabelText('Профіль')).not.toBeInTheDocument();
});
it('opens the taxi entry form from a linked plan and closes the deep link cleanly', () => {
  renderFinance('/finance?action=taxi');
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByLabelText('Каса після комісії, ₴')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Закрити' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('keeps an open expense and cached balances mounted when a background refresh fails', () => {
  const finance = readFinanceDemo();
  const { rerender } = renderFinance('/finance', finance);
  fireEvent.click(screen.getByRole('button', { name: 'Записати витрату' }));
  fireEvent.change(screen.getByLabelText('Сума, ₴'), { target: { value: '257' } });
  vi.mocked(useFinance).mockReturnValue({
    data: { finance, demo: false },
    isLoading: false,
    error: new TypeError('Load failed'),
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useFinance>);
  rerender(
    <MemoryRouter initialEntries={['/finance']}>
      <QueryClientProvider client={new QueryClient()}>
        <FinanceScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  expect(screen.getByRole('dialog', { name: 'Записати витрату' })).toBeInTheDocument();
  expect(screen.getByLabelText('Сума, ₴')).toHaveValue('257');
  expect(screen.getByRole('status')).toHaveTextContent('Показано останні отримані дані');
});
it('opens all taxi periods directly, selects the unpaid period and preserves it after opening settlement', () => {
  const f = taxiHistoryFixture();
  renderFinance('/finance', f);
  fireEvent.click(screen.getByRole('button', { name: 'Історія перезмінок' }));
  const history = screen.getByRole('dialog', { name: 'Історія перезмінок' });
  expect(within(history).getByText(/Усі періоди: 4/)).toBeInTheDocument();
  expect(within(history).getByLabelText('Робочий період')).toHaveValue('2026-10-12');
  expect(within(history).getByRole('option', { name: /28 вер/ })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Аналітика та звіти' })).not.toBeInTheDocument();
  fireEvent.click(within(history).getByRole('button', { name: 'Розрахуватись' }));
  const form = screen.getByRole('dialog', { name: 'Розрахунок із парком' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(within(form).getByLabelText('Фактична сума розрахунку, ₴')).toHaveValue('1100');
  fireEvent.click(within(form).getByRole('button', { name: 'Закрити' }));
  expect(screen.getByLabelText('Робочий період')).toHaveValue('2026-10-12');
});
it('offers the last closed taxi settlement on the main screen and routes incomplete periods to their records', () => {
  const f = taxiHistoryFixture();
  renderFinance('/finance', f);
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити оплату перезмінки' }));
  expect(screen.getByLabelText('Фактична сума розрахунку, ₴')).toHaveValue('1100');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  cleanup();
  f.taxiWeeks.find((w) => w.key === '2026-10-12')!.complete = false;
  renderFinance('/finance', f);
  fireEvent.click(screen.getByRole('button', { name: 'Доповнити записи періоду' }));
  expect(screen.getByLabelText('Робочий період')).toHaveValue('2026-10-12');
  expect(screen.getByText('Доповни зміни перед розрахунком.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Розрахуватись' })).not.toBeInTheDocument();
});
it('keeps daily finance controls on the main screen and opens analytics lazily from its compact entry', async () => {
  renderFinance('/finance');
  expect(screen.getByRole('button', { name: 'Записати витрату' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Мої цілі' })).toBeInTheDocument();
  expect(screen.queryByText('Ритм особистих витрат')).not.toBeInTheDocument();
  const analyticsButton = screen.getByRole('button', { name: 'Аналітика та звіти' });
  expect(analyticsButton.textContent).toBe('');
  expect(analyticsButton.querySelector('svg')).not.toBeNull();
  fireEvent.click(analyticsButton);
  expect(await screen.findByRole('heading', { name: 'Аналітика та звіти' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '← До фінансів' }));
  expect(screen.getByRole('button', { name: 'Записати витрату' })).toBeInTheDocument();
});
it('opens an assistant link with the exact report period and returns to the main finance screen', async () => {
  renderFinance('/finance?analytics=expenses&from=2026-10-01&to=2026-10-14&category=продукти');
  expect(await screen.findByRole('heading', { name: 'Аналітика та звіти' })).toBeInTheDocument();
  expect(screen.getByText('1 жовтня 2026 р. — 14 жовтня 2026 р. · Київ')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '← До фінансів' }));
  expect(screen.getByRole('button', { name: 'Записати витрату' })).toBeInTheDocument();
});
it('opens the exact payment ID, even when two records have the same owner name', () => {
  const finance = readFinanceDemo();
  const base = finance.payments[0]!;
  finance.payments = [
    { ...base, id: 'home-a', name: 'LoveYouHome', amountMinor: 12000 },
    { ...base, id: 'home-b', name: 'LoveYouHome', amountMinor: 8000 },
  ];
  renderFinance('/finance?payment=home-b', finance);
  expect(screen.getByTestId('payment-detail')).toHaveTextContent('home-b · LoveYouHome · 8000');
  expect(screen.getByTestId('payment-detail')).not.toHaveTextContent('home-a');
});
it('opens the exact bank record and shows the shared owner response, not a new expense form', () => {
  const finance = readFinanceDemo();
  const tx = {
    ...finance.transactions[0]!,
    id: 'bank-selected',
    description: 'Вибрана операція',
    duplicateSuspected: true,
    attention: {
      status: 'different' as const,
      at: '2026-10-11T08:00:00Z',
      source: 'owner' as const,
    },
  };
  finance.transactions = [tx];
  renderFinance('/finance?transaction=bank-selected', finance);
  expect(screen.getByRole('heading', { name: 'Вибрана операція' })).toBeInTheDocument();
  expect(
    screen.getByText('Позначено як різні покупки. Обидві операції залишились в обліку.'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Перевірю списання' })).not.toBeInTheDocument();
});
it('does not silently select a same-name record when the requested ID is missing', () => {
  renderFinance('/finance?payment=deleted-payment');
  expect(screen.getByRole('status')).toHaveTextContent('Цей запис недоступний');
  expect(screen.queryByTestId('payment-detail')).not.toBeInTheDocument();
});
it('keeps an unresolved review visible in the finance overview and opens that exact record', () => {
  const finance = readFinanceDemo();
  finance.transactions = [
    {
      ...finance.transactions[0]!,
      id: 'review-me',
      description: 'На перевірці',
      bank: true,
      duplicateSuspected: true,
      attention: { status: 'reviewing', source: 'owner', at: new Date().toISOString() },
    },
  ];
  renderFinance('/finance', finance);
  fireEvent.click(screen.getByRole('button', { name: /Чекає твоєї перевірки/ }));
  expect(screen.getByRole('heading', { name: 'На перевірці' })).toBeInTheDocument();
  expect(screen.getByText('Чекає твоєї перевірки. Списання не скасовано.')).toBeInTheDocument();
});
it('disables the native Telegram dismiss gesture throughout finances, including collapsed payment rows, and restores it on leaving', () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(setVerticalSwipes).mockClear();
  vi.mocked(useFinance).mockReturnValue({
    data: { finance: readFinanceDemo(), demo: true },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useFinance>);
  const { unmount } = render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <FinanceScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  expect(setVerticalSwipes).toHaveBeenLastCalledWith(false);
  unmount();
  expect(setVerticalSwipes).toHaveBeenLastCalledWith(true);
});

it('starts refresh with one click and visibly disables it while the request is pending', async () => {
  const finance = readFinanceDemo();
  let finish: ((data: { finance: Finance; demo: boolean }) => void) | undefined;
  vi.mocked(refreshFinanceBank).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderFinance('/finance', finance);
  fireEvent.click(screen.getByRole('button', { name: 'Оновити Monobank' }));
  await waitFor(() => expect(refreshFinanceBank).toHaveBeenCalledExactlyOnceWith('all'));
  const button = screen.getByRole('button', { name: 'Оновлюю…' });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  fireEvent.click(button);
  expect(refreshFinanceBank).toHaveBeenCalledOnce();
  await act(async () => finish!({ finance, demo: false }));
  expect(screen.getByRole('button', { name: 'Оновити Monobank' })).toBeEnabled();
});
it('keeps the running state visible after the initial request has returned', () => {
  const finance = readFinanceDemo();
  finance.bankSync = {
    id: 'test',
    active: true,
    phase: 'accounts',
    done: 0,
    total: 3,
    accountId: null,
    imported: 0,
    updated: 0,
    requestedAt: new Date().toISOString(),
    completedAt: null,
    message: 'Оновлюємо залишки карток.',
  };
  renderFinance('/finance', finance);
  expect(screen.getByRole('button', { name: 'Оновлюю…' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Оновлюємо залишки карток');
});
it('shows a newly imported bank operation even when newer manual entries fill the first five positions', () => {
  const finance = readFinanceDemo(),
    base = finance.transactions[0]!;
  finance.transactions = [
    ...Array.from({ length: 6 }, (_, i) => ({
      ...base,
      id: `manual-${i}`,
      bank: false,
      description: `Готівка ${i}`,
      at: new Date(Date.now() - 1000).toISOString(),
    })),
    {
      ...base,
      id: 'grocery',
      bank: true,
      description: 'Супермаркет',
      amountMinor: -75000,
      amountUah: -75000,
      at: new Date(Date.now() - 300000).toISOString(),
    },
  ];
  renderFinance('/finance', finance);
  const operations = within(
    screen.getByRole('heading', { name: 'Останні операції' }).closest('section')!,
  );
  expect(operations.queryByText('Супермаркет')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Monobank' }));
  expect(operations.getByText('Супермаркет')).toBeInTheDocument();
});
