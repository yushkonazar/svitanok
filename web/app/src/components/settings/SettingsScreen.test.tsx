import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsScreen } from './SettingsScreen.tsx';
import { ThemeProvider } from '../../theme.tsx';
import { savePresentation } from '../../lib/presentation.ts';
import type { Settings, SettingsResponse } from '../../api/settings-schema.ts';
const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  postSettings: vi.fn(),
  fetchNewsSnapshot: vi.fn(),
}));
vi.mock('../../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client.ts')>()),
  ...api,
}));
vi.mock('../../telegram.ts', () => ({
  inTelegram: () => false,
  tg: null,
  haptic: vi.fn(),
  checkHomeScreenStatus: vi.fn(),
  addToHomeScreen: vi.fn(),
}));
vi.mock('./OperationsPanel.tsx', () => ({ OperationsPanel: () => null }));
vi.mock('./MemoryPanel.tsx', () => ({ MemoryPanel: () => null }));
vi.mock('./WorkerQualityBlock.tsx', () => ({ WorkerQualityBlock: () => null }));
vi.mock('./DeletionReceiptsBlock.tsx', () => ({ DeletionReceiptsBlock: () => null }));
let data: SettingsResponse;
let cache: QueryClient;
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  savePresentation({ calm: false, haptics: true, learning: true, newsPreview: true });
  data = {
    settings: {
      quiet: { enabled: false, from: '22:00', to: '08:00' },
      modules: {},
      mutedTopics: [],
      news: { sources: ['BBC', 'Sky Sports', 'HLTV'], intervalHours: 3 },
    },
    connectors: {
      google: true,
      calendar: true,
      gmail: true,
      scopeKnown: false,
      calendarWrite: false,
      mono: true,
    },
  };
  api.fetchSettings.mockImplementation(async () => data);
  api.postSettings.mockImplementation(async (next: Settings) => {
    data = { ...data, settings: next };
    return data;
  });
  api.fetchNewsSnapshot.mockResolvedValue({ groups: [] });
});
afterEach(() => {
  cleanup();
  cache?.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <ThemeProvider>
          <SettingsScreen />
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Вигляд і відчуття' });
}
it('shows current topics without an old briefing and links directly to feature settings', async () => {
  await setup();
  expect(screen.getByRole('switch', { name: 'Наука' })).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'CS2' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Фінанси й нагадування/ })).toHaveAttribute(
    'href',
    '/finance?action=settings',
  );
  expect(screen.getByRole('link', { name: /Дозвілля/ })).toHaveAttribute(
    'href',
    '/leisure?action=settings',
  );
  expect(screen.getByText(/До 30 відібраних/)).toBeInTheDocument();
  expect(screen.queryByText('Синхронізовано')).not.toBeInTheDocument();
  expect(screen.getAllByText('Невідомо')).toHaveLength(3);
});
it('turns legacy muted aliases into one working topic switch', async () => {
  data.settings.mutedTopics = ['Світ', 'Кіберспорт'];
  await setup();
  expect(screen.getByRole('switch', { name: 'Головне' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.queryByRole('switch', { name: 'Світ' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch', { name: 'Головне' }));
  await waitFor(() => expect(data.settings.mutedTopics).toEqual(['Кіберспорт']));
});
it('saves simultaneous source changes and interval changes without overwriting any intent', async () => {
  await setup();
  fireEvent.click(screen.getByRole('switch', { name: 'Джерело BBC' }));
  fireEvent.click(screen.getByRole('switch', { name: 'Джерело Sky Sports' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Як часто збирати новини' }), {
    target: { value: '6' },
  });
  await waitFor(() => expect(data.settings.news).toEqual({ sources: ['HLTV'], intervalHours: 6 }));
  expect(screen.getByRole('status')).toHaveTextContent('збережено');
});
it('reports a failed save and restores the switch', async () => {
  await setup();
  api.postSettings.mockRejectedValueOnce(new Error('Немає з’єднання'));
  fireEvent.click(screen.getByRole('switch', { name: 'Погода' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('Немає з’єднання');
  expect(screen.getByRole('switch', { name: 'Погода' })).toHaveAttribute('aria-checked', 'true');
});
it('explains empty quiet hours and persists local appearance settings', async () => {
  data.settings.quiet = { enabled: true, from: '22:00', to: '22:00' };
  await setup();
  expect(screen.getByText(/тихого проміжку немає/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: '☀️ Світла' }));
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  expect(localStorage.getItem('svitanok-theme')).toBe('light');
  fireEvent.click(screen.getByRole('switch', { name: 'Спокійні анімації' }));
  expect(document.documentElement).toHaveAttribute('data-calm', 'true');
  expect(JSON.parse(localStorage.getItem('svitanok:presentation:v1')!)).toMatchObject({
    calm: true,
  });
});
it('previews the actual check-in schedule, rejects invalid order, and waits for acknowledgement', async () => {
  await setup();
  fireEvent.click(screen.getByText('Мій ритм і джерела даних'));
  expect(screen.getByText(/Ранок 05:00–13:00/)).toBeInTheDocument();
  const time = screen.getByLabelText('Початок денного');
  fireEvent.change(time, { target: { value: '04:00' } });
  expect(screen.getByRole('button', { name: 'Зберегти розклад' })).toBeDisabled();
  fireEvent.change(time, { target: { value: '12:00' } });
  expect(screen.getByText(/Ранок 05:00–12:00/)).toBeInTheDocument();
  let resolve!: (value: SettingsResponse) => void;
  api.postSettings.mockImplementationOnce(
    (next: Settings) =>
      new Promise<SettingsResponse>((done) => {
        resolve = () => {
          data = { ...data, settings: next };
          done(data);
        };
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти розклад' }));
  await waitFor(() => expect(time).toBeDisabled());
  await act(async () => resolve(data));
  await waitFor(() => expect(time).not.toBeDisabled());
  expect(
    cache.getQueryData<SettingsResponse>(['settings'])!.settings.checkin?.schedule.afternoon,
  ).toBe('12:00');
  expect(
    within(screen.getByText('Мій ритм і джерела даних').parentElement!).getByRole('status'),
  ).toHaveTextContent('Розклад збережено');
});
