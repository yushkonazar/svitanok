import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewsScreen } from './NewsScreen.tsx';
import { NewsArt } from './NewsArt.tsx';
import { NewsItem } from './NewsItem.tsx';
import { markRead } from '../../lib/reading.ts';
import { newsReadKey } from '../../lib/newsStories.ts';
import type { NewsSnapshot } from '../../api/briefing-schema.ts';
import type { SavedPage } from '../../api/schema.ts';
const mocks = vi.hoisted(() => ({
  live: null as NewsSnapshot | null,
  feedback: vi.fn(),
  refresh: vi.fn(),
  story: vi.fn(),
  seen: vi.fn(),
  archive: [] as SavedPage[],
  explanations: false,
  expired: false,
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
  useNewsSeen: () => ({ mutate: mocks.seen }),
  useNewsStoryAction: () => ({ mutate: mocks.story, error: null, isPending: false }),
  useSavedArchive: () => ({ data: { pages: mocks.archive }, isLoading: false, error: null }),
  useNewsFeedback: () => ({ mutate: mocks.feedback, error: null, isPending: false }),
  useToggleSaveNews: () => ({ mutate: vi.fn() }),
}));
vi.mock('../../api/client.ts', () => ({
  isSessionExpired: () => mocks.expired,
  postEvent: vi.fn(),
}));
vi.mock('../../telegram.ts', () => ({ haptic: vi.fn(), openLink: vi.fn() }));
vi.mock('../../lib/presentation.ts', () => ({
  usePresentation: () => ({ calm: true, explanations: mocks.explanations }),
}));
function snapshot(title = 'Перша подія', version = 1): NewsSnapshot {
  return {
    groups: [
      {
        scope: 'world',
        topic: 'Головне',
        items: [
          {
            title,
            url: `https://www.bbc.com/news/${version}`,
            storyId: `event-${version}`,
            contentVersion: 'v1',
            firstSeenAt: '2026-11-03T10:00:00Z',
            changeAt: '2026-11-03T10:00:00Z',
            publishedAt: '2026-11-03T10:00:00Z',
          },
        ],
        more: [],
      },
    ],
    generatedAt: '2026-11-03T11:00:00Z',
    attemptedAt: `2026-11-03T1${version}:00:00Z`,
    sources: [{ name: 'BBC', ok: true }],
    reader: { following: {}, mutedUntil: {}, readVersions: {} },
    lastSeenAt: '2026-11-03T09:00:00Z',
  };
}
function mount(path = '/news') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <NewsScreen />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, rerenderNews: () => result.rerender(tree()), client };
}
beforeEach(() => {
  sessionStorage.clear();
  mocks.live = snapshot();
  mocks.archive = [];
  mocks.explanations = false;
  mocks.expired = false;
  markRead(newsReadKey(mocks.live.groups[0]!.items[0]!), false);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('starts with compact unduplicated stories and opens the real headline with one actions panel', () => {
  const view = mount();
  expect(screen.getByRole('heading', { name: 'Новини', level: 1 })).toBeVisible();
  expect(screen.getAllByText('Перша подія')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити: Перша подія' }));
  expect(screen.getByRole('heading', { name: 'Перша подія', level: 1 })).toBeVisible();
  expect(view.container.querySelectorAll('.news-detail-actions')).toHaveLength(1);
  expect(screen.queryByText('Подія крупним планом.')).not.toBeInTheDocument();
  expect(mocks.story).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'story', storyId: 'event-1', action: 'read', version: 'v1' }),
    expect.any(Object),
  );
  expect(mocks.feedback).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'До стрічки' }));
  expect(screen.getByText('Переглянуто')).toBeVisible();
});
it('separates interests from the main feed without repeating headlines', () => {
  mocks.live!.groups.push({
    scope: 'world',
    topic: 'Наука',
    items: [{ title: 'Місія NASA', url: 'https://www.nasa.gov/mission', priority: 1 }],
    more: [],
  });
  mount();
  expect(screen.queryByText('Місія NASA')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'За інтересами' }));
  expect(screen.getAllByText('Місія NASA')).toHaveLength(1);
  expect(screen.queryByText('Перша подія')).not.toBeInTheDocument();
});
it('keeps the applied stream stable and announces actual versions instead of collection timestamps', () => {
  const view = mount();
  mocks.live = { ...mocks.live!, attemptedAt: '2026-11-03T13:00:00Z' };
  view.rerenderNews();
  expect(screen.queryByRole('button', { name: /Оновлена добірка/ })).not.toBeInTheDocument();
  mocks.live = snapshot('Друга подія', 2);
  view.rerenderNews();
  expect(screen.getByText('Перша подія')).toBeVisible();
  expect(screen.queryByText('Друга подія')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Оновлена добірка/ }));
  expect(screen.getByText('Друга подія')).toBeVisible();
  expect(screen.queryByText('Перша подія')).not.toBeInTheDocument();
});
it('compares the actual before/after descriptions and includes titles of related reports', () => {
  Object.assign(mocks.live!.groups[0]!.items[0]!, {
    updated: true,
    changeKind: 'facts',
    previousTitle: 'Виділено 50 мільйонів',
    previousSummary: 'Виплати заплановані на листопад.',
    title: 'Виділено 60 мільйонів',
    why: 'Виплати заплановані на грудень.',
    related: [
      {
        title: 'Докладніше про виплати',
        url: 'https://suspilne.media/article',
        publishedAt: '2026-11-03T10:30:00Z',
      },
    ],
  });
  const view = mount('/news?article=' + encodeURIComponent('https://www.bbc.com/news/1'));
  fireEvent.click(screen.getByText('Що змінилося'));
  expect(view.container.querySelector('mark')).toHaveTextContent('60');
  fireEvent.click(screen.getByRole('button', { name: 'Було' }));
  expect(screen.getByRole('heading', { name: 'Виділено 50 мільйонів' })).toBeVisible();
  fireEvent.click(screen.getByText(/Інші матеріали про подію/));
  expect(screen.getByRole('button', { name: /Докладніше про виплати Суспільне/ })).toBeVisible();
});
it('shows a follow only after acknowledgement and keeps the selected article open after unfollowing', () => {
  const view = mount('/news?article=' + encodeURIComponent('https://www.bbc.com/news/1'));
  fireEvent.click(screen.getByRole('button', { name: 'Стежити за подією' }));
  expect(screen.getByRole('button', { name: 'Стежити за подією' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const item = mocks.live!.groups[0]!.items[0]!;
  mocks.live!.reader!.following['event-1'] = {
    item,
    topic: 'Головне',
    scope: 'world',
    followedAt: '2026-11-03T12:00:00Z',
  };
  view.rerenderNews();
  expect(screen.getByRole('button', { name: 'Стежу' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'До стрічки' }));
  fireEvent.click(screen.getByRole('button', { name: 'Стежу 1' }));
  expect(screen.getByText('Перша подія')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити: Перша подія' }));
  fireEvent.click(screen.getByRole('button', { name: 'Стежу' }));
  delete mocks.live!.reader!.following['event-1'];
  view.rerenderNews();
  expect(screen.getByRole('heading', { name: 'Перша подія' })).toBeVisible();
});
it('does not pretend a failed follow was saved', () => {
  mount('/news?article=' + encodeURIComponent('https://www.bbc.com/news/1'));
  mocks.story.mockImplementationOnce((_input, callbacks) =>
    callbacks.onError(new Error('Немає мережі')),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Стежити за подією' }));
  expect(screen.getByRole('status')).toHaveTextContent('Немає мережі');
  expect(screen.getByRole('button', { name: 'Стежити за подією' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
it('lets the reader find and unmute a hidden story', () => {
  mocks.live!.reader!.mutedUntil['event-1'] = new Date(Date.now() + 3600000).toISOString();
  mount();
  expect(screen.queryByText('Перша подія')).not.toBeInTheDocument();
  expect(screen.getByText('Події тимчасово приглушені.')).toBeVisible();
  fireEvent.click(screen.getByText('Пошук і фільтри'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Показати приглушені · 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити: Перша подія' }));
  fireEvent.click(screen.getByRole('button', { name: 'Повернути у стрічку' }));
  expect(mocks.story).toHaveBeenLastCalledWith(
    { type: 'story', storyId: 'event-1', action: 'unmute' },
    expect.any(Object),
  );
});
it('shows old saved articles without inventing a publication date or offering unavailable following', () => {
  mocks.archive = [
    {
      items: [
        {
          kind: 'news',
          id: 'https://www.bbc.com/news/old',
          url: 'https://www.bbc.com/news/old',
          title: 'Давній збережений матеріал',
          ts: '2025-01-01',
        },
      ],
      total: 1,
    },
  ];
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Збережене' }));
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити: Давній збережений матеріал' }));
  expect(screen.getByRole('heading', { name: 'Давній збережений матеріал' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Стежити за подією' })).not.toBeInTheDocument();
  expect(mocks.story).toHaveBeenLastCalledWith(
    expect.objectContaining({
      storyId: 'https://www.bbc.com/news/old',
      version: 'https://www.bbc.com/news/old',
      action: 'read',
    }),
    expect.any(Object),
  );
});
it('hides explanatory prose and the native original-title duplicate by default', () => {
  Object.assign(mocks.live!.groups[0]!.items[0]!, {
    originalTitle: 'Перша подія',
    translationStatus: 'native',
    translated: false,
  });
  const view = mount('/news?article=' + encodeURIComponent('https://www.bbc.com/news/1'));
  expect(screen.queryByText('Оригінальний заголовок')).not.toBeInTheDocument();
  expect(screen.queryByText(/Короткий зміст із/)).not.toBeInTheDocument();
  mocks.explanations = true;
  view.rerenderNews();
  expect(screen.getByText(/Короткий зміст із/)).toBeVisible();
});
it('keeps source errors separate from an expired private session', () => {
  const view = mount();
  mocks.expired = true;
  view.rerenderNews();
  expect(screen.queryByText('Перша подія')).not.toBeInTheDocument();
});
it('searches the current mode and starts an explicit collection request', () => {
  mount();
  fireEvent.click(screen.getByText('Пошук і фільтри'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Пошук у новинах' }), {
    target: { value: 'невідоме' },
  });
  expect(screen.getByText(/Нічого не знайдено/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Оновити новини' }));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
it('uses text cards without fake art and records an explicit less-like-this preference', () => {
  const view = render(
    <NewsItem item={{ title: 'Подія', url: 'https://www.bbc.com/news/a' }} topic="Головне" />,
  );
  expect(view.container.querySelector('.renewal-news-visual')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Менше такого' }));
  expect(mocks.feedback).toHaveBeenCalledWith(
    { url: 'https://www.bbc.com/news/a', kind: 'less' },
    expect.any(Object),
  );
});
it('removes an unavailable photo and can show a replacement', () => {
  const view = render(<NewsArt image="/api/news/image/a" topic="Головне" />);
  fireEvent.error(view.container.querySelector('img')!);
  expect(view.container.querySelector('.renewal-news-art')).toBeNull();
  view.rerender(<NewsArt image="/api/news/image/b" topic="Головне" />);
  expect(view.container.querySelector('img')).toHaveAttribute('src', '/api/news/image/b');
});
