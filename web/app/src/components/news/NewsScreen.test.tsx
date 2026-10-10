import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NewsScreen } from './NewsScreen.tsx';
import { NewsArt } from './NewsArt.tsx';
import { NewsItem } from './NewsItem.tsx';
import type { NewsSnapshot } from '../../api/briefing-schema.ts';
const mocks = vi.hoisted(() => ({
  live: null as NewsSnapshot | null,
  feedback: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../../api/hooks.ts', () => ({
  useBriefing: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
  useSettings: () => ({ data: { settings: { mutedTopics: [], modules: {} } } }),
  useNewsSnapshot: () => ({
    data: mocks.live,
    error: null,
    refetch: async () => ({ data: mocks.live }),
    isFetching: false,
  }),
  useStats: () => ({ data: { stats: { votes: {} } } }),
  useRefreshNews: () => ({ mutate: mocks.refresh, error: null, isPending: false }),
  useNewsSeen: () => ({ mutate: vi.fn() }),
  useNewsFeedback: () => ({ mutate: mocks.feedback, error: null, isPending: false }),
  useToggleSaveNews: () => ({ mutate: vi.fn() }),
}));
vi.mock('../../api/client.ts', () => ({ isSessionExpired: () => false, postEvent: vi.fn() }));
vi.mock('../../telegram.ts', () => ({ haptic: vi.fn(), openLink: vi.fn() }));
function snapshot(title: string, version: number): NewsSnapshot {
  return {
    groups: [
      {
        scope: 'world',
        topic: 'Головне',
        items: [
          {
            title,
            url: `https://www.bbc.com/news/${version}`,
            publishedAt: '2026-10-06T10:00:00Z',
          },
        ],
        more: [],
      },
    ],
    generatedAt: `2026-10-06T1${version}:00:00Z`,
    attemptedAt: `2026-10-06T1${version}:00:00Z`,
    sources: [{ name: 'BBC', ok: true }],
    localization: { translated: 1, native: 1, pending: 0, total: 2 },
  };
}
beforeEach(() => {
  mocks.live = snapshot('Перша подія', 1);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
it('opens the concise overview and shows source-proven text changes', () => {
  mocks.live!.groups[0]!.items[0] = {
    ...mocks.live!.groups[0]!.items[0]!,
    updated: true,
    changeAt: '2026-10-06T11:00:00Z',
    previousTitle: 'Попередня подія',
    previousSummary: 'Раніше повідомляли меншу суму.',
    why: 'Новий опис джерела.',
  };
  render(
    <MemoryRouter>
      <NewsScreen />
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { name: 'Головне зараз' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Коротко: Перша подія' }));
  fireEvent.click(screen.getByText('Що змінилося в матеріалі?'));
  expect(screen.getByText('Раніше: Попередня подія')).toBeInTheDocument();
  expect(screen.getByText('Тепер: Перша подія')).toBeInTheDocument();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('uses text cards without a placeholder and records an explicit less-like-this signal', () => {
  const view = render(
    <NewsItem item={{ title: 'Подія', url: 'https://www.bbc.com/news/a' }} topic="Головне" />,
  );
  expect(view.container.querySelector('.renewal-news-visual')).toBeNull();
  expect(view.container.querySelector('.is-text-only')).not.toBeNull();
  expect(screen.queryByText(/Ілюстрація/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Менше такого' }));
  expect(mocks.feedback).toHaveBeenCalledWith(
    { url: 'https://www.bbc.com/news/a', kind: 'less' },
    expect.any(Object),
  );
});
it('removes an unavailable photo completely and can show a replacement image', () => {
  const view = render(<NewsArt image="/api/news/image/a" topic="Головне" />);
  fireEvent.error(view.container.querySelector('img')!);
  expect(view.container.querySelector('.renewal-news-art')).toBeNull();
  view.rerender(<NewsArt image="/api/news/image/b" topic="Головне" />);
  expect(view.container.querySelector('img')).toHaveAttribute('src', '/api/news/image/b');
});
it('announces a new snapshot without moving existing articles until the reader applies it', () => {
  const view = render(
    <MemoryRouter>
      <NewsScreen />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Коротко: Перша подія' })).toBeInTheDocument();
  mocks.live = snapshot('Друга подія', 2);
  view.rerender(
    <MemoryRouter>
      <NewsScreen />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Коротко: Перша подія' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Коротко: Друга подія' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Оновлена добірка/ }));
  expect(screen.getByRole('button', { name: 'Коротко: Друга подія' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Коротко: Перша подія' })).not.toBeInTheDocument();
});

it('shows each headline once and keeps additional main events and interests in the remaining feed', () => {
  mocks.live!.groups[0]!.items = Array.from({ length: 7 }, (_, i) => ({
    title: `Головна подія ${i + 1}`,
    url: `https://www.bbc.com/news/main-${i + 1}`,
  }));
  mocks.live!.groups.push({
    scope: 'world',
    topic: 'Тех/IT',
    items: [
      {
        title: 'Цікава технологія',
        url: 'https://www.bbc.com/news/technology',
        priority: 1,
      },
    ],
    more: [],
  });
  const view = render(
    <MemoryRouter>
      <NewsScreen />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole('button', { name: /^Коротко:/ })).toHaveLength(5);
  expect(view.container.querySelectorAll('article')).toHaveLength(3);
  for (let i = 1; i <= 5; i++)
    expect(screen.getAllByText(`${i}. Головна подія ${i}`)).toHaveLength(1);
  expect(screen.getByText('Головна подія 6')).toBeInTheDocument();
  expect(screen.getByText('Головна подія 7')).toBeInTheDocument();
  expect(screen.getByText('Цікава технологія')).toBeInTheDocument();
});

it('keeps highlighted stories searchable and filterable when the overview is hidden', () => {
  render(
    <MemoryRouter>
      <NewsScreen />
    </MemoryRouter>,
  );
  const input = screen.getByRole('textbox', { name: 'Пошук у новинах' });
  fireEvent.change(input, { target: { value: 'Перша' } });
  expect(screen.queryByRole('heading', { name: 'Головне зараз' })).not.toBeInTheDocument();
  expect(screen.getByText('Перша подія')).toBeInTheDocument();
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Головне' }));
  expect(screen.queryByRole('heading', { name: 'Головне зараз' })).not.toBeInTheDocument();
  expect(screen.getByText('Перша подія')).toBeInTheDocument();
});

it('does not show an empty feed warning when all stories are displayed in the overview', () => {
  const view = render(
    <MemoryRouter>
      <NewsScreen />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Коротко: Перша подія' })).toBeInTheDocument();
  expect(view.container.querySelectorAll('article')).toHaveLength(0);
  expect(screen.queryByText(/Тут поки немає матеріалів/)).not.toBeInTheDocument();
});
it('starts a real collection action and does not label native Ukrainian as a translation failure', () => {
  render(
    <MemoryRouter>
      <NewsScreen />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Оновити новини' }));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Переклад очікується/)).not.toBeInTheDocument();
});
