import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SystemScreen } from './SystemScreen.tsx';
const mocks = vi.hoisted(() => ({ private: true, fetch: vi.fn(), post: vi.fn() }));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => mocks.private }));
vi.mock('../../api/hooks.ts', () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock('../../api/client.ts', () => ({ fetchSystem: mocks.fetch, postSystem: mocks.post }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function snapshot() {
  return {
    generatedAt: '2026-10-13T08:00:00Z',
    period: '2026-10',
    mode: 'on',
    scheduler: { available: true, data: { scheduled: 2, lastTick: null } },
    registry: { available: true, data: { active: 0 } },
    delivery: { available: false, data: null },
    runs: {
      available: true,
      data: {
        summary: { total: 0, active: 0, failed: 0, completed: 0 },
        worker_quality: [],
        recent: [],
        nextCursor: null,
      },
    },
    models: { available: true, data: { items: [] } },
    quotas: { available: true, data: [] },
    billing: { connected: false, balance: null, items: [] },
    preferences: {
      available: true,
      data: { revision: 0, budgets: { overallUsd: null, features: {} } },
    },
    services: { available: true, data: [] },
  };
}
it('labels degraded/unready models and uses the selected range for all queries', async () => {
  mocks.private = true;
  mocks.fetch.mockResolvedValue({
    ...snapshot(),
    brain: { available: true, data: { state: 'ok', modelState: 'unready', checkedAtMs: null } },
  });
  open();
  await screen.findByText('Готовність моделі');
  fireEvent.click(screen.getByRole('button', { name: 'Функції' }));
  expect(screen.getByText('Модель не готова')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '7 днів' }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenLastCalledWith({ range: '7d' }, false));
  expect(mocks.post).not.toHaveBeenCalled();
});
it('refreshes metadata visibly with a cache bypass and retains the page on a failed refresh', async () => {
  mocks.private = true;
  mocks.fetch.mockResolvedValue(snapshot());
  open();
  await screen.findByText('Потребує уваги');
  let reject: (error: Error) => void = () => {};
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
  await screen.findByRole('button', { name: 'Оновлюю…' });
  expect(mocks.fetch).toHaveBeenLastCalledWith({ range: 'month' }, true);
  reject(new Error('Тестовий збій читання'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Попередній огляд залишено на екрані');
  expect(screen.getByText('Потребує уваги')).toBeInTheDocument();
});
it('calls billing only after the explicit button, never on opening the costs tab', async () => {
  mocks.private = true;
  mocks.fetch.mockResolvedValue({
    ...snapshot(),
    billing: {
      connected: false,
      balance: null,
      items: [
        {
          provider: 'openai',
          title: 'OpenAI',
          configured: true,
          supported: true,
          snapshot: null,
          errorClass: null,
          steps: [],
          url: 'https://developers.openai.com',
        },
      ],
    },
  });
  mocks.post.mockResolvedValue({ ok: true });
  open();
  await screen.findByText('Потребує уваги');
  fireEvent.click(screen.getByRole('button', { name: 'Витрати API' }));
  expect(mocks.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Оновити рахунок' }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      { action: 'billing-refresh', provider: 'openai' },
      { range: 'month' },
    ),
  );
  await waitFor(() => expect(mocks.fetch).toHaveBeenLastCalledWith({ range: 'month' }, true));
});
it('shows budget conflicts without losing the entered amount or enabling enforcement', async () => {
  mocks.private = true;
  mocks.fetch.mockResolvedValue(snapshot());
  mocks.post.mockRejectedValue(new Error('Налаштування вже змінено.'));
  open();
  await screen.findByText('Потребує уваги');
  fireEvent.click(screen.getByRole('button', { name: 'Керування' }));
  fireEvent.change(screen.getByLabelText('Загалом на місяць, USD'), { target: { value: '12,5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти орієнтири' }));
  await screen.findByText('Налаштування вже змінено.');
  expect(screen.getByLabelText('Загалом на місяць, USD')).toHaveValue('12,5');
  expect(mocks.post).toHaveBeenCalledWith({
    action: 'budgets',
    revision: 0,
    budgets: { overallUsd: 12.5, features: {} },
  });
});
function open() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <SystemScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it('does not load private telemetry outside Telegram', () => {
  mocks.private = false;
  open();
  expect(screen.getByText('Приватна панель')).toBeInTheDocument();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('shows unavailable sections and unknown costs without fabricating zero balances', async () => {
  mocks.private = true;
  mocks.fetch.mockResolvedValue({
    generatedAt: '2026-10-13T08:00:00Z',
    period: '2026-10',
    mode: 'on',
    scheduler: { available: false, data: null },
    registry: { available: false, data: null },
    delivery: { available: false, data: null },
    runs: { available: true, data: { worker_quality: [], recent: [] } },
    models: {
      available: true,
      data: {
        items: [
          {
            model: 'openai:example',
            calls: 3,
            knownCostCalls: 0,
            knownUsageCalls: 0,
            costUsd: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      },
    },
    quotas: { available: true, data: [] },
  });
  open();
  await screen.findByText('Стан планувальника зараз недоступний.');
  fireEvent.click(screen.getByRole('button', { name: 'Витрати API' }));
  expect(screen.getByText('Невідомо')).toBeInTheDocument();
  expect(screen.getByText(/Вартість відома для 0 із 3/)).toBeInTheDocument();
  expect(screen.queryByText('$0.0000')).not.toBeInTheDocument();
});
