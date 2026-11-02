import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HashRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { checkinOpenButton } from '../../core/checkin/windows.mjs';
import { weeklyOverviewButtons } from '../../core/brain/weekly-links.mjs';
import { planButton } from '../../core/motivation/links.mjs';
import { financeMiniAppButton } from '../../core/finance/links.mjs';

const launch = vi.hoisted(() => ({ param: undefined as string | undefined }));
vi.mock('./api/hooks.ts', () => ({ useBriefing: () => ({}), useStats: () => ({}) }));
vi.mock('./api/finance-hooks.ts', () => ({ useFinance: () => ({}) }));
vi.mock('./api/client.ts', async (original) => ({
  ...(await original<typeof import('./api/client.ts')>()),
  postEvent: vi.fn().mockResolvedValue({}),
}));
vi.mock('./telegram.ts', async (original) => {
  const actual = await original<typeof import('./telegram.ts')>();
  return {
    ...actual,
    tg: null,
    inTelegram: () => false,
    haptic: vi.fn(),
    startParam: () => launch.param ?? actual.startParam(),
    setBackButton: () => () => {},
  };
});
vi.mock('./components/today/TodayScreen.tsx', () => ({
  TodayScreen: () => <LaunchScreen name="Сьогодні" />,
}));
vi.mock('./components/checkin/CheckinScreen.tsx', () => ({
  CheckinScreen: () => <LaunchScreen name="Чек-ін" />,
}));
vi.mock('./components/stats/WeeklyReportScreen.tsx', () => ({
  WeeklyReportScreen: () => <LaunchScreen name="Огляд" />,
}));
vi.mock('./components/news/NewsScreen.tsx', () => ({
  NewsScreen: () => <LaunchScreen name="Новини" />,
}));
vi.mock('./components/finance/FinanceScreen.tsx', () => ({
  FinanceScreen: () => <LaunchScreen name="Фінанси" />,
}));
vi.mock('./components/plan/PlanScreen.tsx', () => ({
  PlanScreen: () => <LaunchScreen name="План" />,
}));
vi.mock('./components/leisure/LeisureScreen.tsx', () => ({
  LeisureScreen: () => <LaunchScreen name="Дозвілля" />,
}));
vi.mock('./components/settings/SettingsScreen.tsx', () => ({
  SettingsScreen: () => <LaunchScreen name="Налаштування" />,
}));
vi.mock('./components/system/SystemScreen.tsx', () => ({
  SystemScreen: () => <LaunchScreen name="Система" />,
}));
vi.mock('./components/trips/TripsScreen.tsx', () => ({
  TripsScreen: () => <LaunchScreen name="Подорожі" />,
}));
vi.mock('./components/stats/StatsScreen.tsx', () => ({
  StatsScreen: () => <LaunchScreen name="Мій стан" />,
}));
vi.mock('./components/saved/SavedScreen.tsx', () => ({
  SavedScreen: () => <LaunchScreen name="Збережене" />,
}));
vi.mock('./components/bookmarks/BookmarksScreen.tsx', () => ({
  BookmarksScreen: () => <LaunchScreen name="Закладки" />,
}));
vi.mock('./components/settings/MemoryPanel.tsx', () => ({
  MemoryPanel: () => <LaunchScreen name="Пам’ять" />,
}));

function LaunchScreen({ name }: { name: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <h1>{name}</h1>
      <output data-testid="destination">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate('/news')}>Відкрити новини</button>
    </div>
  );
}

beforeEach(() => {
  launch.param = undefined;
  window.history.replaceState(null, '', '/app/');
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open(fragment: string, param?: string, query = '') {
  launch.param = param;
  window.history.replaceState(null, '', `/app/${query}#${fragment}`);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <StrictMode>
      <HashRouter>
        <QueryClientProvider client={cache}>
          <App />
        </QueryClientProvider>
      </HashRouter>
    </StrictMode>,
  );
}

it.each([
  ['checkin_2026-11-02_morning', '/checkin?date=2026-11-02&slot=morning'],
  ['weekly_20261026', '/weekly-report?week=2026-10-26'],
])(
  'opens the actual %s destination from a Telegram launch fragment',
  async (param, destination) => {
    open(`tgWebAppData=synthetic&tgWebAppVersion=8.0&tgWebAppStartParam=${param}`, param);
    await waitFor(() => expect(screen.getByTestId('destination')).toHaveTextContent(destination));
    await userEvent.click(screen.getByRole('button', { name: 'Відкрити новини' }));
    await waitFor(() => expect(screen.getByTestId('destination')).toHaveTextContent('/news'));
  },
);

it('preserves an explicit web_app hash target including its date and slot', async () => {
  open('/checkin?date=2026-11-02&slot=evening');
  await waitFor(() =>
    expect(screen.getByTestId('destination')).toHaveTextContent(
      '/checkin?date=2026-11-02&slot=evening',
    ),
  );
});

it('opens a GET-only Telegram launch without the SDK unsafe start field', async () => {
  open(
    'tgWebAppData=synthetic&tgWebAppVersion=8.0',
    undefined,
    '?tgWebAppStartParam=weekly_20261026',
  );
  await waitFor(() =>
    expect(screen.getByTestId('destination')).toHaveTextContent('/weekly-report?week=2026-10-26'),
  );
});

it('replaces a previously restored page with the SDK notification target', async () => {
  open('/news', 'checkin_2026-11-02_morning');
  await waitFor(() =>
    expect(screen.getByTestId('destination')).toHaveTextContent(
      '/checkin?date=2026-11-02&slot=morning',
    ),
  );
});

it('returns unknown routes to Today', async () => {
  open('tgWebAppData=synthetic&tgWebAppStartParam=unknown', 'unknown');
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Сьогодні' })).toBeVisible());
});

const botEnv = {
  TELEGRAM_BOT_USERNAME: 'svitanok_bot',
  MINI_APP_URL: 'https://svitanok.example',
} as Parameters<typeof checkinOpenButton>[0];
const notifications = [
  {
    name: 'ранковий чек-ін',
    button: () => checkinOpenButton(botEnv, '2026-11-02', 'morning', -100123),
    path: '/checkin?date=2026-11-02&slot=morning',
  },
  {
    name: 'денний чек-ін',
    button: () => checkinOpenButton(botEnv, '2026-11-02', 'afternoon', -100123),
    path: '/checkin?date=2026-11-02&slot=afternoon',
  },
  {
    name: 'вечірній чек-ін',
    button: () => checkinOpenButton(botEnv, '2026-11-02', 'evening', -100123),
    path: '/checkin?date=2026-11-02&slot=evening',
  },
  {
    name: 'тижневий огляд',
    button: () => weeklyOverviewButtons(botEnv, -100123, '2026-10-26')[0]?.[0],
    path: '/weekly-report?week=2026-10-26',
  },
  {
    name: 'задача плану',
    button: () => planButton(botEnv, 'plan_task_task-1', -100123),
    path: '/plan?task=task-1',
  },
  {
    name: 'день плану',
    button: () => planButton(botEnv, 'plan_date_2026-11-02', -100123),
    path: '/plan?date=2026-11-02',
  },
  {
    name: 'банківська операція',
    button: () => financeMiniAppButton(botEnv, 'Відкрити операцію', 'transaction', 'tx-1', -100123),
    path: '/finance?transaction=tx-1',
  },
  {
    name: 'платіж',
    button: () => financeMiniAppButton(botEnv, 'Оплатити', 'payment', 'pay-1', -100123),
    path: '/finance?payment=pay-1',
  },
];

it.each(notifications)(
  'opens the exact destination of the real $name bot button',
  async ({ button, path }) => {
    const target = button();
    if (!target || typeof target.url !== 'string') throw new Error('Missing Telegram button');
    const param = new URL(target.url).searchParams.get('startapp');
    if (!param) throw new Error('Missing notification start parameter');
    open(`tgWebAppData=synthetic&tgWebAppStartParam=${encodeURIComponent(param)}`, param);
    await waitFor(() => expect(screen.getByTestId('destination')).toHaveTextContent(path));
  },
);

it.each([
  ['access', '/settings?panel=access'],
  ['leisure', '/leisure'],
  ['leisure_item-1', '/leisure?item=item-1'],
  ['settings', '/settings'],
  ['memory', '/memory'],
  ['weekly-report', '/weekly-report'],
  ['finance', '/finance'],
  ['plan', '/plan'],
  ['news', '/news'],
  ['checkin', '/checkin'],
  ['stats', '/stats'],
  ['system', '/system'],
  ['trips', '/trips'],
  ['saved', '/saved'],
  ['bookmarks', '/bookmarks'],
])('opens the %s entry point without a competing home redirect', async (param, destination) => {
  open(`?tgWebAppStartParam=${param}&tgWebAppVersion=8.0`, param);
  await waitFor(() => expect(screen.getByTestId('destination')).toHaveTextContent(destination));
});

it('opens another notification after an already mounted WebView receives a fresh launch envelope', async () => {
  open('/news');
  await screen.findByRole('heading', { name: 'Новини' });
  launch.param = 'checkin_2026-11-02_evening';
  act(() => {
    window.location.hash = `tgWebAppData=synthetic&tgWebAppStartParam=${launch.param}`;
  });
  await waitFor(() =>
    expect(screen.getByTestId('destination')).toHaveTextContent(
      '/checkin?date=2026-11-02&slot=evening',
    ),
  );
});

it('preserves a later direct web_app route instead of replaying the original SDK target', async () => {
  open('/', 'weekly_20261026');
  await waitFor(() =>
    expect(screen.getByTestId('destination')).toHaveTextContent('/weekly-report?week=2026-10-26'),
  );
  act(() => {
    window.location.hash = '/checkin?date=2026-11-02&slot=evening';
  });
  await waitFor(() =>
    expect(screen.getByTestId('destination')).toHaveTextContent(
      '/checkin?date=2026-11-02&slot=evening',
    ),
  );
});

it('makes weekly reports reachable from Today even before briefing data is available', async () => {
  open('/');
  await userEvent.click(screen.getByRole('link', { name: /Тижневі огляди/ }));
  await waitFor(() =>
    expect(screen.getByTestId('destination')).toHaveTextContent('/weekly-report'),
  );
});
