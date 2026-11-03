import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStats } from '../api/hooks.ts';
import { EMPTY_STATS } from '../api/sample.ts';
import { useCheckinProgress } from './useCheckinProgress.ts';
import { useTick } from './useTick.ts';
const api = vi.hoisted(() => ({ fetchStats: vi.fn() }));
vi.mock('../api/client.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  fetchStats: api.fetchStats,
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('refreshes the shared server snapshot at a slot boundary without authorizing it on the phone', async () => {
  vi.useFakeTimers();
  const now = Date.parse('2026-11-03T12:59:59+02:00');
  vi.setSystemTime(now);
  const window = {
    dateKey: '2026-11-03',
    slot: 'morning' as const,
    key: '1234abcd',
    startAt: '2026-11-03T08:00:00+02:00',
    baseEnd: '2026-11-03T13:00:00+02:00',
    endAt: '2026-11-03T13:00:00+02:00',
    open: true,
    extended: false,
    extensionAvailable: true,
    gapIn: 0,
  };
  const initial = {
    stats: {
      ...EMPTY_STATS,
      checkinDate: '2026-11-03',
      checkinSlot: 'morning' as const,
      checkinWindows: [window],
      checkinServerTime: new Date(now).toISOString(),
    },
    demo: false,
    receivedAtMs: now,
  };
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  cache.setQueryData(['stats'], initial);
  api.fetchStats.mockImplementation(() =>
    Promise.resolve({
      ...initial,
      receivedAtMs: Date.now(),
      stats: {
        ...initial.stats,
        checkinSlot: null,
        checkinServerTime: new Date(Date.now()).toISOString(),
        checkinWindows: [{ ...window, open: false }],
      },
    }),
  );
  const { result, unmount } = renderHook(() => useCheckinProgress(useStats(), useTick(1000)), {
    wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>,
  });
  expect(result.current.progress?.items[0]!.state).toBe('open');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(api.fetchStats).toHaveBeenCalledTimes(1);
  expect(result.current.progress?.items[0]!.state).toBe('closed');
  unmount();
  cache.clear();
});
