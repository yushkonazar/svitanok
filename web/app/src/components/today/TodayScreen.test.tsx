import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TodayScreen } from './TodayScreen.tsx';
import { DEFAULT_TODAY_ORDER, saveTodayOrder } from '../../lib/todayLayout.ts';
const newsRead = vi.hoisted(() => vi.fn(() => ({ data: undefined })));
vi.mock('../../api/hooks.ts', () => ({
  useSettings: () => ({ data: { settings: { modules: { news: true } } } }),
  useStats: () => ({}),
  useLiveWeather: () => ({}),
  useNewsSnapshot: newsRead,
  useBriefing: () => ({
    data: {
      demo: true,
      brief: {
        generatedAt: '2026-11-03T08:00:00Z',
        blocks: [
          { id: 'currency', data: { usd: 40 } },
          { id: 'onthisday', data: { events: [{ year: 1000, text: 'Історична подія' }] } },
          {
            id: 'news',
            data: {
              groups: [
                {
                  scope: 'world',
                  topic: 'Головне',
                  more: [],
                  items: [
                    { title: 'Новина залишається у стрічці', url: 'https://www.bbc.com/news/test' },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  }),
}));
vi.mock('../../api/finance-hooks.ts', () => ({ useFinance: () => ({}) }));
afterEach(() => {
  cleanup();
  saveTodayOrder(DEFAULT_TODAY_ORDER);
  vi.clearAllMocks();
});

it('uses the saved order while keeping daily actions first and the compact timer last', () => {
  saveTodayOrder(['onthisday', 'currency', 'weather', 'fact', 'stoic']);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { container } = render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <TodayScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    [...container.querySelectorAll('[data-today-block]')].map((node) =>
      node.getAttribute('data-today-block'),
    ),
  ).toEqual(['onthisday', 'currency', 'learning']);
  const first = screen.getByRole('link', { name: '＋ Записати витрату' });
  expect(
    first.compareDocumentPosition(screen.getByRole('heading', { name: 'День на мапі історії' })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  cache.clear();
});
it('does not render or fetch news on Today when the briefing and module settings include them', () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <TodayScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole('link', { name: '＋ Записати витрату' })).toBeInTheDocument();
  expect(screen.getByText('ВАЛЮТИ')).toBeInTheDocument();
  expect(screen.queryByText('Поза твоїм вікном')).not.toBeInTheDocument();
  expect(screen.queryByText('Новина залишається у стрічці')).not.toBeInTheDocument();
  expect(newsRead).not.toHaveBeenCalled();
  cache.clear();
});
