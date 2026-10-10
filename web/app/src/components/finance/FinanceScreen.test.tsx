import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FinanceScreen } from './FinanceScreen.tsx';
import { readFinanceDemo } from '../../api/finance-demo.ts';
import { setVerticalSwipes } from '../../telegram.ts';
import { useFinance } from '../../api/finance-hooks.ts';
vi.mock('../../api/finance-hooks.ts', () => ({ FINANCE_QUERY: ['finance'], useFinance: vi.fn() }));
vi.mock('../../telegram.ts', async (original) => ({
  ...(await original<typeof import('../../telegram.ts')>()),
  setVerticalSwipes: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
