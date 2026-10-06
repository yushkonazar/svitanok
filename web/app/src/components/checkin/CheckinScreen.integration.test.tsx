import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CheckinV3Screen } from './CheckinV3Screen.tsx';
import { EMPTY_STATS } from '../../api/sample.ts';
import { SessionExpiredError } from '../../api/client.ts';

const api = vi.hoisted(() => ({
  fetchStats: vi.fn(),
  fetchSettings: vi.fn(),
  postEvent: vi.fn(),
  postSettings: vi.fn(),
}));
vi.mock('../../api/client.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));
vi.mock('../../telegram.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  inTelegram: () => true,
  haptic: vi.fn(),
  setVerticalSwipes: vi.fn(),
}));
let qc: QueryClient;
const snapshot = () => ({
  stats: {
    ...EMPTY_STATS,
    checkinDate: '2026-10-07',
    checkinSlot: 'evening' as const,
    checkinGapIn: 0,
    checkinSlotEndsIn: 120,
    checkinToday: { evening: { questionVersion: 3, energy: 3, mood: 3, satisfactionV3: 3 } },
  },
  demo: false,
});

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  api.fetchStats.mockResolvedValue(snapshot());
  api.fetchSettings.mockResolvedValue({
    settings: { modules: {}, mutedTopics: [], checkin: { version: 3 } },
    connectors: {},
  });
  api.postEvent.mockResolvedValue(undefined);
  api.postSettings.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  qc.clear();
  sessionStorage.clear();
});

function open() {
  return render(
    <QueryClientProvider client={qc}>
      <CheckinV3Screen />
    </QueryClientProvider>,
  );
}

it('never closes an available evening flow when the cache timestamp leads the ticking clock', async () => {
  // Like an optimistic write just after the last one-second useTick update.
  qc.setQueryData(['stats'], snapshot(), { updatedAt: Date.now() + 10_000 });
  const view = open();
  await screen.findByRole('heading', { name: 'Як ти зараз?' });
  expect(screen.queryByText('Дай дню трохи часу')).not.toBeInTheDocument();
  expect(screen.getByText('Чернетка · ще 120 хв')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  const card = view.container.querySelector('.checkin-adaptive-card');
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      qc.setQueryData(['stats'], snapshot(), { updatedAt: Date.now() + 10_000 });
    });
    fireEvent.scroll(window, { target: { scrollY: 500 + i * 100 } });
    expect(screen.getByRole('heading', { name: 'Твій контекст' })).toBeInTheDocument();
    expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
  }
});

it('does not restart the server countdown when an optimistic cache write changes dataUpdatedAt', async () => {
  const data = { ...snapshot(), receivedAtMs: Date.now() - 5 * 60_000 };
  data.stats.checkinGapIn = 10;
  qc.setQueryData(['stats'], data);
  open();
  await screen.findByText(/Рекомендований наступний запис — через 5 хв/);
  await act(async () => {
    qc.setQueryData(['stats'], { ...data });
  });
  expect(screen.getByText(/Рекомендований наступний запис — через 5 хв/)).toBeInTheDocument();
  expect(screen.getByText('Чернетка · ще 115 хв')).toBeInTheDocument();
});

it('keeps the second evening block through repeated successful answer autosaves', async () => {
  const view = open();
  await screen.findByRole('heading', { name: 'Як ти зараз?' });
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  fireEvent.click(screen.getByText('Справи й розвиток'));
  const work = screen.getByRole('button', { name: 'Робота' });
  const group = work.closest('details')!;
  const card = view.container.querySelector('.checkin-adaptive-card');
  for (let i = 1; i <= 2; i++) {
    fireEvent.click(work, { detail: 1 });
    fireEvent.scroll(window, { target: { scrollY: 600 } });
    await waitFor(() => expect(api.postEvent).toHaveBeenCalledTimes(i), { timeout: 3000 });
    await waitFor(() => expect(qc.isFetching({ queryKey: ['stats'] })).toBe(0));
    expect(screen.getByRole('heading', { name: 'Твій контекст' })).toBeInTheDocument();
    expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
    expect(group).toHaveAttribute('open');
    expect(work).toHaveAttribute('aria-pressed', i === 1 ? 'true' : 'false');
  }
});

it('keeps the evening stage mounted when the real autosave refetch fails and recovers', async () => {
  const view = open();
  await screen.findByRole('heading', { name: 'Як ти зараз?' });
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  fireEvent.click(screen.getByText('Справи й розвиток'));
  const work = screen.getByRole('button', { name: 'Робота' });
  const card = view.container.querySelector('.checkin-adaptive-card');
  const group = work.closest('details')!;
  api.fetchStats.mockRejectedValue(new Error('Тимчасовий збій оновлення'));
  fireEvent.click(work, { detail: 1 });
  await waitFor(() => expect(api.postEvent).toHaveBeenCalled(), { timeout: 3000 });
  await waitFor(() => expect(qc.getQueryState(['stats'])?.status).toBe('error'));
  expect(screen.getByRole('heading', { name: 'Твій контекст' })).toBeInTheDocument();
  expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
  expect(group).toHaveAttribute('open');
  expect(work).toHaveAttribute('aria-pressed', 'true');
  api.fetchStats.mockResolvedValue(snapshot());
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['stats'] });
  });
  expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
  expect(group).toHaveAttribute('open');
  expect(work).toHaveAttribute('aria-pressed', 'true');
});

it('keeps the active stage when a background settings refresh fails', async () => {
  const view = open();
  await screen.findByRole('heading', { name: 'Як ти зараз?' });
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  const card = view.container.querySelector('.checkin-adaptive-card');
  api.fetchSettings.mockRejectedValue(new Error('Налаштування тимчасово недоступні'));
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['settings'] });
  });
  expect(screen.getByRole('heading', { name: 'Твій контекст' })).toBeInTheDocument();
  expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
});

it('still blocks private check-in data when the session expires during refresh', async () => {
  open();
  await screen.findByRole('heading', { name: 'Як ти зараз?' });
  api.fetchStats.mockRejectedValue(new SessionExpiredError(401));
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['stats'] });
  });
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Як ти зараз?' })).not.toBeInTheDocument(),
  );
});
