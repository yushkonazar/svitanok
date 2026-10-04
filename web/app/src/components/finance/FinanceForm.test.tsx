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
it('fills payment, total and overpayment from the selected annual rate, amount and term', async () => {
  const { close } = open({ kind: 'payment' });
  fireEvent.change(screen.getByLabelText('Тип'), { target: { value: 'loan' } });
  for (const [label, value] of Object.entries({
    'Назва платежу': 'Автопідрахунок',
    'Початкова сума боргу, ₴': '1 200,00',
    'Річна ставка, %': '12',
    'Термін кредиту, місяців': '12',
  }))
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  expect(screen.getByLabelText('Розрахований найближчий платіж, ₴')).toHaveValue('106,62');
  expect(screen.getByLabelText('Розраховано всього до сплати, ₴')).toHaveValue('1279,42');
  fireEvent.change(screen.getByLabelText('Як нараховуються відсотки'), {
    target: { value: 'flat' },
  });
  expect(screen.getByLabelText('Розрахована переплата, ₴')).toHaveValue('144,00');
  fireEvent.change(screen.getByLabelText('Річна ставка, %'), { target: { value: '24' } });
  expect(screen.getByLabelText('Розрахований найближчий платіж, ₴')).toHaveValue('124,00');
  expect(screen.getByLabelText('Розраховано всього до сплати, ₴')).toHaveValue('1488,00');
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'payment',
      payload: expect.objectContaining({
        interestMethod: 'flat',
        rateBps: 2400,
        totalMinor: 120000,
        remainingMinor: 120000,
        installmentsLeft: 12,
        termMonths: 12,
        amountMinor: 12400,
      }),
    }),
  );
});
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
  fireEvent.change(screen.getByLabelText('Як визначити залишок боргу'), {
    target: { value: 'manual' },
  });
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
it('calculates the new card installment balance and permits an exact bank override', async () => {
  const { close } = open({ kind: 'payment' });
  fireEvent.change(screen.getByLabelText('Тип'), { target: { value: 'card-installment' } });
  fireEvent.change(screen.getByLabelText('Як додати борг'), { target: { value: 'schedule' } });
  fireEvent.change(screen.getByLabelText('Назва платежу'), {
    target: { value: 'Розстрочка Mono' },
  });
  fireEvent.change(screen.getByLabelText('Сума одного платежу, ₴'), { target: { value: '50,25' } });
  fireEvent.change(screen.getByLabelText('Кількість платежів'), { target: { value: '12' } });
  expect(screen.getByLabelText('Ще залишилось сплатити, ₴')).toHaveValue('603');
  expect(screen.getByLabelText('Ще залишилось сплатити, ₴')).toHaveAttribute('readonly');
  fireEvent.change(screen.getByLabelText('Кількість платежів'), { target: { value: '10' } });
  expect(screen.getByLabelText('Ще залишилось сплатити, ₴')).toHaveValue('502.5');
  fireEvent.change(screen.getByLabelText('Як визначити залишок боргу'), {
    target: { value: 'manual' },
  });
  fireEvent.change(screen.getByLabelText('Ще залишилось сплатити, ₴'), {
    target: { value: '502,48' },
  });
  fireEvent.change(screen.getByLabelText('Наступна дата списання'), {
    target: { value: '2026-10-09' },
  });
  expect(screen.getByLabelText('Фіксований день списання (1–31)')).toHaveValue('9');
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'payment',
      payload: expect.objectContaining({
        kind: 'card-installment',
        amountMinor: 5025,
        remainingMinor: 50248,
        installmentsLeft: 10,
        anchorDay: 9,
        category: 'розстрочка',
      }),
    }),
  );
});
it('creates the 550 purchase plus 125 total surcharge with a 56.25 monthly payment', async () => {
  const { close } = open({ kind: 'payment' });
  fireEvent.change(screen.getByLabelText('Тип'), { target: { value: 'card-installment' } });
  fireEvent.change(screen.getByLabelText('Назва платежу'), { target: { value: 'Розстрочка 550' } });
  fireEvent.change(screen.getByLabelText('Сума покупки / отриманого кредиту, ₴'), {
    target: { value: '550' },
  });
  fireEvent.change(screen.getByLabelText('Загальна переплата за весь термін, ₴'), {
    target: { value: '125' },
  });
  fireEvent.change(screen.getByLabelText('Термін розстрочки, місяців'), {
    target: { value: '12' },
  });
  expect(screen.getByText(/56,25.*місяць/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'payment',
      payload: expect.objectContaining({
        amountMinor: 5625,
        totalMinor: 55000,
        remainingMinor: 55000,
        overpaymentTotalMinor: 12500,
        overpaymentRemainingMinor: 12500,
        termMonths: 12,
        installmentsLeft: 12,
        rateBps: 0,
        feeMinor: 0,
      }),
    }),
  );
});
it('requires bank principal for an interest-bearing loan instead of estimating it', async () => {
  open({ kind: 'payment' });
  fireEvent.change(screen.getByLabelText('Тип'), { target: { value: 'loan' } });
  fireEvent.change(screen.getByLabelText('Як додати борг'), { target: { value: 'schedule' } });
  fireEvent.change(screen.getByLabelText('Назва платежу'), { target: { value: 'Кредит' } });
  fireEvent.change(screen.getByLabelText('Сума одного платежу, ₴'), { target: { value: '50' } });
  fireEvent.change(screen.getByLabelText('Кількість платежів'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Річна ставка, %'), { target: { value: '24' } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('точний залишок');
  expect(postFinance).not.toHaveBeenCalled();
});
it('confirms an early payoff with the entire principal in one payment command', async () => {
  const payment = readFinanceDemo().payments.find((p) => p.kind === 'installment')!;
  const { close } = open({ kind: 'payment-close', id: payment.id });
  expect(screen.getByLabelText('Погашення тіла боргу, ₴')).toHaveValue(
    String(payment.remainingMinor! / 100),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'payment-paid',
      payload: expect.objectContaining({
        paymentId: payment.id,
        principalMinor: payment.remainingMinor,
        amountMinor: payment.remainingMinor! + (payment.feeMinor ?? 0),
        close: true,
      }),
    }),
  );
});
it('cancels a subscription with no payment amount or account debit', async () => {
  const payment = readFinanceDemo().payments.find((p) => p.kind === 'subscription')!;
  const { close } = open({ kind: 'payment-cancel', id: payment.id });
  expect(screen.getByText(/не відключає підписку/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'payment-cancel', payload: { paymentId: payment.id } }),
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
