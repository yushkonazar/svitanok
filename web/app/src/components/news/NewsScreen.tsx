import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import {
  useBriefing,
  useSettings,
  useNewsSnapshot,
  useRefreshNews,
  useNewsSeen,
} from '../../api/hooks.ts';
import { isSessionExpired } from '../../api/client.ts';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { readBlock, newsDataSchema, type NewsSnapshot } from '../../api/briefing-schema.ts';
import { NewsItem } from './NewsItem.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { newsSource } from '../../lib/newsSource.ts';
import { newsFeed } from '../../lib/newsFeed.ts';
import { Link } from 'react-router-dom';
import { PageHeading } from '../ui/PageHeading.tsx';
import { NewsArt } from './NewsArt.tsx';
import { useReading, markRead } from '../../lib/reading.ts';
import { useSaved } from '../../saved.tsx';
import { openLink } from '../../telegram.ts';
import { useTick } from '../../lib/useTick.ts';

export function NewsScreen() {
  const nowMs = useTick(60000);
  const read = useReading();
  const { isSaved } = useSaved();
  const [selected, setSelected] = useState<string | null>(null);
  const feedScroll = useRef(0);
  useLayoutEffect(() => {
    window.scrollTo(0, selected ? 0 : feedScroll.current);
  }, [selected]);
  const [readingFilter, setReadingFilter] = useState('Усе');
  const [filter, setFilter] = useState('Усе');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(8);
  const [applied, setApplied] = useState<NewsSnapshot | null>(null);
  const [refreshMessage, setRefreshMessage] = useState('');
  const brief = useBriefing(),
    settings = useSettings(),
    live = useNewsSnapshot(),
    refresh = useRefreshNews();
  const { mutate: markSeen } = useNewsSeen();
  const recordedSeen = useRef(false);
  useEffect(() => {
    if (recordedSeen.current || !live.data?.generatedAt) return;
    recordedSeen.current = true;
    markSeen();
  }, [live.data?.generatedAt, markSeen]);
  // A refreshed snapshot is announced, never inserted beneath a reading finger.
  if (!applied && live.data?.generatedAt) setApplied(live.data);
  const displayed = applied ?? live.data;
  if (isSessionExpired(live.error) || isSessionExpired(refresh.error)) return <SessionExpired />;
  const fallback = readBlock(brief.data?.brief.blocks ?? [], 'news', newsDataSchema);
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
  const feed = newsFeed(
    displayed?.groups ?? fallback?.groups ?? [],
    settings.data?.settings.mutedTopics,
    settings.data?.settings.news?.sources,
  );
  const topics = [...new Set(feed.map((n) => n.topic))];
  const matches = feed.filter(
    (n) =>
      (readingFilter === 'Усе' ||
        (readingFilter === 'Непрочитане' &&
          !read.includes(n.item.changeAt ? `${n.item.url}#${n.item.changeAt}` : n.item.url)) ||
        (readingFilter === 'Збережене' && isSaved('news', n.item.url))) &&
      (filter === 'Усе' || filter === n.topic) &&
      `${n.topic} ${n.item.title} ${n.item.why ?? ''} ${newsSource(n.item.url)}`
        .toLocaleLowerCase('uk-UA')
        .includes(search.trim().toLocaleLowerCase('uk-UA')),
  );
  const article = feed.find((n) => n.item.url === selected);
  const openArticle = (item: (typeof feed)[number]['item']) => {
    feedScroll.current = window.scrollY;
    markRead(item.changeAt ? `${item.url}#${item.changeAt}` : item.url);
    setSelected(item.url);
  };
  if (article)
    return (
      <div className="flex flex-col gap-5">
        <button className="renewal-link self-start" onClick={() => setSelected(null)}>
          ← До стрічки
        </button>
        <PageHeading
          eyebrow={article.topic}
          title="Подія крупним планом."
          accent="Деталі й джерело."
        />
        <article className="renewal-card">
          <NewsArt image={article.item.imageProxy ?? article.item.image} topic={article.topic} />
          <p className="renewal-eyebrow mt-4">
            {newsSource(article.item.url)} ·{' '}
            {article.item.publishedAt
              ? new Date(article.item.publishedAt).toLocaleString('uk-UA', {
                  timeZone: 'Europe/Kyiv',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Час не вказано'}
          </p>
          <h2 className="renewal-article-title">{article.item.title}</h2>
          {article.item.updated && <span className="renewal-pill mt-3">Оновлено джерелом</span>}
          {article.item.translationStatus === 'pending' && (
            <p className="renewal-muted mt-3">
              Переклад тимчасово недоступний · оригінальний заголовок.
            </p>
          )}
          <p className="renewal-news-detail mt-4">
            {article.item.why ||
              'Короткого опису немає. Деталі доступні в оригінальному матеріалі.'}
          </p>
          {article.item.updated && article.item.previousTitle && (
            <details className="renewal-inset mt-4">
              <summary className="font-semibold cursor-pointer">Що змінилося в матеріалі?</summary>
              <p className="renewal-chart-note mt-3">
                {article.item.changeLabel ?? 'Оновлення джерела'}. Порівняння доступних заголовків і
                описів.
              </p>
              <p className="renewal-muted mt-3">Раніше: {article.item.previousTitle}</p>
              {article.item.previousSummary && (
                <p className="renewal-chart-note mt-2">{article.item.previousSummary}</p>
              )}
              <p className="mt-3">Тепер: {article.item.title}</p>
              <p className="renewal-chart-note mt-2">
                {article.item.why ?? 'Новий опис не наданий джерелом.'}
              </p>
            </details>
          )}
          {article.item.originalTitle && (
            <details className="mt-4 renewal-muted">
              <summary>Оригінальний заголовок</summary>
              <p className="mt-2">{article.item.originalTitle}</p>
            </details>
          )}
          {!!article.item.related?.length && (
            <details className="renewal-inset mt-4">
              <summary className="font-semibold cursor-pointer">
                Ще джерела цієї події · {article.item.related.length}
              </summary>
              <div className="flex flex-col gap-3 mt-3">
                {article.item.related.map((n) => (
                  <button
                    key={n.url}
                    className="renewal-link text-left"
                    onClick={() => openLink(n.url)}
                  >
                    {newsSource(n.url)} · відкрити матеріал ↗
                  </button>
                ))}
              </div>
            </details>
          )}
          <p className="renewal-chart-note mt-4">
            Огляд із заголовка й доступного опису джерела. Повна стаття — на сайті видавця.
          </p>
          <button className="renewal-button w-full mt-4" onClick={() => openLink(article.item.url)}>
            Читати в {newsSource(article.item.url)} ↗
          </button>
        </article>
        <div className="renewal-news-footer">
          <NewsItem item={article.item} topic={article.topic} />
        </div>
      </div>
    );
  const newSnapshot = !!live.data?.generatedAt && live.data.attemptedAt !== displayed?.attemptedAt;
  const knownUrls = new Set(feed.map((n) => n.item.url));
  const added =
    live.data?.groups.flatMap((g) => g.items).filter((n) => !knownUrls.has(n.url)).length ?? 0;
  const generatedAt = displayed?.generatedAt ?? brief.data?.brief.generatedAt;
  const sinceLastVisit = displayed?.lastSeenAt
    ? feed.filter(
        (n) =>
          Date.parse(n.item.changeAt ?? n.item.publishedAt ?? '') >
          Date.parse(displayed.lastSeenAt!),
      ).length
    : 0;
  const pending =
    displayed?.localization?.pending ??
    feed.filter((n) => n.item.translationStatus === 'pending').length;
  const dateLabel = generatedAt
    ? new Date(generatedAt).toLocaleString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'ще не зібрана';
  const applyIncoming = () => {
    if (live.data) {
      setApplied(live.data);
      setLimit(8);
    }
  };
  return (
    <div className="news-screen flex flex-col gap-4">
      <PageHeading
        eyebrow="ТВОЯ СТРІЧКА"
        title="Варто"
        accent="знати."
        description="Головні події України й світу. Цікаве — поруч."
        action={
          <button
            className="renewal-secondary"
            disabled={refresh.isPending || live.isFetching}
            aria-label="Оновити новини"
            onClick={() => {
              setRefreshMessage('');
              refresh.mutate(undefined, {
                onSuccess: (result) => {
                  if (result.demo) {
                    setRefreshMessage('Демо-добірка. Живі новини доступні в Telegram.');
                    return;
                  }
                  setRefreshMessage(
                    result.skipped === 'cooldown'
                      ? `Джерела щойно перевірено. Повторний збір — через ${Math.ceil((result.retryAfterSeconds ?? 0) / 60)} хв.`
                      : result.skipped === 'disabled'
                        ? 'Збір новин вимкнено в налаштуваннях.'
                        : result.updated === false
                          ? 'Джерела тимчасово недоступні. Збережено попередню добірку.'
                          : 'Джерела перевірено.',
                  );
                  void live.refetch().then((result) => {
                    if (result.data) setApplied(result.data);
                  });
                },
              });
            }}
          >
            {refresh.isPending ? '…' : '↻'}
          </button>
        }
      />
      <p className="renewal-muted">
        Остання добірка: {dateLabel}. Оновлення кожні{' '}
        {settings.data?.settings.news?.intervalHours ?? 3} год.
      </p>
      {sinceLastVisit > 0 && (
        <p className="renewal-chart-note">{sinceLastVisit} матеріалів від попереднього перегляду</p>
      )}
      {(refreshMessage || refresh.error) && (
        <p role="status" className="renewal-inset renewal-muted">
          {refresh.error?.message ?? refreshMessage}
        </p>
      )}
      {newSnapshot && (
        <button className="renewal-button" onClick={applyIncoming}>
          Оновлена добірка{added ? ` · ${added} нових` : ''} ↓
        </button>
      )}
      {brief.data?.demo && (
        <p className="renewal-inset renewal-muted">
          Демо-добірка. Особисті налаштування й живі новини доступні в Telegram.
        </p>
      )}
      {settings.data?.settings.modules.news === false && (
        <p className="renewal-inset renewal-muted">
          Збір новин вимкнено. Можна читати збережену добірку.
        </p>
      )}
      {pending > 0 && (
        <p className="renewal-muted">
          Переклад очікується для {pending} матеріалів. Вони позначені окремо.
        </p>
      )}
      {displayed?.sources.some((s) => s.enabled !== false && !s.ok) && (
        <p className="renewal-muted">
          Частина джерел тимчасово недоступна; час матеріалів вказано в картках.
        </p>
      )}
      {!brief.data?.demo &&
        generatedAt &&
        nowMs - Date.parse(generatedAt) >
          (settings.data?.settings.news?.intervalHours ?? 3) * 2 * 3600000 && (
          <p className="renewal-inset renewal-muted">
            Добірка застаріла. Нові події можуть ще не потрапити до стрічки.
          </p>
        )}
      {live.error && <p className="renewal-muted">{live.error.message}</p>}
      {feed.some((n) => n.priority === 0) &&
        !search &&
        readingFilter === 'Усе' &&
        filter === 'Усе' && (
          <section className="renewal-card">
            <p className="renewal-eyebrow">ШВИДКО ЗРОЗУМІТИ ДЕНЬ</p>
            <h2 className="text-lg font-semibold mt-2">Головне зараз</h2>
            <p className="renewal-chart-note mt-2">
              До п’яти подій із поточної добірки. Деталі — за натисканням.
            </p>
            <div className="flex flex-col gap-4 mt-4">
              {feed
                .filter((n) => n.priority === 0)
                .slice(0, 5)
                .map(({ item }, i) => (
                  <button
                    key={item.url}
                    className="text-left border-b border-glassb pb-4 last:border-0"
                    aria-label={`Коротко: ${item.title}`}
                    onClick={() => {
                      openArticle(item);
                    }}
                  >
                    <span className="font-semibold block">
                      {i + 1}. {item.title}
                    </span>
                    {item.why && (
                      <span className="renewal-muted text-sm block mt-2">
                        {item.why.length > 180
                          ? item.why.slice(0, 177).replace(/\s+\S*$/, '') + '…'
                          : item.why}
                      </span>
                    )}
                    <span className="renewal-chart-note block mt-2">
                      {newsSource(item.url)}
                      {item.updated ? ' · Оновлення події' : ''}
                    </span>
                  </button>
                ))}
            </div>
          </section>
        )}
      <div className="flex items-center justify-between gap-3">
        <div className="renewal-segments">
          {['Усе', 'Непрочитане', 'Збережене'].map((v) => (
            <button
              key={v}
              className={readingFilter === v ? 'is-active' : ''}
              aria-pressed={readingFilter === v}
              onClick={() => {
                setReadingFilter(v);
                setLimit(8);
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <Link to="/settings" className="renewal-link" aria-label="Налаштувати джерела новин">
          ⚙
        </Link>
      </div>
      <details className="renewal-inset">
        <summary className="cursor-pointer font-semibold text-sm">Пошук і фільтри</summary>
        <div className="flex flex-col gap-3 mt-4">
          <label className="renewal-field">
            <span className="sr-only">Пошук у новинах</span>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(8);
              }}
              placeholder="Знайти у стрічці…"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {['Усе', ...topics].map((t) => (
              <button
                key={t}
                className="renewal-secondary"
                aria-pressed={filter === t}
                style={
                  filter === t
                    ? { color: 'var(--color-a2)', borderColor: 'var(--color-a2)' }
                    : undefined
                }
                onClick={() => {
                  setFilter(t);
                  setLimit(8);
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </details>
      {matches.slice(0, limit).map(({ item, topic, priority }, i) => (
        <article
          key={item.url}
          className="renewal-card"
          style={
            i === 0
              ? {
                  background:
                    'radial-gradient(ellipse at 100% 0%,rgba(255,164,92,.10),transparent 70%),var(--color-bg2)',
                }
              : undefined
          }
        >
          <div className="renewal-section-head mb-3">
            <span className="renewal-eyebrow">{topic}</span>
            {i === 0 && (
              <span className="text-[10px] text-a2">
                {priority === 0 ? 'ВАРТО ЗНАТИ' : 'ЗА ІНТЕРЕСАМИ'}
              </span>
            )}
          </div>
          <NewsItem
            item={item}
            topic={topic}
            featured={i === 0}
            onOpen={() => {
              feedScroll.current = window.scrollY;
              setSelected(item.url);
              markRead(item.changeAt ? `${item.url}#${item.changeAt}` : item.url);
            }}
          />
        </article>
      ))}
      {!matches.length && (
        <p className="renewal-card renewal-muted">
          {search
            ? 'Нічого не знайдено. Спробуй інше слово.'
            : 'Тут поки немає матеріалів. Зміни фільтр або онови добірку.'}
        </p>
      )}
      {matches.length > limit && (
        <button className="renewal-secondary" onClick={() => setLimit((n) => n + 10)}>
          Ще новини · {matches.length - limit}
        </button>
      )}
    </div>
  );
}
