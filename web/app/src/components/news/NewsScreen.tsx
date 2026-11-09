import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useBriefing,
  useSettings,
  useNewsSnapshot,
  useRefreshNews,
  useNewsSeen,
  useNewsStoryAction,
  useSavedArchive,
} from '../../api/hooks.ts';
import { isSessionExpired } from '../../api/client.ts';
import { readBlock, newsDataSchema, type NewsSnapshot } from '../../api/briefing-schema.ts';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { UpdatedValue } from '../ui/UpdatedValue.tsx';
import { PageHeading } from '../ui/PageHeading.tsx';
import { newsSource } from '../../lib/newsSource.ts';
import {
  EMPTY_NEWS_READER,
  newsStories,
  newsStoryId,
  newsStoryVersion,
  newsWasRead,
  newsChange,
  newsContext,
  newsReadKey,
  newsSnapshotKey,
  readNewsView,
  saveNewsView,
  newsTopicLabel,
  type NewsStory,
  type NewsView,
} from '../../lib/newsStories.ts';
import { useReading, markRead } from '../../lib/reading.ts';
import { usePresentation } from '../../lib/presentation.ts';
import { useSaved } from '../../saved.tsx';
import { openLink } from '../../telegram.ts';
import { useTick } from '../../lib/useTick.ts';
import { pluralUk } from '../../lib/plural.ts';
import { NewsArt } from './NewsArt.tsx';
import { NewsStoryCard } from './NewsStoryCard.tsx';
import { NewsActions } from './NewsActions.tsx';
import { NewsComparison } from './NewsComparison.tsx';
import { NewsIcon } from './NewsIcon.tsx';
import { NewsLoadMore } from './NewsLoadMore.tsx';
import './news-reader.css';

const dateLabel = (iso?: string | null) =>
  iso && Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
const modes = [
  ['all', 'Стрічка'],
  ['main', 'Головне'],
  ['interests', 'За інтересами'],
  ['following', 'Стежу'],
] as const;
const newLabel = (count: number) => `${count} ${pluralUk(count, ['нова', 'нові', 'нових'])}`;
const topicOrder = ['Україна', 'Світ', 'Технології', 'Наука', 'CS2', 'Футбол'];

export function NewsScreen() {
  const nowMs = useTick(60000),
    localRead = useReading(),
    { explanations } = usePresentation();
  const qc = useQueryClient(),
    { isSaved } = useSaved();
  const [params, setParams] = useSearchParams(),
    selected = params.get('article');
  const [view, setView] = useState(readNewsView),
    [limit, setLimit] = useState(view.limit);
  const [showMuted, setShowMuted] = useState(false);
  const loadMore = useCallback(() => setLimit((value) => value + 6), []);
  const [filtersOpen, setFiltersOpen] = useState(!!view.search);
  const [applied, setApplied] = useState<NewsSnapshot | null>(
    () => qc.getQueryData<NewsSnapshot>(['newsDisplayed']) ?? null,
  );
  const [opened, setOpened] = useState<NewsStory | null>(null);
  const [message, setMessage] = useState(''),
    [syncError, setSyncError] = useState(false);
  const brief = useBriefing(),
    settings = useSettings(),
    live = useNewsSnapshot(),
    refresh = useRefreshNews();
  const archive = useSavedArchive(view.filter === 'saved'),
    action = useNewsStoryAction(),
    readAction = useNewsStoryAction();
  const { mutate: mutateStory } = readAction;
  const { mutate: markSeen } = useNewsSeen();
  const [visit, setVisit] = useState<{ captured: boolean; since: string | null }>({
    captured: false,
    since: null,
  });
  if (!visit.captured && live.data?.generatedAt)
    setVisit({ captured: true, since: live.data.lastSeenAt ?? null });
  // Initial data becomes the displayed snapshot once. Later data needs an explicit apply.
  if (!applied && live.data?.generatedAt) setApplied(live.data);
  useEffect(() => {
    if (applied) qc.setQueryData(['newsDisplayed'], applied);
  }, [applied, qc]);
  const recordedSeen = useRef(false);
  useEffect(() => {
    if (recordedSeen.current || !live.data?.generatedAt) return;
    recordedSeen.current = true;
    markSeen();
  }, [live.data?.generatedAt, markSeen]);
  const displayed = applied ?? live.data,
    fallback = readBlock(brief.data?.brief.blocks ?? [], 'news', newsDataSchema);
  const groups = displayed?.groups ?? fallback?.groups ?? [];
  const signature = newsSnapshotKey(groups),
    feedScroll = useRef(view.scroll),
    lastSignature = useRef(view.snapshot);
  useLayoutEffect(() => {
    if (!signature) {
      window.scrollTo(0, 0);
      return;
    }
    if (lastSignature.current !== signature && signature) feedScroll.current = 0;
    lastSignature.current = signature;
    window.scrollTo(0, selected ? 0 : feedScroll.current);
  }, [selected, signature]);
  useEffect(() => {
    if (!signature) return;
    const persist = () => {
      if (!selected) feedScroll.current = window.scrollY;
      saveNewsView({ ...view, limit, snapshot: signature, scroll: feedScroll.current });
    };
    window.addEventListener('scroll', persist, { passive: true });
    persist();
    return () => {
      window.removeEventListener('scroll', persist);
    };
  }, [view, limit, selected, signature]);
  const reader = live.data?.reader ?? displayed?.reader ?? EMPTY_NEWS_READER;
  const all = newsStories(groups),
    feed = newsStories(
      groups,
      settings.data?.settings.mutedTopics,
      settings.data?.settings.news?.sources,
    );
  const byId = new Map(all.map((story) => [newsStoryId(story.item), story]));
  const followed = Object.entries(reader.following).map(([id, saved]): NewsStory => {
    const frozen = displayed?.reader?.following[id] ?? saved;
    return (
      byId.get(id) ?? {
        item: frozen.item,
        topic: frozen.topic,
        priority: frozen.item.priority ?? 1,
        archived: true,
      }
    );
  });
  const saved = new Map(
    all.filter((story) => isSaved('news', story.item.url)).map((story) => [story.item.url, story]),
  );
  for (const page of archive.data?.pages ?? [])
    for (const item of page.items) {
      if (item.kind !== 'news' || !item.url || saved.has(item.url)) continue;
      const current = all.find((story) => story.item.url === item.url);
      saved.set(
        item.url,
        current
          ? { ...current, knownSaved: true }
          : {
              item: { title: item.title, url: item.url },
              topic: 'Збережене',
              priority: 1,
              archived: true,
              knownSaved: true,
            },
      );
    }
  const stories =
    view.filter === 'saved'
      ? [...saved.values()]
      : view.mode === 'following'
        ? followed
        : view.mode === 'all'
          ? [...feed].sort(
              (a, b) =>
                (Date.parse(b.item.publishedAt ?? '') || 0) -
                (Date.parse(a.item.publishedAt ?? '') || 0),
            )
          : feed.filter((story) => story.priority === (view.mode === 'main' ? 0 : 1));
  const isMuted = (story: NewsStory) =>
    Date.parse(reader.mutedUntil[newsStoryId(story.item)] ?? '') > nowMs;
  const isRead = (story: NewsStory) => newsWasRead(story.item, reader, localRead);
  const change = (story: NewsStory) => newsChange(story.item, visit.since, isRead(story));
  const mutedCount = stories.filter(isMuted).length;
  const topics = [...new Set(stories.map((story) => story.topic))];
  // A refreshed collection may no longer contain the previous category. Keep it visible
  // until the reader chooses another one, rather than leaving an invisible active filter.
  if (view.topic !== 'Усе' && !topics.includes(view.topic)) topics.push(view.topic);
  topics.sort((a, b) => {
    const order = (topic: string) => {
      const index = topicOrder.indexOf(newsTopicLabel(topic));
      return index < 0 ? topicOrder.length : index;
    };
    return order(a) - order(b) || a.localeCompare(b, 'uk-UA');
  });
  const filteredStories = stories.filter(
    (story) =>
      (showMuted || !isMuted(story)) &&
      (view.topic === 'Усе' || story.topic === view.topic) &&
      `${story.topic} ${newsTopicLabel(story.topic)} ${story.item.title} ${story.item.why ?? ''} ${newsSource(story.item.url)}`
        .toLocaleLowerCase('uk-UA')
        .includes(view.search.trim().toLocaleLowerCase('uk-UA')),
  );
  const matches = filteredStories.filter((story) => view.filter !== 'new' || !!change(story));
  const newCount = filteredStories.filter(
    (story) => !isMuted(story) && change(story) === 'new',
  ).length;
  const updateCount = filteredStories.filter(
    (story) => !isMuted(story) && change(story) === 'updated',
  ).length;
  const currentArticle = [...all, ...followed, ...saved.values()].find(
    (story) => story.item.url === selected,
  );
  const article = currentArticle ?? (opened?.item.url === selected ? opened : null);
  const setSelected = (url: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (url) next.set('article', url);
        else next.delete('article');
        return next;
      },
      { replace: true },
    );
  const syncRead = (story: NewsStory) => {
    markRead(newsReadKey(story.item));
    setSyncError(false);
    mutateStory(
      {
        type: 'story',
        storyId: newsStoryId(story.item),
        version: newsStoryVersion(story.item),
        action: 'read',
      },
      {
        onError: () => setSyncError(true),
      },
    );
  };
  const syncedArticle = useRef('');
  useEffect(() => {
    if (!article || !selected) {
      syncedArticle.current = '';
      return;
    }
    const key = newsReadKey(article.item);
    if (syncedArticle.current === key) return;
    syncedArticle.current = key;
    markRead(key);
    mutateStory(
      {
        type: 'story',
        storyId: newsStoryId(article.item),
        version: newsStoryVersion(article.item),
        action: 'read',
      },
      { onError: () => setSyncError(true) },
    );
  }, [selected, article, mutateStory]);
  const openArticle = (story: NewsStory) => {
    feedScroll.current = window.scrollY;
    setOpened(story);
    setSyncError(false);
    setSelected(story.item.url);
  };
  const changeView = (patch: Partial<NewsView>) => {
    setMessage('');
    feedScroll.current = 0;
    window.scrollTo(0, 0);
    setView((current) => ({ ...current, ...patch }));
    setLimit(6);
  };
  const storyAction = (story: NewsStory, kind: 'follow' | 'unfollow' | 'mute' | 'unmute') => {
    setMessage('');
    action.mutate(
      { type: 'story', storyId: newsStoryId(story.item), action: kind },
      {
        onSuccess: () =>
          setMessage(
            kind === 'mute'
              ? 'Подію приховано на 24 години.'
              : kind === 'unmute'
                ? 'Подію повернуто у стрічку.'
                : kind === 'follow'
                  ? 'Подію додано до «Стежу».'
                  : 'Стеження вимкнено.',
          ),
        onError: (error) => setMessage(error.message),
      },
    );
  };
  if (
    [live.error, refresh.error, action.error, readAction.error, archive.error].some(
      isSessionExpired,
    )
  )
    return <SessionExpired />;
  if (!displayed && !fallback && (brief.isLoading || live.isLoading)) return <LoadingSkeleton />;
  if (!displayed && !fallback)
    return (
      <ErrorState
        message="Не вдалося завантажити новини"
        onRetry={() => {
          void live.refetch();
          void brief.refetch();
        }}
      />
    );
  if (selected && !article)
    return (
      <div className="news-reader">
        <button type="button" className="news-back" onClick={() => setSelected(null)}>
          <NewsIcon name="back" />
          До стрічки
        </button>
        <p className="renewal-card renewal-muted">
          Цього матеріалу вже немає в поточній добірці. Перевір збережене або повернися до стрічки.
        </p>
      </div>
    );
  if (article) {
    const { item, topic } = article,
      id = newsStoryId(item),
      context = newsContext(item.title, item.why ?? '', 700);
    const canFollow = !article.archived || !!reader.following[id];
    return (
      <div className="news-reader news-detail">
        <button
          type="button"
          className="news-back"
          onClick={() => {
            setMessage('');
            setSelected(null);
          }}
        >
          <NewsIcon name="back" />
          До стрічки
        </button>
        <article className="news-detail-article">
          <p className="news-detail-meta">
            {newsSource(item.url)}
            {dateLabel(item.publishedAt) && (
              <>
                {' '}
                · <time dateTime={item.publishedAt}>{dateLabel(item.publishedAt)}</time>
              </>
            )}
            <span>{newsTopicLabel(topic)}</span>
          </p>
          <h1>{item.title}</h1>
          {item.translationStatus === 'pending' && (
            <p className="news-notice">Переклад поки недоступний — показано оригінал.</p>
          )}
          <NewsArt image={item.imageProxy ?? item.image} topic={topic} />
          {context && <p className="news-detail-context">{context}</p>}
          <NewsComparison item={item} />
          {!!item.related?.length && (
            <details className="news-secondary-detail">
              <summary>Інші матеріали про подію · {item.related.length}</summary>
              <div className="news-related">
                {item.related.map((related) => (
                  <button key={related.url} type="button" onClick={() => openLink(related.url)}>
                    <span>{related.title}</span>{' '}
                    <small>
                      {newsSource(related.url)}
                      {dateLabel(related.publishedAt) ? ` · ${dateLabel(related.publishedAt)}` : ''}
                      <NewsIcon name="arrow" />
                    </small>
                  </button>
                ))}
              </div>
            </details>
          )}
          {item.originalTitle && item.translated && item.originalTitle !== item.title && (
            <details className="news-secondary-detail">
              <summary>Оригінальний заголовок</summary>
              <p className="news-original">{item.originalTitle}</p>
            </details>
          )}
          {explanations && (
            <p className="news-explanation">
              Короткий зміст із доступного опису джерела. Повний матеріал — на сайті видання.
              Відкриття не впливає на твої вподобання.
            </p>
          )}
          <button
            type="button"
            className="renewal-button news-source-button"
            onClick={() => openLink(item.url)}
          >
            Читати в {newsSource(item.url)}
            <NewsIcon name="arrow" />
          </button>
        </article>
        <NewsActions
          key={id}
          story={article}
          following={!!reader.following[id]}
          muted={isMuted(article)}
          busy={action.isPending}
          canFollow={canFollow}
          onFollow={() => storyAction(article, reader.following[id] ? 'unfollow' : 'follow')}
          onMute={() => storyAction(article, isMuted(article) ? 'unmute' : 'mute')}
        />
        {message && (
          <p className="news-notice" role="status">
            {message}
          </p>
        )}
        {syncError && (
          <p className="news-notice" role="status">
            Прочитання збережено на цьому пристрої.{' '}
            <button type="button" className="renewal-link" onClick={() => syncRead(article)}>
              Повторити синхронізацію
            </button>
          </p>
        )}
      </div>
    );
  }
  const incoming = !!live.data?.generatedAt && newsSnapshotKey(live.data.groups) !== signature;
  const knownStories = new Map(
    [...all, ...followed].map((story) => [newsStoryId(story.item), story]),
  );
  const incomingCounts = newsStories(live.data?.groups ?? []).reduce(
    (counts, story) => {
      const old = knownStories.get(newsStoryId(story.item));
      if (!old) {
        const boundary = Date.parse(displayed?.generatedAt ?? ''),
          first = Date.parse(story.item.firstSeenAt ?? '');
        if (!Number.isFinite(first) || !Number.isFinite(boundary) || first > boundary)
          counts.added++;
        else if (Date.parse(story.item.changeAt ?? '') > boundary) counts.updated++;
      } else if (newsStoryVersion(old.item) !== newsStoryVersion(story.item)) counts.updated++;
      return counts;
    },
    { added: 0, updated: 0 },
  );
  const metadata =
    live.data && newsSnapshotKey(live.data.groups) === signature ? live.data : displayed;
  const generated = metadata?.generatedAt ?? brief.data?.brief.generatedAt;
  const applyIncoming = () => {
    if (live.data) {
      feedScroll.current = 0;
      setApplied(live.data);
      setLimit(6);
    }
  };
  const refreshFeed = () => {
    setMessage('');
    refresh.mutate(undefined, {
      onSuccess: (result) => {
        setMessage(
          result.demo
            ? 'Демо-добірка. Живі новини доступні в Telegram.'
            : result.skipped === 'cooldown'
              ? `Джерела щойно перевірено. Наступна перевірка — через ${Math.ceil((result.retryAfterSeconds ?? 0) / 60)} хв.`
              : result.skipped === 'disabled'
                ? 'Збір новин вимкнено в налаштуваннях.'
                : result.updated === false
                  ? 'Джерела недоступні. Показано попередню добірку.'
                  : 'Джерела перевірено.',
        );
        void live.refetch();
      },
    });
  };
  const edition = generated ? `Добірка · ${dateLabel(generated)}` : 'Остання доступна добірка';
  return (
    <div className="news-reader">
      <PageHeading
        compact
        eyebrow="Новини"
        title="Світ у русі."
        accent="Поглянь ширше."
        description={brief.data?.demo ? `Демо · ${edition}` : edition}
        action={
          <button
            type="button"
            className="news-refresh"
            aria-label="Оновити новини"
            disabled={refresh.isPending || live.isFetching}
            onClick={refreshFeed}
          >
            <NewsIcon name="refresh" />
          </button>
        }
      />
      {explanations && (
        <p className="news-explanation">
          Стрічка об’єднує всі твої теми за часом публікації. У «Головне» — пріоритетні події, в
          «Інтереси» — тематичні матеріали.
        </p>
      )}
      <div className="news-modes" aria-label="Режим новин">
        {modes.map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-label={
              id === 'following' && followed.length ? `${label} ${followed.length}` : label
            }
            aria-pressed={view.mode === id && view.filter !== 'saved'}
            onClick={() => changeView({ mode: id, filter: 'all', topic: 'Усе' })}
          >
            {id === 'interests' ? 'Інтереси' : label}
            {id === 'following' && followed.length > 0 && <span> {followed.length}</span>}
          </button>
        ))}
      </div>
      <div className="news-topic-filters" role="group" aria-label="Категорії новин">
        {['Усе', ...topics].map((topic) => (
          <button
            type="button"
            key={topic}
            aria-pressed={view.topic === topic}
            onClick={() => changeView({ topic })}
          >
            {newsTopicLabel(topic)}
          </button>
        ))}
      </div>
      <div className="news-toolbar">
        <button
          type="button"
          className="news-unread-filter"
          aria-pressed={view.filter === 'new'}
          onClick={() => changeView({ filter: view.filter === 'new' ? 'all' : 'new' })}
        >
          <UpdatedValue value={newCount + updateCount} identity={view.mode}>
            {newCount > 0 ? newLabel(newCount) : 'Нове'}
            {updateCount > 0 ? ` · ${updateCount} оновлено` : ''}
          </UpdatedValue>
        </button>
        <button
          type="button"
          className="news-saved-filter"
          aria-pressed={view.filter === 'saved'}
          onClick={() =>
            changeView({ filter: view.filter === 'saved' ? 'all' : 'saved', topic: 'Усе' })
          }
        >
          <NewsIcon name="bookmark" />
          Збережене
        </button>
        <button
          type="button"
          className="news-search-toggle"
          aria-expanded={filtersOpen}
          aria-controls="news-filters"
          data-active={!!view.search}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <NewsIcon name={filtersOpen ? 'close' : 'search'} />
          <span className="sr-only">Пошук і джерела</span>
        </button>
      </div>
      {incoming && (
        <button type="button" className="news-incoming" onClick={applyIncoming}>
          Оновлена добірка{incomingCounts.added ? ` · ${newLabel(incomingCounts.added)}` : ''}
          {incomingCounts.updated ? ` · ${incomingCounts.updated} оновлено` : ''}
          <span>Показати ↓</span>
        </button>
      )}
      {(message || refresh.error) && (
        <p className="news-notice" role="status">
          {refresh.error?.message ?? message}
        </p>
      )}
      {live.error && (
        <p className="news-notice" role="status">
          Не вдалося перевірити нові події. Показано останню добірку.
        </p>
      )}
      {settings.data?.settings.modules.news === false && (
        <p className="news-notice">Збір вимкнено. Доступна попередня добірка.</p>
      )}
      {!brief.data?.demo &&
        generated &&
        nowMs - Date.parse(generated) >
          (settings.data?.settings.news?.intervalHours ?? 3) * 2 * 3600000 && (
          <p className="news-notice">Добірка застаріла — перевір оновлення.</p>
        )}
      {filtersOpen && (
        <div id="news-filters" className="news-filter-content">
          <label className="renewal-field">
            <span className="sr-only">Пошук у новинах</span>
            <input
              value={view.search}
              maxLength={200}
              onChange={(event) => changeView({ search: event.target.value })}
              placeholder="Знайти у стрічці…"
            />
          </label>
          {mutedCount > 0 && (
            <label className="news-muted-control">
              <input
                type="checkbox"
                checked={showMuted}
                onChange={(event) => setShowMuted(event.target.checked)}
              />
              Показати приглушені · {mutedCount}
            </label>
          )}
          <Link to="/settings" className="renewal-link">
            Налаштувати джерела →
          </Link>
          {displayed?.sources.some((source) => source.enabled !== false && !source.ok) && (
            <p className="news-explanation">
              Частина джерел тимчасово недоступна. Добірка містить доступні матеріали.
            </p>
          )}
        </div>
      )}
      {view.filter === 'saved' && archive.isLoading && !matches.length ? (
        <LoadingSkeleton />
      ) : (
        <div className="news-story-list">
          {matches.slice(0, limit).map((story) => (
            <NewsStoryCard
              key={newsStoryId(story.item)}
              story={story}
              read={isRead(story)}
              change={view.filter === 'saved' ? null : change(story)}
              following={!!reader.following[newsStoryId(story.item)]}
              busy={action.isPending}
              onFollow={
                !story.archived || reader.following[newsStoryId(story.item)]
                  ? () =>
                      storyAction(
                        story,
                        reader.following[newsStoryId(story.item)] ? 'unfollow' : 'follow',
                      )
                  : undefined
              }
              onOpen={() => openArticle(story)}
            />
          ))}
        </div>
      )}
      {!matches.length && !(view.filter === 'saved' && archive.isLoading) && (
        <p className="news-empty">
          {view.search
            ? 'Нічого не знайдено. Спробуй інше слово.'
            : view.filter === 'new'
              ? 'Нових подій у цьому режимі немає.'
              : view.filter === 'saved'
                ? 'Збережи матеріал, щоб повернутися до нього.'
                : mutedCount > 0 && !showMuted
                  ? 'Події тимчасово приглушені.'
                  : view.mode === 'following'
                    ? 'Натисни «Стежити» на картці події. Її оновлення збиратимуться тут.'
                    : 'Тут поки немає матеріалів. Зміни фільтр або перевір оновлення.'}
          {!view.search && mutedCount > 0 && !showMuted && (
            <button
              type="button"
              className="renewal-link block mt-2 min-h-11"
              onClick={() => {
                setFiltersOpen(true);
                setShowMuted(true);
              }}
            >
              Показати приглушені події
            </button>
          )}
        </p>
      )}
      {matches.length > limit && (
        <NewsLoadMore
          key={`${view.mode}:${view.filter}:${view.topic}:${view.search}`}
          remaining={matches.length - limit}
          onMore={loadMore}
        />
      )}
      {view.filter === 'saved' && archive.hasNextPage && (
        <button
          type="button"
          className="renewal-secondary"
          disabled={archive.isFetchingNextPage}
          onClick={() => void archive.fetchNextPage()}
        >
          {archive.isFetchingNextPage ? 'Завантаження…' : 'Завантажити давніші збереження'}
        </button>
      )}
      {view.filter === 'saved' && archive.error && (
        <p className="news-notice">
          Не вдалося завантажити архів.{' '}
          <button type="button" className="renewal-link" onClick={() => void archive.refetch()}>
            Спробувати ще раз
          </button>
        </p>
      )}
    </div>
  );
}
