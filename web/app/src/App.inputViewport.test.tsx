import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { changeTrip } from './api/trips.ts';

vi.mock('./api/hooks.ts', () => ({
  useBriefing: () => ({}),
  useStats: () => ({}),
}));
vi.mock('./api/finance-hooks.ts', () => ({ useFinance: () => ({}) }));
vi.mock('./api/client.ts', async (original) => ({
  ...(await original<typeof import('./api/client.ts')>()),
  postEvent: vi.fn().mockResolvedValue({}),
}));
vi.mock('./telegram.ts', () => ({
  tg: null,
  inTelegram: () => false,
  haptic: vi.fn(),
  startParam: () => undefined,
  setBackButton: () => () => {},
}));
vi.mock('./api/trips.ts', async (original) => ({
  ...(await original<typeof import('./api/trips.ts')>()),
  fetchTrips: vi.fn().mockResolvedValue({ ok: true, items: [], current: null }),
  changeTrip: vi.fn().mockResolvedValue({ ok: true, items: [], current: null }),
}));

let visual: EventTarget & { height: number; offsetTop: number; scale: number };
beforeEach(() => {
  visual = Object.assign(new EventTarget(), { height: 780, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', visual);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  vi.stubGlobal('innerHeight', 780);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(780);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  vi.mocked(changeTrip).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the actual travel destination form mounted while keyboard layout changes, then submits its draft once', async () => {
  const user = userEvent.setup();
  const cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <MemoryRouter initialEntries={['/trips']}>
      <QueryClientProvider client={cache}>
        <App />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const input = await screen.findByLabelText('Місто або місце');
  await user.type(input, 'Прага');
  await waitFor(() =>
    expect(screen.getByRole('navigation', { hidden: true })).toHaveAttribute('hidden'),
  );
  visual.height = 360;
  act(() => visual.dispatchEvent(new Event('resize')));
  await waitFor(() =>
    expect(screen.getByRole('main').style.paddingBottom).toBe(
      'calc(444px + env(safe-area-inset-bottom))',
    ),
  );
  expect(screen.getByLabelText('Місто або місце')).toBe(input);
  expect(input).toHaveValue('Прага');
  expect(changeTrip).not.toHaveBeenCalled();
  visual.height = 780;
  act(() => visual.dispatchEvent(new Event('resize')));
  await waitFor(() => expect(screen.getByRole('navigation')).not.toHaveAttribute('hidden'));
  expect(screen.getByRole('main').style.paddingBottom).toBe('');
  expect(input).toHaveValue('Прага');
  await user.click(screen.getByRole('button', { name: 'Почати планування →' }));
  expect(changeTrip).toHaveBeenCalledExactlyOnceWith({ op: 'brief', data: { to: 'Прага' } });
});
