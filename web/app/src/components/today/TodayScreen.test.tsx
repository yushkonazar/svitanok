import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TodayScreen } from './TodayScreen.tsx';
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
  vi.clearAllMocks();
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
