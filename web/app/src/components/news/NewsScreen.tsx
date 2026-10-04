import { useState, useRef, useLayoutEffect } from 'react';
import { useBriefing, useSettings, useNewsSnapshot } from '../../api/hooks.ts';
import { isSessionExpired } from '../../api/client.ts';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { readBlock, newsDataSchema } from '../../api/briefing-schema.ts';
import { isReleaseTopic } from '../../lib/topicKind.ts';
import { NewsItem } from './NewsItem.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { newsSource } from '../../lib/newsSource.ts';
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
  const [limit, setLimit] = useState(12);
  const { data, isLoading, error, refetch, isFetching } = useBriefing();
  const { data: settings } = useSettings();
  const live = useNewsSnapshot();
  if (isSessionExpired(live.error)) return <SessionExpired />;
  if (isLoading) return <LoadingSkeleton />;
  if (error || !data)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Новини недоступні'}
        onRetry={() => refetch()}
      />
    );
  const groups = live.data?.generatedAt
    ? live.data.groups
    : (readBlock(data.brief.blocks, 'news', newsDataSchema)?.groups ?? []);
  const muted = new Set(settings?.settings.mutedTopics ?? []);
  const seen = new Set<string>();
  const muteAliases: Record<string, string> = {
    CS2: 'Кіберспорт',
    'Винаходи й технології': 'Тех/IT',
    Головне: 'Світ',
  };
  const feed = groups
    .filter(
      (g) =>
        !muted.has(g.topic) &&
        !muted.has(muteAliases[g.topic] ?? g.topic) &&
        !isReleaseTopic(g.topic),
    )
    .flatMap((g) => [...g.items, ...g.more].map((item) => ({ item, topic: g.topic })))
    .filter(({ item }) => {
      const allowed = settings?.settings.news?.sources;
      const source = newsSource(item.url);
      if (
        allowed &&
        !allowed.some((name) => source === (name === 'The Guardian' ? 'Guardian' : name))
      )
        return false;
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort(
      (a, b) =>
        (Date.parse(b.item.publishedAt ?? '') || 0) - (Date.parse(a.item.publishedAt ?? '') || 0),
    );
  const topics = [...new Set(feed.map((n) => n.topic))];
  const matches = feed.filter(
    (n) =>
      (readingFilter === 'Усе' ||
        (readingFilter === 'Непрочитане' && !read.includes(n.item.url)) ||
        (readingFilter === 'Збережене' && isSaved('news', n.item.url))) &&
      (filter === 'Усе' || filter === n.topic) &&
      `${n.topic} ${n.item.title} ${n.item.why ?? ''} ${newsSource(n.item.url) ?? ''}`
        .toLocaleLowerCase('uk-UA')
        .includes(search.trim().toLocaleLowerCase('uk-UA')),
  );
  const article = feed.find((n) => n.item.url === selected);
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
          <NewsArt image={article.item.image} topic={article.topic} />
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
          <p className="renewal-muted mt-4">
            {article.item.why ||
              'Короткого опису немає. Деталі доступні в оригінальному матеріалі.'}
          </p>
          {article.item.originalTitle && (
            <details className="mt-4 renewal-muted">
              <summary>Оригінальний заголовок</summary>
              <p>{article.item.originalTitle}</p>
            </details>
          )}
          <p className="renewal-chart-note mt-4">
            Короткий огляд із заголовка та опису джерела. Повна стаття відкривається на сайті
            видавця.
          </p>
          <button className="renewal-button w-full mt-4" onClick={() => openLink(article.item.url)}>
            Читати в {newsSource(article.item.url) ?? 'джерелі'} ↗
          </button>
        </article>
        <div className="renewal-news-footer">
          <NewsItem item={article.item} topic={article.topic} />
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <PageHeading
        eyebrow="ТВОЯ СТРІЧКА"
        title="Варто"
        accent="знати."
        action={
          <button
            className="renewal-secondary"
            disabled={isFetching || live.isFetching}
            onClick={() => {
              void refetch();
              void live.refetch();
            }}
            aria-label="Оновити новини"
          >
            ↻
          </button>
        }
      />
      <p className="renewal-muted">
        Джерела, час і головне — в одному місці. Остання збірка:{' '}
        {new Date(live.data?.generatedAt ?? data.brief.generatedAt).toLocaleString('uk-UA', {
          timeZone: 'Europe/Kyiv',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}
        .
      </p>
      {settings?.settings.modules.news === false && (
        <p className="renewal-inset renewal-muted">
          Збір новин вимкнено. Можна читати збережену добірку; увімкнути оновлення — у
          налаштуваннях.
        </p>
      )}
      {live.data && settings?.settings.modules.news !== false && (
        <p className="renewal-muted">
          Збірка кожні {settings?.settings.news?.intervalHours ?? 3} год. · українські заголовки й
          короткі перекази.
          {live.data.localization &&
          live.data.localization.translated < live.data.localization.total
            ? ' Частина матеріалів поки мовою джерела — переклад тимчасово недоступний.'
            : ''}
          {live.data.sources.some((s) => !s.ok) ? ' Частина джерел тимчасово недоступна.' : ''}
        </p>
      )}
      {!data.demo &&
        nowMs - Date.parse(live.data?.generatedAt ?? data.brief.generatedAt) >
          (settings?.settings.news?.intervalHours ?? 3) * 2 * 3600000 && (
          <p className="renewal-inset renewal-muted">
            Збірка застаріла. Час публікації вказано для кожного матеріалу; нові події можуть ще не
            потрапити до стрічки.
          </p>
        )}
      {live.error && <p className="renewal-muted">{live.error.message}</p>}
      {data.demo && (
        <div className="renewal-inset renewal-muted">
          Демонстраційні заголовки для перегляду інтерфейсу. Це не актуальні новини.
        </div>
      )}
      <div className="renewal-section-head">
        <div className="renewal-segments">
          {['Усе', 'Непрочитане', 'Збережене'].map((v) => (
            <button
              key={v}
              className={readingFilter === v ? 'is-active' : ''}
              aria-pressed={readingFilter === v}
              onClick={() => {
                setReadingFilter(v);
                setLimit(12);
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
      <label className="renewal-field">
        <span className="sr-only">Пошук у новинах</span>
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(12);
          }}
          placeholder="Знайти у стрічці…"
        />
      </label>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {['Усе', ...topics].map((t) => (
          <button
            key={t}
            className="renewal-secondary whitespace-nowrap"
            style={
              filter === t
                ? { color: 'var(--color-a2)', borderColor: 'var(--color-a2)' }
                : undefined
            }
            aria-pressed={filter === t}
            onClick={() => {
              setFilter(t);
              setLimit(12);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {matches.slice(0, limit).map(({ item, topic }, i) => (
        <article
          key={item.url}
          className="renewal-card"
          style={
            i === 0
              ? {
                  background:
                    'radial-gradient(ellipse at 100% 0%,rgba(255,164,92,.12),transparent 70%),var(--color-bg2)',
                }
              : undefined
          }
        >
          <div className="renewal-section-head mb-3">
            <span className="renewal-eyebrow">{topic}</span>
            {i === 0 && <span className="text-[10px] text-a2">НАЙНОВІШЕ</span>}
          </div>
          <NewsItem
            item={item}
            topic={topic}
            featured={i === 0}
            onOpen={() => {
              feedScroll.current = window.scrollY;
              setSelected(item.url);
              markRead(item.url);
            }}
          />
        </article>
      ))}
      {!matches.length && (
        <div className="renewal-card renewal-muted">
          {search
            ? 'Нічого не знайдено. Спробуй інше слово.'
            : 'Стрічка поки порожня. Перевір налаштування інтересів або онови пізніше.'}
        </div>
      )}
      {matches.length > limit && (
        <button className="renewal-secondary" onClick={() => setLimit((n) => n + 12)}>
          Ще новини · {matches.length - limit}
        </button>
      )}
    </div>
  );
}
