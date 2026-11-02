import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CurrencyBlock, currencyChange } from './CurrencyBlock.tsx';
import { fetchCurrencyHistory } from '../../api/client.ts';
import type { CurrencyData } from '../../api/briefing-schema.ts';
vi.mock('../../api/client.ts', () => ({ fetchCurrencyHistory: vi.fn() }));
const data: CurrencyData = {
  catalog: [
    { code: 'USD', name: 'Долар', rate: 40, asOf: '2026-11-02' },
    { code: 'EUR', name: 'Євро', rate: 45, asOf: '2026-11-02' },
  ],
  observations: [
    { date: '2026-11-01', rates: { USD: 39, EUR: 44 } },
    { date: '2026-11-02', rates: { USD: 40, EUR: 45 } },
  ],
};
const show = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CurrencyBlock d={data} date="2026-11-02" />
    </QueryClientProvider>,
  );
beforeEach(() => {
  for (const key of ['localStorage', 'sessionStorage']) {
    const entries = new Map<string, string>();
    vi.stubGlobal(key, {
      getItem: (name: string) => entries.get(name) ?? null,
      setItem: (name: string, value: string) => entries.set(name, value),
      removeItem: (name: string) => entries.delete(name),
      clear: () => entries.clear(),
    });
  }
  vi.mocked(fetchCurrencyHistory).mockResolvedValue([
    { date: '2026-11-01', value: 44 },
    { date: '2026-11-02', value: 45 },
  ]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it('shares the selected card, converter and history without forcing a chart open', async () => {
  const view = show();
  fireEvent.click(screen.getByRole('button', { name: /Євро/ }));
  expect(screen.queryByLabelText('Дата: Курс EUR')).not.toBeInTheDocument();
  expect(fetchCurrencyHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Конвертер валют' }));
  expect(screen.getByLabelText('З')).toHaveValue('EUR');
  fireEvent.change(screen.getByLabelText('Сума'), { target: { value: '1 234,56' } });
  expect(screen.getByRole('status')).toHaveTextContent('55 555,20');
  fireEvent.change(screen.getByLabelText('З'), { target: { value: 'USD' } });
  expect(screen.getByRole('button', { name: /Долар/ })).toHaveAttribute('aria-pressed', 'true');
  view.unmount();
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Конвертер валют' }));
  expect(screen.getByLabelText('Сума')).toHaveValue('1 234,56');
  expect(screen.getByLabelText('З')).toHaveValue('USD');
  fireEvent.click(screen.getByRole('button', { name: 'Історія USD' }));
  expect(await screen.findByLabelText('Дата: Курс USD')).toBeInTheDocument();
  expect(screen.queryByText(/усі доступні дати|30 дат/)).not.toBeInTheDocument();
});
it('keeps missing comparisons honest and labels gaps by date', () => {
  expect(currencyChange(data, 'USD', 40, '2026-11-02')?.label).toBe('до вчора');
  expect(currencyChange(data, 'USD', 40, '2026-11-04')?.label).not.toBe('до вчора');
  expect(currencyChange(data, 'GBP', 50, '2026-11-02')).toBeNull();
});
