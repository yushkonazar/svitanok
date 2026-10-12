import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeisureScreen } from './LeisureScreen.tsx';
import {
  fetchLeisure,
  fromKyivInput,
  leisureWorkspaceSchema,
  toKyivInput,
} from '../../api/leisure.ts';

vi.mock('../../telegram.ts', () => ({
  inTelegram: () => false,
  tg: null,
  openLink: vi.fn(),
  haptic: vi.fn(),
  setVerticalSwipes: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const data = await fetchLeisure();
  cache.setQueryData(['leisure'], data);
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <LeisureScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { cache, data };
}
describe('leisure mobile interactions', () => {
  it('uses reservation confirmation for a restaurant without asking about tickets', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Заклади' }));
    fireEvent.click(screen.getAllByRole('button', { name: /Деталі/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Додати до плану вечора' }));
    expect(screen.getByLabelText('Бронювання підтверджено')).toBeInTheDocument();
    expect(screen.queryByLabelText('Квитки / реєстрацію підтверджено')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Початок')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Завершення')).toHaveAttribute('type', 'datetime-local');
  });
  it('requires fresh calendar approval after changing the composition of a plan', async () => {
    const { data } = await setup();
    fireEvent.click(screen.getAllByRole('button', { name: /Деталі/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Додати до плану вечора' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити календар' }));
    const approval = await screen.findByLabelText(/Погоджую збереження без перевірки накладок/);
    fireEvent.click(approval);
    expect(approval).toBeChecked();
    fireEvent.change(screen.getByLabelText('Додати місце або подію'), {
      target: { value: data.items.find((i) => i.category === 'food')!.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Додати пункт' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити календар' }));
    expect(
      await screen.findByLabelText(/Погоджую збереження без перевірки накладок/),
    ).not.toBeChecked();
  });
  it('discards a calendar response for an older time when inputs change during the request', async () => {
    await setup();
    fireEvent.click(screen.getAllByRole('button', { name: /Деталі/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Додати до плану вечора' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити календар' }));
    fireEvent.change(screen.getByLabelText('Початок'), { target: { value: '2026-10-15T19:00' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      screen.queryByLabelText(/Погоджую збереження без перевірки накладок/),
    ).not.toBeInTheDocument();
  });
  it('keeps unsaved form edits when the shared workspace refetches', async () => {
    const { cache, data } = await setup();
    fireEvent.click(screen.getAllByRole('button', { name: /Деталі/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Додати до плану вечора' }));
    const input = screen.getByLabelText('Назва');
    fireEvent.change(input, { target: { value: 'Наше побачення' } });
    await act(async () => {
      cache.setQueryData(['leisure'], { ...data, generatedAt: new Date().toISOString() });
    });
    expect(screen.getByLabelText('Назва')).toHaveValue('Наше побачення');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('does not publish an invented cinema session in demo mode', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Кіно' }));
    fireEvent.click(screen.getAllByRole('button', { name: /Деталі/ })[0]!);
    expect(
      within(screen.getByRole('dialog')).queryByRole('button', { name: 'Запланувати' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/На цей вибір сеансів не підтверджено/)).toBeInTheDocument();
  });
  it('records an unknown-date visit and permits another visit to the same venue', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Заклади' }));
    fireEvent.click(screen.getAllByRole('button', { name: /Деталі/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Вже були / були знову' }));
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти відвідування' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Ваші місця' }));
    expect(screen.getByText('Минула дата невідома · Без оцінки')).toBeInTheDocument();
  });
  it('handles dates in Kyiv and rejects nonexistent daylight-saving times', () => {
    expect(fromKyivInput('2026-10-12T18:00')).toBe('2026-10-12T15:00:00.000Z');
    expect(toKyivInput('2026-10-11T22:30:00Z')).toBe('2026-10-12T01:30');
    expect(() => fromKyivInput('2026-03-29T03:30')).toThrow('не існує');
  });
  it('validates the actual demo payload against the same schema as production', async () => {
    expect(leisureWorkspaceSchema.safeParse(await fetchLeisure()).success).toBe(true);
  });
});
