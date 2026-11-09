import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CheckinV3Screen } from './CheckinV3Screen.tsx';
import { EMPTY_STATS } from '../../api/sample.ts';
import { SessionExpiredError } from '../../api/client.ts';
import { setVerticalSwipes } from '../../telegram.ts';
import { CHECKIN_FLOW_REVISION } from '../../../../core/checkin/state-ratings.mjs';

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
const answeredState = {
  questionVersion: 4,
  flowRevisionV4: CHECKIN_FLOW_REVISION,
  energyLevelV4: 5,
  energyHelpersV4: ['unknown'],
  moodLevelV4: 5,
  moodFactorsV4: ['none'],
};
const snapshot = () => ({
  stats: {
    ...EMPTY_STATS,
    checkinDate: '2026-10-07',
    checkinSlot: 'evening' as const,
    checkinGapIn: 0,
    checkinSlotEndsIn: 120,
    checkinToday: { evening: { ...answeredState, satisfactionV4: 3 } },
  },
  demo: false,
});

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open(target?: { date: string | null; slot: string | null }) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CheckinV3Screen target={target} />
      </MemoryRouter>
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
async function readyToConfirm(slot: 'afternoon' | 'evening' = 'evening') {
  const initial = snapshot();
  const answers = {
    ...answeredState,
    ...(slot === 'afternoon'
      ? { activitiesV4: ['none'], companyV4: ['alone'], priorityPaceV4: 'later' }
      : {
          satisfactionV4: 3,
          activitiesV4: ['rest'],
          companyV4: ['alone'],
          workedTodayV4: 'no',
          homeArrivalStatusV4: 'home',
          recoveryTargetV4: 'unknown',
          priorityOutcomeV4: 'noplan',
          developmentActualV4: ['none'],
          freeTimeV4: '1_29',
          freeTimeEnoughV4: 2,
          bedtimePlanStatusV4: 'unknown',
          napV4: 'no',
        }),
  };
  const data = {
    ...initial,
    stats: { ...initial.stats, checkinSlot: slot, checkinToday: { [slot]: answers } },
  };
  qc.setQueryData(['stats'], data);
  api.fetchStats.mockResolvedValue(data);
  const view = open();
  await screen.findByRole('button', { name: 'Підтвердити чек-ін' });
  return { view, data, button: screen.getByRole('button', { name: 'Підтвердити чек-ін' }) };
}
it.each([
  { slot: 'afternoon', reduced: false, name: 'День', offset: -52, moves: 2 },
  { slot: 'evening', reduced: false, name: 'Вечір', offset: -104, moves: 3 },
  { slot: 'evening', reduced: true, name: 'Вечір', offset: 0, moves: 0 },
] as const)(
  'closes a confirmed $slot check-in before reordering (reduced motion: $reduced)',
  async ({ slot, reduced, name, offset, moves }) => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(1600);
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(5000);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const siblings = Array.from(
        this.parentElement?.querySelectorAll('[data-checkin-slot]') ?? [],
      );
      const top = -1400 + Math.max(0, siblings.indexOf(this)) * 52;
      const height = this.dataset.checkinSlot
        ? parseFloat(this.style.minHeight) ||
          (this.dataset.checkinSlot === slot && !this.querySelector('summary') ? 1800 : 52)
        : 28;
      return { top, height } as DOMRect;
    });
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    const frames = new Map<number, FrameRequestCallback>();
    let lastFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++lastFrame, callback);
      return lastFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const advance = (time: number) => {
      const pending = [...frames.values()];
      frames.clear();
      act(() => pending.forEach((callback) => callback(time)));
    };
    let resolve!: () => void;
    api.postEvent.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { view, data, button } = await readyToConfirm(slot);
    const list = view.container.querySelector<HTMLElement>('.checkin-slot-list')!;
    list.style.scrollMarginTop = '20px';
    const sections = () => Array.from(list.querySelectorAll<HTMLElement>('[data-checkin-slot]'));
    const order = () => sections().map((row) => row.dataset.checkinSlot);
    const section = sections()[0]!;
    expect(section).toHaveAttribute('data-checkin-slot', slot);
    let resolveMoves!: () => void;
    const finished = new Promise<void>((done) => {
      resolveMoves = done;
    });
    const animate = vi.fn((_keyframes: Keyframe[]) => ({ finished, cancel: vi.fn() }));
    for (const row of sections()) Object.defineProperty(row, 'animate', { value: animate });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Зберігаю…' });
    expect(within(section).getByText('Зберігається')).toBeVisible();
    expect(within(section).queryByText('Підтверджено')).not.toBeInTheDocument();
    expect(section).toHaveStyle({ minHeight: '1800px' });
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(scroll).not.toHaveBeenCalled();
    api.fetchStats.mockResolvedValue({
      ...data,
      stats: {
        ...data.stats,
        checkinToday: { [slot]: { ...data.stats.checkinToday[slot], confirmed: true } },
      },
    });
    await act(async () => resolve());
    if (!reduced) {
      expect(await screen.findByText('Чек-ін збережено')).toBeInTheDocument();
      expect(section).toHaveStyle({ minHeight: '1800px' });
      expect(setVerticalSwipes).toHaveBeenLastCalledWith(false);
    }
    await waitFor(() => expect(section).toHaveAttribute('data-completion', 'closing'));
    expect(order()[0]).toBe(slot);
    expect(animate).not.toHaveBeenCalled();
    advance(0);
    if (!reduced) {
      advance(240);
      expect(parseFloat(section.style.minHeight)).toBeLessThan(1800);
      expect(order()[0]).toBe(slot);
      expect(animate).not.toHaveBeenCalled();
      advance(480);
      expect(section).toHaveAttribute('data-completion', 'reordering');
      expect(list).toHaveAttribute('inert');
      expect(
        animate.mock.calls.some(
          ([keyframes]) => keyframes[0]?.transform === `translateY(${offset}px)`,
        ),
      ).toBe(true);
    }
    expect(order()).toEqual(['morning', 'afternoon', 'evening']);
    expect(animate).toHaveBeenCalledTimes(moves);
    await act(async () => resolveMoves());
    const summary = within(section).getByLabelText(
      `Переглянути відповіді · ${name} · Підтверджено`,
    );
    expect(summary).toHaveFocus();
    expect(list).not.toHaveAttribute('inert');
    expect(section).not.toHaveAttribute('data-completion');
    expect(scroll).toHaveBeenLastCalledWith({ top: 180, behavior: 'auto' });
    const positions = scroll.mock.calls.map(([value]) => (value as ScrollToOptions).top!);
    expect(positions.every((top, i) => i === 0 || top <= positions[i - 1]!)).toBe(true);
    if (reduced) expect(positions).toEqual([180]);
    expect(section).toHaveStyle({ minHeight: '' });
    await waitFor(() => expect(setVerticalSwipes).toHaveBeenLastCalledWith(true));
    expect(api.postEvent).toHaveBeenCalledTimes(1);
  },
);
it('keeps the review open without success animation or scrolling when confirmation fails', async () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  api.postEvent.mockRejectedValueOnce(new Error('Не вдалося зберегти чек-ін'));
  const { button } = await readyToConfirm();
  fireEvent.click(button);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Підтвердити чек-ін' })).toBeEnabled();
  expect(screen.queryByText('Чек-ін збережено')).not.toBeInTheDocument();
  expect(screen.queryByText('Підтверджено')).not.toBeInTheDocument();
  expect(scroll).not.toHaveBeenCalled();
});
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
  expect(
    screen.queryByRole('heading', { name: 'Що було від попереднього запису' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Вечір · 07.10' }));
  expect(
    await screen.findByRole('heading', { name: 'Що було від попереднього запису' }),
  ).toBeInTheDocument();
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
  await screen.findByRole('heading', { name: 'Енергія' });
  fireEvent.click(screen.getByRole('button', { name: /6 Бадьорий/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Продовжити · Вечір' }));
  fireEvent.click(screen.getByRole('button', { name: '← Назад' }));
  expect(screen.getByRole('button', { name: /5 Рівний або змішаний/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Продовжити · День' }));
  expect(screen.getByRole('button', { name: /6 Бадьорий/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await waitFor(() =>
    expect(api.postEvent).toHaveBeenCalledWith(
      'checkin',
      expect.objectContaining({
        dateKey: '2026-10-07',
        slot: 'afternoon',
        energyLevelV4: 6,
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
          '2026-10-07': { evening: { ...answeredState, satisfactionV4: 3 } },
        },
      },
    },
  });
  open({ date: '2026-10-07', slot: 'evening' });
  fireEvent.click(await screen.findByRole('button', { name: '← Назад' }));
  fireEvent.click(screen.getByRole('button', { name: /6 Радше хороший/ }));
  await waitFor(() => expect(api.postEvent).toHaveBeenCalled(), { timeout: 3000 });
  expect(api.postEvent).toHaveBeenCalledWith(
    'checkin',
    expect.objectContaining({ dateKey: '2026-10-07', slot: 'evening', moodLevelV4: 6 }),
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
      checkinToday: { afternoon: answeredState },
      checkinWindows: [afternoon],
    },
  };
  api.fetchStats.mockResolvedValue(data);
  open();
  await screen.findByRole('heading', { name: 'Що було від попереднього запису' });
  expect(
    screen.getByRole('heading', { name: 'Що було від попереднього запису' }),
  ).toBeInTheDocument();
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
  expect(await screen.findByRole('button', { name: 'Відкрити · Вечір' })).toBeEnabled();
  const row = screen.getByRole('heading', { name: 'День' }).closest('section')!;
  expect(
    within(row).getByRole('heading', { name: 'Що було від попереднього запису' }),
  ).toBeInTheDocument();
});

it('never closes an available evening flow when the cache timestamp leads the ticking clock', async () => {
  // Like an optimistic write just after the last one-second useTick update.
  qc.setQueryData(['stats'], snapshot(), { updatedAt: Date.now() + 10_000 });
  const view = open();
  await screen.findByRole('heading', { name: 'Що було від попереднього запису' });
  expect(screen.queryByText('Дай дню трохи часу')).not.toBeInTheDocument();
  expect(screen.getByText('Чернетка · ще 120 хв')).toBeInTheDocument();
  const card = view.container.querySelector('.checkin-adaptive-card');
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      qc.setQueryData(['stats'], snapshot(), { updatedAt: Date.now() + 10_000 });
    });
    fireEvent.scroll(window, { target: { scrollY: 500 + i * 100 } });
    expect(
      screen.getByRole('heading', { name: 'Що було від попереднього запису' }),
    ).toBeInTheDocument();
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
  await screen.findByRole('heading', { name: 'Що було від попереднього запису' });
  fireEvent.click(screen.getByText('Справи й розвиток'));
  const work = screen.getByRole('button', { name: 'Робота' });
  const group = work.closest('details')!;
  const card = view.container.querySelector('.checkin-adaptive-card');
  for (let i = 1; i <= 2; i++) {
    fireEvent.click(work, { detail: 1 });
    fireEvent.scroll(window, { target: { scrollY: 600 } });
    await waitFor(() => expect(api.postEvent).toHaveBeenCalledTimes(i), { timeout: 3000 });
    await waitFor(() => expect(qc.isFetching({ queryKey: ['stats'] })).toBe(0));
    expect(
      screen.getByRole('heading', { name: 'Що було від попереднього запису' }),
    ).toBeInTheDocument();
    expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
    expect(group).toHaveAttribute('open');
    expect(work).toHaveAttribute('aria-pressed', i === 1 ? 'true' : 'false');
  }
});

it('keeps the evening stage mounted when the real autosave refetch fails and recovers', async () => {
  const view = open();
  await screen.findByRole('heading', { name: 'Що було від попереднього запису' });
  fireEvent.click(screen.getByText('Справи й розвиток'));
  const work = screen.getByRole('button', { name: 'Робота' });
  const card = view.container.querySelector('.checkin-adaptive-card');
  const group = work.closest('details')!;
  api.fetchStats.mockRejectedValue(new Error('Тимчасовий збій оновлення'));
  fireEvent.click(work, { detail: 1 });
  await waitFor(() => expect(api.postEvent).toHaveBeenCalled(), { timeout: 3000 });
  await waitFor(() => expect(qc.getQueryState(['stats'])?.status).toBe('error'));
  expect(
    screen.getByRole('heading', { name: 'Що було від попереднього запису' }),
  ).toBeInTheDocument();
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
  await screen.findByRole('heading', { name: 'Що було від попереднього запису' });
  const card = view.container.querySelector('.checkin-adaptive-card');
  api.fetchSettings.mockRejectedValue(new Error('Налаштування тимчасово недоступні'));
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['settings'] });
  });
  expect(
    screen.getByRole('heading', { name: 'Що було від попереднього запису' }),
  ).toBeInTheDocument();
  expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
});

it('still blocks private check-in data when the session expires during refresh', async () => {
  open();
  await screen.findByRole('heading', { name: 'Що було від попереднього запису' });
  api.fetchStats.mockRejectedValue(new SessionExpiredError(401));
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['stats'] });
  });
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', { name: 'Що було від попереднього запису' }),
    ).not.toBeInTheDocument(),
  );
});
it('shows each midday status once, with saved answers in the morning row', async () => {
  const data = windowSnapshot();
  api.fetchStats.mockResolvedValue({
    ...data,
    stats: {
      ...data.stats,
      checkinSlot: null,
      checkinServerTime: '2026-10-07T11:30:00Z',
      checkinToday: { morning: { ...answeredState, sleepQualityV4: 4, confirmed: true } },
      checkinWindows: [
        {
          ...data.stats.checkinWindows[0],
          slot: 'afternoon',
          startAt: '2026-10-07T15:00:00Z',
          endAt: '2026-10-07T19:00:00Z',
          open: false,
        },
        {
          ...data.stats.checkinWindows[0],
          startAt: '2026-10-07T19:00:00Z',
          endAt: '2026-10-07T23:00:00Z',
          open: false,
        },
      ],
    },
  });
  const view = open();
  const overview = await screen.findByRole('region', { name: 'Чек-іни за сьогодні' });
  const heading = screen.getByRole('heading', { level: 1, name: 'Мить для себе. Як ти сьогодні?' });
  expect(heading.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const list = within(overview);
  expect(list.getByRole('heading', { name: 'День' }).closest('section')).toHaveTextContent(
    'Від 18:00',
  );
  expect(list.getByRole('heading', { name: 'Вечір' }).closest('section')).toHaveTextContent(
    'Від 22:00',
  );
  const times = screen.getAllByText(/(?:18|22):00/, { ignore: 'details:not([open]) *' });
  expect(times.map((node) => node.textContent)).toEqual(['Від 18:00', 'Від 22:00']);
  expect(screen.getAllByText('Підтверджено')).toHaveLength(1);
  expect(screen.queryByText(/Пауза між чек-інами/)).not.toBeInTheDocument();
  fireEvent.click(list.getByLabelText('Переглянути відповіді · Ранок · Підтверджено'));
  expect(list.getByText(/Наскільки відпочив після цього сну/)).toBeVisible();
  fireEvent.click(list.getByText('Історія за тиждень'));
  fireEvent.click(list.getByRole('button', { name: 'Перейти до чек-інів за 2026-10-07' }));
  expect(overview).toHaveFocus();
  expect(screen.queryByRole('region', { name: 'Історія чек-інів' })).not.toBeInTheDocument();
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();

  view.unmount();
  open({ date: '2026-10-06', slot: 'evening' });
  expect(await screen.findByText('Далі · День 07.10 о 18:00')).toBeVisible();
});
it('keeps a confirmed deep-linked afternoon and weekly history in the same status card', async () => {
  const date = '2026-11-07';
  const previousDate = '2026-11-06';
  const data = windowSnapshot();
  const evening = {
    ...data.stats.checkinWindows[0],
    dateKey: date,
    startAt: `${date}T20:00:00Z`,
    endAt: '2026-11-08T02:00:00Z',
    open: false,
  };
  const morning = { ...answeredState, sleepQualityV4: 4, confirmed: true };
  api.fetchStats.mockResolvedValue({
    ...data,
    stats: {
      ...data.stats,
      checkinDate: date,
      checkinServerTime: `${date}T15:27:00Z`,
      checkinSlot: 'afternoon',
      checkinToday: {
        morning,
        afternoon: { ...answeredState, activitiesV4: ['walk'], confirmed: true },
      },
      checkinWindows: [
        {
          ...evening,
          slot: 'afternoon',
          startAt: `${date}T15:00:00Z`,
          endAt: evening.startAt,
          open: true,
        },
        evening,
      ],
      checkinRaw: {
        ...data.stats.checkinRaw,
        records: { [previousDate]: { morning } },
      },
    },
  });
  open({ date, slot: 'afternoon' });
  const card = within(await screen.findByRole('region', { name: 'Чек-іни за сьогодні' }));
  expect(screen.getAllByText('Підтверджено')).toHaveLength(2);
  expect(screen.getAllByText(/22:00/, { ignore: 'details:not([open]) *' })).toEqual([
    card.getByText('Від 22:00'),
  ]);
  expect(screen.queryByRole('button', { name: /День · 07\.11/ })).not.toBeInTheDocument();
  fireEvent.click(card.getByLabelText('Переглянути відповіді · День · Підтверджено'));
  expect(card.getByText('Прогулянка', { exact: true })).toBeVisible();

  fireEvent.click(card.getByText('Історія за тиждень'));
  fireEvent.click(card.getByRole('button', { name: `Переглянути чек-іни за ${previousDate}` }));
  const history = within(card.getByRole('region', { name: 'Історія чек-інів' }));
  expect(history.getByRole('heading', { name: 'Чек-іни за 06.11' })).toBeVisible();
  fireEvent.click(history.getByText('Відповіді'));
  expect(history.getByText('4 · Добре відпочив')).toBeVisible();
  expect(api.postEvent).not.toHaveBeenCalled();
});
it('finishes an existing v3 draft with its original answers and revision intact', async () => {
  const data = snapshot();
  api.fetchStats.mockResolvedValue({
    ...data,
    stats: {
      ...data.stats,
      checkinToday: { evening: { questionVersion: 3, energy: 3, mood: 4, satisfactionV3: 4 } },
    },
  });
  open();
  expect(await screen.findByText(/Цю чернетку почато в попередній формі/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '4 · Багато сил, легко включитися' }));
  await waitFor(
    () =>
      expect(api.postEvent).toHaveBeenCalledWith(
        'checkin',
        expect.objectContaining({ questionVersion: 3, energy: 4, mood: 4, satisfactionV3: 4 }),
      ),
    { timeout: 3000 },
  );
});
