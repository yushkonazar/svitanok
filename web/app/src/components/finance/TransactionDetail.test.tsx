import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransactionDetail } from './TransactionDetail.tsx';
import { postFinance } from '../../api/client.ts';
import { readFinanceDemo } from '../../api/finance-demo.ts';
vi.mock('../../api/client.ts', () => ({ postFinance: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function setup() {
  const transaction = {
    ...readFinanceDemo().transactions[0]!,
    id: 'bank-1',
    duplicateSuspected: true,
    attention: null,
  };
  const query = new QueryClient();
  const invalidate = vi.spyOn(query, 'invalidateQueries');
  render(
    <QueryClientProvider client={query}>
      <TransactionDetail
        transaction={transaction}
        version={7}
        onBack={vi.fn()}
        onClassify={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { invalidate };
}
it('writes a metadata command with the current version, disables repeat taps and refreshes the shared query', async () => {
  let complete!: () => void;
  vi.mocked(postFinance).mockImplementation(
    () =>
      new Promise<Awaited<ReturnType<typeof postFinance>>>((resolve) => {
        complete = () => resolve({ finance: readFinanceDemo(), demo: true });
      }),
  );
  const { invalidate } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Це різні покупки' }));
  expect(screen.getByRole('button', { name: 'Це різні покупки' })).toBeDisabled();
  expect(postFinance).toHaveBeenCalledTimes(1);
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      version: 7,
      type: 'transaction-attention',
      payload: { transactionId: 'bank-1', status: 'different' },
    }),
  );
  complete();
  await waitFor(() =>
    expect(
      screen.getByText('Позначено як різні покупки. Обидві операції залишились в обліку.'),
    ).toBeInTheDocument(),
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['finance'] });
});
it('shows failure honestly and keeps retry actions available', async () => {
  vi.mocked(postFinance).mockRejectedValue(new Error('Не вдалося зберегти відповідь.'));
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірю списання' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Не вдалося зберегти відповідь.'),
  );
  expect(screen.getByRole('button', { name: 'Перевірю списання' })).toBeEnabled();
  expect(
    screen.queryByText('Чекає твоєї перевірки. Списання не скасовано.'),
  ).not.toBeInTheDocument();
});
