import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewsScreen } from './NewsScreen.tsx';
import { NewsStoryCard } from './NewsStoryCard.tsx';
import { NewsItem } from './NewsItem.tsx';
import { SavedProvider } from '../../saved.tsx';
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
  save: vi.fn(),
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
  useToggleSaveNews: () => ({ mutate: mocks.save, mutateAsync: mocks.save }),
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
      <SavedProvider>
        <MemoryRouter initialEntries={[path]}>
          <NewsScreen />
        </MemoryRouter>
      </SavedProvider>
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
  vi.unstubAllGlobals();
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
it('defaults to all themes by publication time and keeps the two narrower modes', () => {
  mocks.live!.groups.push({
    scope: 'world',
    topic: 'Наука',
    items: [
      {
        title: 'Місія NASA',
        url: 'https://www.nasa.gov/mission',
        priority: 1,
        publishedAt: '2026-11-03T10:30:00Z',
      },
    ],
    more: [],
  });
  mount();
  expect(screen.getByRole('button', { name: 'Стрічка' })).toHaveAttribute('aria-pressed', 'true');
  expect(
    screen.getAllByRole('button', { name: /^Відкрити:/ }).map((button) => button.textContent),
  ).toEqual([expect.stringContaining('Місія NASA'), expect.stringContaining('Перша подія')]);
  fireEvent.click(screen.getByRole('button', { name: 'Головне' }));
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
it('keeps a followed archive stable when that story returns in an unapplied snapshot', () => {
  const archived = {
    storyId: 'archived',
    contentVersion: 'v1',
    title: 'Давня історія про місію',
    url: 'https://www.bbc.com/news/archive',
  };
  mocks.live!.reader!.following.archived = {
    item: archived,
    topic: 'Головне',
    scope: 'world',
    followedAt: '2026-11-02T12:00:00Z',
  };
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Стежу 1' }));
  expect(screen.getByText('Давня історія про місію')).toBeVisible();
  const updated = {
    ...archived,
    contentVersion: 'v2',
    displayVersion: 'new-text',
    title: 'Продовження історії',
  };
  mocks.live = {
    ...snapshot(),
    groups: [{ scope: 'world', topic: 'Головне', items: [updated], more: [] }],
    reader: {
      ...mocks.live!.reader!,
      following: { archived: { ...mocks.live!.reader!.following.archived!, item: updated } },
    },
  };
  view.rerenderNews();
  expect(screen.getByText('Давня історія про місію')).toBeVisible();
  expect(screen.queryByText('Продовження історії')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Оновлена добірка · 1 оновлено/ })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Оновлена добірка/ }));
  expect(screen.getByText('Продовження історії')).toBeVisible();
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
  fireEvent.click(screen.getByText('Пошук і джерела'));
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
  fireEvent.click(screen.getByText('Пошук і джерела'));
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
  const card = (image: string) => (
    <NewsStoryCard
      story={{
        topic: 'Головне',
        priority: 0,
        item: { title: 'Подія з фотографією', url: 'https://www.bbc.com/news/photo', image },
      }}
      read={false}
      change={null}
      following={false}
      onOpen={() => {}}
    />
  );
  const view = render(card('/api/news/image/a'));
  fireEvent.error(view.container.querySelector('img')!);
  expect(view.container.querySelector('.renewal-news-art')).toBeNull();
  expect(view.container.querySelector('.news-story-thumbnail')).toBeNull();
  view.rerender(card('/api/news/image/b'));
  expect(view.container.querySelector('img')).toHaveAttribute('src', '/api/news/image/b');
});

it('shows categories without opening search, scopes counters and clears the category on a mode change', () => {
  mocks.live!.groups.push({
    scope: 'world',
    topic: 'Наука',
    more: [],
    items: [
      {
        title: 'Місія NASA',
        url: 'https://www.nasa.gov/mission',
        priority: 1,
        firstSeenAt: '2026-11-03T10:30:00Z',
      },
    ],
  });
  mount();
  const topics = screen.getByRole('group', { name: 'Категорії новин' });
  expect(within(topics).getByRole('button', { name: 'Світ' })).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(within(topics).getByRole('button', { name: 'Наука' }));
  expect(screen.queryByText('Перша подія')).not.toBeInTheDocument();
  expect(screen.getByText('Місія NASA')).toBeVisible();
  expect(screen.getByRole('button', { name: '1 нова' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Головне' }));
  expect(within(topics).getByRole('button', { name: 'Усе' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(within(topics).queryByRole('button', { name: 'Наука' })).not.toBeInTheDocument();
  expect(screen.getByText('Перша подія')).toBeVisible();
});

it('keeps a disappeared category visible when a new collection is explicitly applied', () => {
  const view = mount();
  const topics = screen.getByRole('group', { name: 'Категорії новин' });
  fireEvent.click(within(topics).getByRole('button', { name: 'Світ' }));
  mocks.live = snapshot('Інша тема', 2);
  mocks.live.groups[0]!.topic = 'Наука';
  view.rerenderNews();
  fireEvent.click(screen.getByRole('button', { name: /Оновлена добірка/ }));
  expect(within(topics).getByRole('button', { name: 'Світ' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByText('Інша тема')).not.toBeInTheDocument();
  fireEvent.click(within(topics).getByRole('button', { name: 'Усе' }));
  expect(screen.getByText('Інша тема')).toBeVisible();
});

it('saves directly from a card without marking it read and rolls back a failed save', async () => {
  mount();
  const save = screen.getByRole('button', { name: 'Зберегти: Перша подія' });
  mocks.save.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(save);
  await waitFor(() => expect(save).toHaveAttribute('aria-pressed', 'false'));
  fireEvent.click(save);
  expect(save).toHaveAttribute('aria-pressed', 'true');
  expect(mocks.save).toHaveBeenLastCalledWith({
    save: true,
    url: 'https://www.bbc.com/news/1',
    title: 'Перша подія',
    category: 'Головне',
  });
  expect(screen.getByRole('heading', { name: 'Новини' })).toBeVisible();
  expect(mocks.story).not.toHaveBeenCalled();
  expect(mocks.feedback).not.toHaveBeenCalled();
});

it('follows directly from a card only after acknowledgement without opening or reading it', () => {
  const view = mount();
  const follow = screen.getByRole('button', { name: 'Стежити за подією: Перша подія' });
  fireEvent.click(follow);
  expect(follow).toHaveAttribute('aria-pressed', 'false');
  expect(mocks.story).toHaveBeenLastCalledWith(
    { type: 'story', storyId: 'event-1', action: 'follow' },
    expect.any(Object),
  );
  mocks.live!.reader!.following['event-1'] = {
    item: mocks.live!.groups[0]!.items[0]!,
    topic: 'Головне',
    scope: 'world',
    followedAt: '2026-11-03T12:00:00Z',
  };
  view.rerenderNews();
  expect(screen.getByRole('button', { name: 'Не стежити за подією: Перша подія' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('heading', { name: 'Новини' })).toBeVisible();
  expect(mocks.story).toHaveBeenCalledTimes(1);
});

it('rolls back a failed card save after the reader has already opened the article', async () => {
  let rejectSave!: (error: Error) => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти: Перша подія' }));
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити: Перша подія' }));
  expect(screen.getByRole('button', { name: 'Збережено' })).toHaveAttribute('aria-pressed', 'true');
  await act(async () => rejectSave(new Error('offline')));
  expect(screen.getByRole('button', { name: 'Зберегти' })).toHaveAttribute('aria-pressed', 'false');
});

it('reveals every available story in batches and ignores callbacks from old observers', () => {
  const callbacks: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  mocks.live!.groups[0]!.items = Array.from({ length: 19 }, (_, index) => ({
    title: `Подія ${index + 1}`,
    url: `https://www.bbc.com/news/batch-${index}`,
    storyId: `batch-${index}`,
  }));
  const view = mount();
  const count = () => view.container.querySelectorAll('.news-story-card').length;
  expect(count()).toBe(6);
  act(() => callbacks[0]!([{ isIntersecting: true }]));
  expect(count()).toBe(12);
  act(() => callbacks[0]!([{ isIntersecting: true }]));
  expect(count()).toBe(12);
  act(() => callbacks.at(-1)!([{ isIntersecting: true }]));
  expect(count()).toBe(18);
  fireEvent.click(screen.getByRole('button', { name: 'Ще події · 1' }));
  expect(count()).toBe(19);
  expect(screen.queryByRole('button', { name: /Ще події/ })).not.toBeInTheDocument();
  act(() => callbacks.at(-1)!([{ isIntersecting: true }]));
  expect(count()).toBe(19);
});
