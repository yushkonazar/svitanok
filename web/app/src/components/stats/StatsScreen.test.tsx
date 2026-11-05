import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EMPTY_STATS } from '../../api/sample.ts';
import {
  statsSchema,
  archiveMonthSchema,
  type Stats,
  type ArchiveMonth,
} from '../../api/schema.ts';
import { demoStateRecords } from '../../../../core/checkin/state-analysis.mjs';
import { appendStateArchive } from '../../../../core/checkin/state-history.mjs';
import { StatsScreen, statisticsPeriodKey } from './StatsScreen.tsx';

const mock = vi.hoisted(() => ({
  privateMode: true,
  stats: null as Stats | null,
  archive: [] as ArchiveMonth[],
  archiveError: false,
  archiveCall: vi.fn(),
  retry: vi.fn(),
}));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => mock.privateMode, haptic: vi.fn() }));
vi.mock('../../api/hooks.ts', () => ({
  useStats: () => ({
    data: { stats: mock.stats },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useArchive: (enabled: boolean) => {
    mock.archiveCall(enabled);
    return {
      data: enabled ? mock.archive : undefined,
      isLoading: false,
      isError: enabled && mock.archiveError,
      refetch: mock.retry,
    };
  },
}));
const to = '2026-11-05';
function stats(records: Record<string, unknown> = {}) {
  return statsSchema.parse({
    ...EMPTY_STATS,
    checkinDate: to,
    checkinToday: null,
    checkinRaw: { records, from: '2026-05-10', to, days: 180 },
  });
}
function show() {
  return render(
    <MemoryRouter>
      <StatsScreen />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  mock.privateMode = true;
  mock.stats = stats();
  mock.archive = [];
  mock.archiveError = false;
  mock.archiveCall.mockClear();
  mock.retry.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('opens at 30 days and keeps a private empty account honest with one empty state', () => {
  show();
  expect(screen.getByRole('button', { name: '30 днів' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('Тут з’явиться твій ритм')).toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(screen.queryByText('0 /5')).not.toBeInTheDocument();
  expect(screen.queryByText('Як вистачає сил протягом дня')).not.toBeInTheDocument();
  expect(mock.archiveCall.mock.calls.some(([enabled]) => enabled)).toBe(false);
});
it('remembers a supported period independently for demo and private views', () => {
  let view = show();
  fireEvent.click(screen.getByRole('button', { name: '90 днів' }));
  view.unmount();
  expect(localStorage.getItem(statisticsPeriodKey(true))).toBe('90');
  view = show();
  expect(screen.getByRole('button', { name: '90 днів' })).toHaveAttribute('aria-pressed', 'true');
  view.unmount();
  mock.privateMode = false;
  view = show();
  expect(screen.getByRole('button', { name: '30 днів' })).toHaveAttribute('aria-pressed', 'true');
  view.unmount();
  localStorage.setItem(statisticsPeriodKey(true), '365');
  mock.privateMode = true;
  show();
  expect(screen.getByRole('button', { name: '30 днів' })).toHaveAttribute('aria-pressed', 'true');
});
it('uses one selected date for all three slot values and resets the day when period changes', () => {
  mock.stats = stats(demoStateRecords(to));
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Настрій' }));
  const slider = screen.getByRole('slider', { name: 'Дата: Настрій' });
  fireEvent.change(slider, { target: { value: '0' } });
  expect(slider).toHaveAttribute('aria-valuetext', expect.stringMatching(/^7 жовт\./));
  fireEvent.click(screen.getByText('Відповіді за 7 жовт.'));
  expect(screen.getByLabelText('День для перегляду')).toHaveValue('2026-10-07');
  fireEvent.click(screen.getByRole('button', { name: '7 днів' }));
  expect(screen.getByRole('button', { name: 'Настрій' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('Відповіді за 5 лист.').closest('details')).not.toHaveAttribute('open');
  expect(screen.getByRole('slider', { name: 'Дата: Настрій' })).toHaveAttribute(
    'aria-valuetext',
    expect.stringMatching(/^5 лист\./),
  );
  expect(
    screen.getAllByRole('img').some((el) => el.getAttribute('aria-label')?.startsWith('Настрій:')),
  ).toBe(true);
});
it('opens evidence dates into a readable, deduplicated day with historical custom labels', () => {
  const records = demoStateRecords(to);
  records[to].evening = {
    ...records[to].evening,
    mood: 5,
    moodFactorsV4: ['user_evening'],
    optionLabelsV4: { moodFactorsV4: { user_evening: 'Люди :: Наш вечір' } },
    planTextV4: 'Завершити урок',
    newPriorityV4: 'Завершити урок',
  };
  mock.stats = stats(records);
  show();
  fireEvent.click(screen.getAllByText('На чому це ґрунтується')[0]);
  const evidence = document.querySelector('.state-evidence[open]')!;
  fireEvent.click(within(evidence as HTMLElement).getAllByRole('button', { name: '5 лист.' })[0]);
  const detail = screen.getByText('Відповіді за 5 лист.').closest('details')!;
  expect(detail).toHaveAttribute('open');
  fireEvent.click(within(detail).getByText('Вечір', { exact: true }));
  expect(within(detail).getByText('Наш вечір')).toBeInTheDocument();
  expect(within(detail).getAllByText('Завершити урок')).toHaveLength(1);
  expect(within(detail).queryByText('user_evening')).not.toBeInTheDocument();
});
it('keeps gated explanations separate from manual comparisons and filters them by parent mood', async () => {
  mock.stats = stats({
    '2026-11-04': {
      evening: { confirmed: true, questionVersion: 4, mood: 5, moodFactorsV4: ['weather_good'] },
    },
    '2026-11-05': {
      evening: { confirmed: true, questionVersion: 4, mood: 1, moodFactorsV4: ['conflict'] },
    },
  });
  show();
  const summary = screen.getByText('Дослідити власні зв’язки');
  fireEvent.click(summary);
  await waitFor(() => expect(screen.getByLabelText('Що порівняти')).toBeInTheDocument());
  const select = screen.getByLabelText('Що порівняти');
  expect(
    within(select).queryByRole('option', { name: /причини настрою/i }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Твої пояснення' }));
  const explorer = within(document.querySelector('.state-explorer') as HTMLElement);
  expect(explorer.getByText('Гарна погода')).toBeInTheDocument();
  expect(explorer.queryByText('Конфлікт')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Який настрій пояснюєш'), { target: { value: 'poor' } });
  expect(explorer.queryByText('Гарна погода')).not.toBeInTheDocument();
  expect(explorer.getByText('Конфлікт')).toBeInTheDocument();
  expect(screen.getByText(/Це твої пояснення/)).toBeInTheDocument();
});
it('loads history on request, shows a single recorded month and preserves custom archive names', async () => {
  const bucket = { month: '2025-12' };
  appendStateArchive(bucket, '2025-12-01', {
    evening: {
      confirmed: true,
      questionVersion: 4,
      energy: 3,
      moodFactorsV4: ['user_name'],
      optionLabelsV4: { moodFactorsV4: { user_name: 'Люди :: Родинний вечір' } },
    },
  });
  mock.archive = [archiveMonthSchema.parse(bucket)];
  show();
  expect(mock.archiveCall.mock.calls.some(([enabled]) => enabled)).toBe(false);
  const summary = screen.getByText('Історія за місяцями');
  fireEvent.click(summary);
  await waitFor(() => expect(screen.getByLabelText('Показник історії')).toBeInTheDocument());
  expect(mock.archiveCall.mock.calls.some(([enabled]) => enabled)).toBe(true);
  expect(
    screen.getByText('груд. 2025 р.', { selector: '.state-month>summary>span' }),
  ).toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('груд. 2025 р.', { selector: '.state-month>summary>span' }));
  fireEvent.click(screen.getByText('Власні варіанти в цьому місяці'));
  expect(screen.getByText(/Люди :: Родинний вечір/)).toBeInTheDocument();
  expect(screen.queryByText('user_name')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '2026 рік' }));
  expect(
    screen.queryByText('груд. 2025 р.', { selector: '.state-month>summary>span' }),
  ).not.toBeInTheDocument();
});
it('can retry archive errors while current raw history stays visible', async () => {
  mock.stats = stats(demoStateRecords(to));
  mock.archiveError = true;
  show();
  const summary = screen.getByText('Історія за місяцями');
  fireEvent.click(summary);
  await waitFor(() =>
    expect(screen.getByText(/Давні підсумки не завантажилися/)).toBeInTheDocument(),
  );
  expect(screen.getByText('лист. 2026 р. · триває')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
  expect(mock.retry).toHaveBeenCalledOnce();
});
