import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FinanceForm, type FinanceFormRequest } from './FinanceForm.tsx';
import { postFinance } from '../../api/client.ts';
import { readFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';

vi.mock('../../api/client.ts', () => ({ postFinance: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../telegram.ts', () => ({ haptic: vi.fn() }));
beforeEach(() => {
  resetFinanceDemo();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetFinanceDemo();
});
function open(request: FinanceFormRequest) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <FinanceForm request={request} finance={readFinanceDemo()} onClose={close} />
    </QueryClientProvider>,
  );
  return { invalidate, close };
}
it('submits the complete credit limit, not spent credit, and refreshes all finance readers', async () => {
  const { invalidate, close } = open({ kind: 'credit-limit', id: 'mono:demo' });
  fireEvent.change(screen.getByLabelText('Як визначати ліміт'), { target: { value: 'manual' } });
  fireEvent.change(screen.getByLabelText('Повний кредитний ліміт, ₴'), {
    target: { value: '7 000,00' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'credit-limit',
      payload: { accountId: 'mono:demo', creditLimitMinor: 700000 },
    }),
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: FINANCE_QUERY });
});
it('records the bank installment schedule with the selectable purchase-in-parts category', async () => {
  const { close } = open({ kind: 'payment' });
  fireEvent.change(screen.getByLabelText('Тип'), { target: { value: 'installment' } });
  const values = {
    'Назва платежу': 'Proove',
    'Сума одного платежу, ₴': '90,70',
    'Ще залишилось сплатити, ₴': '1088,40',
    'Кількість платежів': '12',
    'Початкова сума боргу, ₴': '1814',
    'Наступна дата списання': '2026-10-09',
    'Фіксований день списання (1–31)': '9',
    Категорія: 'покупка частинами',
  };
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  expect(screen.getByRole('option', { name: 'Покупка частинами' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Комуналка та інтернет' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'payment',
      payload: expect.objectContaining({
        amountMinor: 9070,
        remainingMinor: 108840,
        totalMinor: 181400,
        installmentsLeft: 12,
        nextDate: '2026-10-09',
        anchorDay: 9,
        category: 'покупка частинами',
      }),
    }),
  );
});
it('displays the bank label without changing the historical grocery category value', async () => {
  const { close } = open({ kind: 'expense' });
  expect(screen.getByRole('option', { name: 'Продукти та супермаркети' })).toHaveValue('продукти');
  fireEvent.change(screen.getByLabelText('Сума, ₴'), { target: { value: '20' } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ category: 'продукти' }) }),
  );
});
it('records a quick personal cash income as a separate command, without any shift totals', async () => {
  const { close } = open({ kind: 'taxi-personal' });
  fireEvent.change(screen.getByLabelText('Що сталося'), { target: { value: 'cash-tip' } });
  fireEvent.change(screen.getByLabelText('Скільки отримав особисто, ₴'), {
    target: { value: '25,50' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'taxi-personal-income',
      payload: expect.objectContaining({
        personalType: 'cash-tip',
        amountMinor: 2550,
        accountId: 'cash',
      }),
    }),
  );
  expect(vi.mocked(postFinance).mock.calls[0][0].payload).not.toHaveProperty('netCashMinor');
});
it('uses the supplied historical date for a shift and keeps cash tips out of its inputs', async () => {
  const { close } = open({ kind: 'taxi' });
  fireEvent.change(screen.getByLabelText('Дата запису'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('Час · Київ'), { target: { value: '22:30' } });
  fireEvent.change(screen.getByLabelText('Каса після комісії, ₴'), { target: { value: '4000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'taxi-entry',
      payload: expect.objectContaining({
        at: '2026-10-01T19:30:00.000Z',
        netCashMinor: 400000,
        directMinor: 0,
      }),
    }),
  );
});
