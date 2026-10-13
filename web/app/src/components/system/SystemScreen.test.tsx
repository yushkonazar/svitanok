import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SystemScreen } from './SystemScreen.tsx';
const mocks = vi.hoisted(() => ({ private: true, fetch: vi.fn() }));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => mocks.private }));
vi.mock('../../api/hooks.ts', () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock('../../api/client.ts', () => ({ fetchSystem: mocks.fetch }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
