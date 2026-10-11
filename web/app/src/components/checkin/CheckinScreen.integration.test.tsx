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

function open(target?: { date: string | null; slot: string | null }) {
  return render(
    <QueryClientProvider client={qc}>
      <CheckinV3Screen target={target} />
    </QueryClientProvider>,
  );
}

function windowSnapshot(extended = false) {
  const value = snapshot();
  return {
    ...value,
    receivedAtMs: Date.now(),
    stats: {
      ...value.stats,
      checkinServerTime: '2026-10-07T18:30:00.000Z', // 21:30 Kyiv
      checkinWindows: [
        {
          dateKey: '2026-10-07',
          slot: 'evening' as const,
          key: '1234abcd',
          startAt: '2026-10-07T17:00:00.000Z',
          baseEnd: '2026-10-07T23:00:00.000Z',
          endAt: extended ? '2026-10-08T00:00:00.000Z' : '2026-10-07T23:00:00.000Z',
          extended,
          open: true,
          extensionAvailable: !extended,
          gapIn: 0,
        },
      ],
    },
  };
}
it('extends the chosen slot once, with a pending state and a server-confirmed new deadline', async () => {
  api.fetchStats.mockResolvedValue(windowSnapshot());
  let resolve!: () => void;
  api.postEvent.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Ще годину' }));
  expect(await screen.findByRole('button', { name: 'Продовжую…' })).toBeDisabled();
  expect(api.postEvent).toHaveBeenCalledWith('checkin_extend', {
    dateKey: '2026-10-07',
    slot: 'evening',
    key: '1234abcd',
  });
  expect(screen.queryByText(/Продовжено один раз/)).not.toBeInTheDocument();
  api.fetchStats.mockResolvedValue(windowSnapshot(true));
  await act(async () => resolve());
  expect(await screen.findByText(/Продовжено один раз до 08.10.*03:00/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ще годину' })).not.toBeInTheDocument();
  expect(api.postEvent.mock.calls.every((call) => call[0] !== 'checkin')).toBe(true);
});
it('keeps a retry button and current deadline after extension fails', async () => {
  api.fetchStats.mockResolvedValue(windowSnapshot());
  api.postEvent.mockRejectedValue(new Error('Не вдалося продовжити чек-ін.'));
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Ще годину' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося продовжити чек-ін.');
  expect(screen.getByRole('button', { name: 'Ще годину' })).toBeEnabled();
  expect(screen.queryByText(/Продовжено один раз/)).not.toBeInTheDocument();
});
it('does not silently switch an expired deep link to another currently open slot', async () => {
  api.fetchStats.mockResolvedValue(windowSnapshot());
  open({ date: '2026-10-06', slot: 'evening' });
  expect(await screen.findByText(/Цей чек-ін уже закритий/)).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Як ти зараз?' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Вечір · 07.10' }));
  expect(await screen.findByRole('heading', { name: 'Як ти зараз?' })).toBeInTheDocument();
  expect(api.postEvent).not.toHaveBeenCalled();
});
it('switches explicitly between overlapping slots and keeps their drafts separate', async () => {
  const value = windowSnapshot();
  value.stats.checkinServerTime = '2026-10-07T17:30:00.000Z';
  const afternoon = {
    ...value.stats.checkinWindows[0]!,
    slot: 'afternoon' as const,
    startAt: '2026-10-07T11:00:00.000Z',
    baseEnd: '2026-10-07T17:00:00.000Z',
    endAt: '2026-10-07T18:00:00.000Z',
    extended: true,
    extensionAvailable: false,
  };
  api.fetchStats.mockResolvedValue({
    ...value,
    stats: { ...value.stats, checkinWindows: [afternoon, ...value.stats.checkinWindows] },
  });
  open({ date: '2026-10-07', slot: 'afternoon' });
  await screen.findByRole('heading', { name: 'Як ти зараз?' });
  fireEvent.click(screen.getByRole('button', { name: '4 · Радше хороший' }));
  fireEvent.click(screen.getByRole('button', { name: 'Вечір · 07.10' }));
  expect(screen.getByRole('button', { name: '3 · Нейтральний або змішаний' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'День · 07.10' }));
  expect(screen.getByRole('button', { name: '4 · Радше хороший' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await waitFor(() =>
    expect(api.postEvent).toHaveBeenCalledWith(
      'checkin',
      expect.objectContaining({
        dateKey: '2026-10-07',
        slot: 'afternoon',
        mood: 4,
      }),
    ),
  );
  expect(api.postEvent.mock.calls.every((call) => call[1]?.confirmed !== true)).toBe(true);
});
it('uses the original evening date for a draft after midnight rather than the new calendar day', async () => {
  const value = windowSnapshot(true);
  value.stats.checkinDate = '2026-10-08';
  value.stats.checkinServerTime = '2026-10-07T23:30:00.000Z';
  api.fetchStats.mockResolvedValue({
    ...value,
    stats: {
      ...value.stats,
      checkinToday: null,
      checkinRaw: {
        ...EMPTY_STATS.checkinRaw,
        records: {
          '2026-10-07': { evening: { questionVersion: 3, energy: 3, mood: 3, satisfactionV3: 3 } },
        },
      },
    },
  });
  open({ date: '2026-10-07', slot: 'evening' });
  fireEvent.click(await screen.findByRole('button', { name: '4 · Радше хороший' }));
  await waitFor(() => expect(api.postEvent).toHaveBeenCalled(), { timeout: 3000 });
  expect(api.postEvent).toHaveBeenCalledWith(
    'checkin',
    expect.objectContaining({ dateKey: '2026-10-07', slot: 'evening', mood: 4 }),
  );
  expect(
    qc.getQueryData<{ stats: { checkinToday: unknown } }>(['stats'])?.stats.checkinToday,
  ).toBeNull();
});

it('does not abandon an in-progress extended slot when the next slot opens', async () => {
  const value = windowSnapshot(true);
  const afternoon = {
    ...value.stats.checkinWindows[0]!,
    slot: 'afternoon' as const,
    startAt: '2026-10-07T11:00:00.000Z',
    baseEnd: '2026-10-07T17:00:00.000Z',
    endAt: '2026-10-07T18:00:00.000Z',
  };
  const data = {
    ...value,
    stats: {
      ...value.stats,
      checkinSlot: 'afternoon' as const,
      checkinServerTime: '2026-10-07T16:30:00.000Z',
      checkinToday: { afternoon: { questionVersion: 3, energy: 3, mood: 3 } },
      checkinWindows: [afternoon],
    },
  };
  api.fetchStats.mockResolvedValue(data);
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Далі →' }));
  expect(screen.getByRole('heading', { name: 'Твій контекст' })).toBeInTheDocument();
  await act(async () =>
    qc.setQueryData(['stats'], {
      ...data,
      stats: {
        ...data.stats,
        checkinSlot: 'evening',
        checkinServerTime: '2026-10-07T17:30:00.000Z',
        checkinWindows: [afternoon, value.stats.checkinWindows[0]],
      },
    }),
  );
  expect(screen.getByRole('button', { name: 'День · 07.10' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('heading', { name: 'Твій контекст' })).toBeInTheDocument();
});

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
