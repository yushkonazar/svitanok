import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FinanceAnalytics } from './FinanceAnalytics.tsx';
import { AnalyticsBars } from './AnalyticsCharts.tsx';
import { readFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import {
  fetchFinanceAnalytics,
  fetchAnalyticsOperations,
  refreshFinanceBank,
  postFinance,
} from '../../api/client.ts';
import { buildExpenseAnalytics, analyticsSelection } from '../../../../core/finance/analytics.mjs';
import { buildFinanceReport } from '../../../../core/finance/reporting.mjs';
import type { Finance } from '../../api/finance-schema.ts';
vi.mock('../../api/client.ts', async (original) => ({
  ...(await original<typeof import('../../api/client.ts')>()),
  fetchFinanceAnalytics: vi.fn(),
  fetchAnalyticsOperations: vi.fn(),
  refreshFinanceBank: vi.fn(),
  postFinance: vi.fn(),
}));
const NOW = Date.parse('2026-10-14T15:00:00Z');
let finance: Finance;
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  resetFinanceDemo();
  finance = readFinanceDemo();
  finance.transactions = [
    {
      id: 'cafe',
      at: '2026-10-09T10:00:00Z',
      amountMinor: -10000,
      amountUah: -10000,
      currency: 'UAH',
      category: 'кафе й ресторани',
      description: 'Кафе',
      kind: 'expense',
      accountId: 'cash',
      bank: false,
      reference: null,
    },
    {
      id: 'food',
      at: '2026-10-10T10:00:00Z',
      amountMinor: -20000,
      amountUah: -20000,
      currency: 'UAH',
      category: 'продукти',
      description: 'Маркет',
      kind: 'expense',
      accountId: 'mono:demo',
      bank: true,
      bankHold: true,
      reference: null,
    },
    {
      id: 'previous',
      at: '2026-10-03T10:00:00Z',
      amountMinor: -5000,
      amountUah: -5000,
      currency: 'UAH',
      category: 'продукти',
      description: 'Маркет',
      kind: 'expense',
      accountId: 'mono:demo',
      bank: true,
      reference: null,
    },
    {
      id: 'own-transfer',
      at: '2026-10-10T10:00:00Z',
      amountMinor: -800000,
      amountUah: -800000,
      currency: 'UAH',
      category: 'перекази й готівка',
      description: 'Власний переказ',
      kind: 'transfer',
      accountId: 'mono:demo',
      bank: true,
      reference: null,
    },
  ];
  vi.mocked(fetchFinanceAnalytics).mockImplementation(async (input) => {
    const selection = analyticsSelection(new URLSearchParams(Object.entries(input)), NOW);
    return {
      ok: true,
      generatedAt: new Date(NOW).toISOString(),
      ...buildExpenseAnalytics(finance.transactions, selection),
      report: buildFinanceReport(finance, selection.from, selection.to, NOW),
      reportScope: 'all-accounts',
      coverage: {
        bankRetentionDays: 720,
        oldestTransactionAt: finance.transactions.at(-1)?.at ?? null,
        beyondBankRetention: false,
        previousBeforeFirstRecord: false,
      },
    };
  });
  vi.mocked(fetchAnalyticsOperations).mockResolvedValue({
    ok: true,
    generatedAt: new Date(NOW).toISOString(),
    items: finance.transactions.filter((t) => t.kind === 'expense' && t.id !== 'previous'),
    nextCursor: null,
  });
  vi.mocked(postFinance).mockResolvedValue({ finance, demo: false });
});
it('starts with six distinct analysis sections and keeps account reconciliation secondary', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FinanceAnalytics finance={finance} onBack={() => {}} />
    </QueryClientProvider>,
  );
  const nav = screen.getByRole('navigation', { name: 'Розділи фінансової аналітики' });
  expect(within(nav).getAllByRole('button')).toHaveLength(6);
  expect(within(nav).getByRole('button', { name: 'Огляд' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('button', { name: 'Інші розділи аналітики' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Рахунки та звірка ↗' })).toBeInTheDocument();
});
it('shows only the remainder in Other categories instead of repeating the first five', async () => {
  finance.transactions.push(
    ...['авто', 'транспорт', 'спорт', 'цифрові сервіси', 'інше'].map((category, i) => ({
      ...finance.transactions[0]!,
      id: `extra-${i}`,
      category,
      amountMinor: -(i + 1) * 1000,
      amountUah: -(i + 1) * 1000,
    })),
  );
  open();
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  fireEvent.click(screen.getByRole('button', { name: /Інші категорії.*30,00/ }));
  const dialog = screen.getByRole('dialog', { name: 'Інші категорії витрат' });
  expect(within(dialog).getAllByRole('button')).toHaveLength(2);
  expect(within(dialog).queryByText('Кафе та ресторани')).not.toBeInTheDocument();
  expect(within(dialog).queryByText('Продукти та супермаркети')).not.toBeInTheDocument();
});
it('restores a chosen range and filters on reopening while allowing an explicit deep link to override them', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = render(
    <QueryClientProvider client={client}>
      <FinanceAnalytics finance={finance} initialTab="expenses" onBack={() => {}} />
    </QueryClientProvider>,
  );
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  fireEvent.click(screen.getByRole('button', { name: '30 днів' }));
  fireEvent.change(screen.getByLabelText('Рахунки'), { target: { value: 'cash' } });
  await waitFor(() =>
    expect(fetchFinanceAnalytics).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: 'cash', from: '2026-09-15' }),
    ),
  );
  first.unmount();
  const reopened = render(
    <QueryClientProvider client={new QueryClient()}>
      <FinanceAnalytics finance={finance} restoreContext onBack={() => {}} />
    </QueryClientProvider>,
  );
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  expect(screen.getByLabelText('Рахунки')).toHaveValue('cash');
  expect(screen.getByRole('button', { name: '30 днів' })).toHaveAttribute('aria-pressed', 'true');
  reopened.unmount();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FinanceAnalytics
        finance={finance}
        restoreContext
        initialTab="expenses"
        initialRequest={{ from: '2026-10-01', to: '2026-10-07', account: 'all' }}
        onBack={() => {}}
      />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(fetchFinanceAnalytics).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: 'all', from: '2026-10-01', to: '2026-10-07' }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetFinanceDemo();
});
function open() {
  const back = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FinanceAnalytics finance={finance} initialTab="expenses" onBack={back} />
    </QueryClientProvider>,
  );
  return back;
}
it('shows personal spending without own transfers, drills into a category, and does not refresh the bank or write finance', async () => {
  open();
  const hero = await screen.findByRole('region', { name: 'Підсумок витрат' });
  expect(within(hero).getByLabelText('Сума особистих витрат')).toHaveTextContent('300,00 ₴');
  fireEvent.click(screen.getByRole('button', { name: /Кафе та ресторани.*100/ }));
  await screen.findByRole('dialog', { name: 'Операції у звіті' });
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'кафе й ресторани' }),
      expect.anything(),
    ),
  );
  expect(within(hero).getByLabelText('Сума особистих витрат')).toHaveTextContent('300,00 ₴');
  expect(refreshFinanceBank).not.toHaveBeenCalled();
  expect(postFinance).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Закрити операції' }));
  await waitFor(() =>
    expect(within(hero).getByLabelText('Сума особистих витрат')).toHaveTextContent('300,00 ₴'),
  );
});
it('applies a confirmed filter to totals and the operation explorer with identical parameters', async () => {
  open();
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  fireEvent.click(screen.getByRole('button', { name: 'Фільтри' }));
  fireEvent.change(screen.getByLabelText('Підтвердження'), { target: { value: 'confirmed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  await waitFor(() =>
    expect(
      within(screen.getByRole('region', { name: 'Підсумок витрат' })).getByLabelText(
        'Сума особистих витрат',
      ),
    ).toHaveTextContent('100,00 ₴'),
  );
  fireEvent.click(screen.getByRole('button', { name: /Переглянути операції/ }));
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed' }),
      expect.objectContaining({ kind: 'expense' }),
    ),
  );
  expect(refreshFinanceBank).not.toHaveBeenCalled();
});
it('selects a calendar day and opens only that day without closing or resetting the dashboard', async () => {
  open();
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  fireEvent.click(screen.getByRole('button', { name: 'Динаміка й календар' }));
  fireEvent.change(screen.getByLabelText('Обрати точку'), { target: { value: '2026-10-09' } });
  fireEvent.click(screen.getByRole('button', { name: 'Операції обраного проміжку' }));
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-10-08', to: '2026-10-14' }),
      expect.objectContaining({ day: '2026-10-09' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Закрити операції' }));
  expect(screen.getByRole('button', { name: 'Динаміка й календар' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByLabelText('Обрати точку')).toHaveValue('2026-10-09');
  fireEvent.click(screen.getByText('Календар витрат'));
  fireEvent.click(screen.getByLabelText(/2026-10-10: 200,00\s₴/));
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-10-08', to: '2026-10-14' }),
      expect.objectContaining({ day: '2026-10-10' }),
    ),
  );
});
it('validates custom dates before a request and distinguishes current account state from a historical period', async () => {
  open();
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  fireEvent.click(screen.getByRole('button', { name: 'Власні дати' }));
  fireEvent.change(screen.getByLabelText('Від'), { target: { value: '2026-10-14' } });
  fireEvent.change(screen.getByLabelText('До включно'), { target: { value: '2026-10-10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Показати' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Некорект/);
  expect(fetchFinanceAnalytics).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
  fireEvent.click(screen.getByRole('button', { name: 'Рахунки та звірка ↗' }));
  expect(screen.getByText(/Поточний стан на/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Власні дати' })).not.toBeInTheDocument();
  expect(screen.getByText('Кредитний ліміт')).toBeInTheDocument();
});
it('paginates operations and edits the existing bank category without requiring a missing hold checkbox', async () => {
  vi.mocked(fetchAnalyticsOperations)
    .mockResolvedValueOnce({
      ok: true,
      generatedAt: new Date(NOW).toISOString(),
      items: [finance.transactions[1]!],
      nextCursor: 'cursor',
    })
    .mockResolvedValueOnce({
      ok: true,
      generatedAt: new Date(NOW).toISOString(),
      items: [finance.transactions[0]!],
      nextCursor: null,
    });
  open();
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  fireEvent.click(screen.getByRole('button', { name: /Переглянути операції/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Показати ще 50' }));
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ cursor: 'cursor' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: /Маркет.*на обробці/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Уточнити категорію та тип' }));
  fireEvent.change(screen.getByLabelText('Категорія'), { target: { value: 'кафе й ресторани' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти тип і категорію' }));
  await waitFor(() =>
    expect(postFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'classify',
        payload: expect.objectContaining({ transactionId: 'food', category: 'кафе й ресторани' }),
      }),
    ),
  );
});
it('draws goal returns below zero instead of hiding negative values', () => {
  render(
    <AnalyticsBars
      points={[
        { key: 'a', label: 'Внесок', amountMinor: 10000 },
        { key: 'b', label: 'Повернення', amountMinor: -5000 },
      ]}
      label="Рух цілі"
    />,
  );
  const svg = screen.getByRole('img', { name: 'Рух цілі' });
  const rects = svg.querySelectorAll('rect');
  expect(Number(rects[1]?.getAttribute('height'))).toBeGreaterThan(0);
  expect(rects[1]?.getAttribute('fill')).toBe('var(--color-neg)');
});
it('opens the exact largest transaction and hides empty quality links', async () => {
  open();
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  const largest = screen.getByRole('heading', { name: 'Найбільша оплата' }).closest('section')!;
  fireEvent.click(within(largest).getByRole('button'));
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transactionId: 'food', kind: 'all' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Закрити операції' }));
  fireEvent.click(screen.getByText(/Якість і джерела даних/));
  expect(screen.queryByRole('button', { name: 'Без гривневої суми: 0' })).not.toBeInTheDocument();
});
it('drills cumulative and weekday graphs into the correct ranges rather than an unrelated operation', async () => {
  open();
  await screen.findByRole('region', { name: 'Підсумок витрат' });
  fireEvent.click(screen.getByRole('button', { name: 'Динаміка й календар' }));
  fireEvent.change(screen.getByLabelText('День накопиченої суми'), {
    target: { value: '2026-10-10' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Операції до обраного дня' }));
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-10-08', to: '2026-10-10' }),
      expect.anything(),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Закрити операції' }));
  fireEvent.change(screen.getByLabelText('День тижня'), { target: { value: '5' } });
  await waitFor(() =>
    expect(fetchAnalyticsOperations).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-10-08', to: '2026-10-14' }),
      expect.objectContaining({ weekday: '5' }),
    ),
  );
});
