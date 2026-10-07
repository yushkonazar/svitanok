import type { NewsItem as NewsItemT } from '../../api/briefing-schema.ts';
import { useState } from 'react';
import { useStats, useNewsSnapshot, useNewsFeedback, useToggleSaveNews } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import { postEvent } from '../../api/client.ts';
import { has } from '../../lib/format.ts';
import { NewsArt } from './NewsArt.tsx';
import { openLink, haptic } from '../../telegram.ts';
import { newsSource } from '../../lib/newsSource.ts';
import { timeAgo } from '../../lib/timeAgo.ts';
import { useTick } from '../../lib/useTick.ts';

// Publisher photo or compact text card, with explicit like/less feedback.
// Legacy upvotes supply the initial heart state until a new reaction is recorded.

export function NewsItem({
  item,
  topic,
  featured = false,
  onOpen,
}: {
  item: NewsItemT;
  topic: string;
  featured?: boolean;
  onOpen?: () => void;
}) {
  // Живий тик (раз/хв) — «5 хв» саме старіє на екрані, без рефетчу даних.
  useTick(60_000);
  const { data } = useStats();
  // Лише 'up' підсвічує серце. Легасі-'down' у KV читається як «не лайкнуто»,
  // а не як активна кнопка: дизлайків більше немає, і малювати їх нічим.
  const live = useNewsSnapshot();
  const [localFeedback, setLocalFeedback] = useState<'like' | 'less' | 'clear' | null>(null);
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const feedback = localFeedback ?? live.data?.feedback?.[item.url];
  const liked = feedback ? feedback === 'like' : data?.stats.votes?.[item.url] === 'up';
  const { isSaved, setSaved } = useSaved();
  const saved = isSaved('news', item.url);
  const voteMut = useNewsFeedback();
  const saveMut = useToggleSaveNews();

  const openNews = () => {
    if (onOpen) onOpen();
    else openLink(item.url);
    void postEvent('news_click', { category: topic, url: item.url }).catch(() => {});
  };

  const btn = (
    label: string,
    on: boolean,
    onClick: () => void,
    onBg: string,
    onBrd: string,
    aria: string,
  ) => (
    <button
      type="button"
      aria-label={aria}
      aria-pressed={on}
      onClick={onClick}
      className="grid h-11 w-11 flex-none place-items-center rounded-[10px] border text-sm transition-colors"
      style={{
        background: on ? onBg : 'var(--color-glass)',
        borderColor: on ? onBrd : 'var(--color-glassb)',
      }}
    >
      {/* key={String(on)} — ремоунт емодзі перезапускає pop на КОЖЕН тап. Без
          нього анімація програлась би раз при монтуванні й більше ніколи: CSS
          не рестартує кадри на зміну класу, лише на появу елемента.
          Сам pop лежав у index.css написаний і НЕ ВИКОРИСТАНИЙ ніде — тап у
          серце (головний жест вкладки) досі просто міняв колір. */}
      <span
        key={String(on)}
        className="block"
        style={{ animation: 'pop .28s cubic-bezier(.22,1,.36,1)' }}
      >
        {label}
      </span>
    </button>
  );

  const source = newsSource(item.url);
  const ago = timeAgo(item.publishedAt);
  const image = item.imageProxy ?? item.image;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const hasImage = !!image && failedImage !== image;
  const react = (kind: 'like' | 'less' | 'clear') => {
    if (voteMut.isPending) return;
    const old = localFeedback;
    setLocalFeedback(kind);
    voteMut.mutate(
      { url: item.url, kind },
      {
        onSuccess: (result) => {
          if (!result.demo) setLocalFeedback(null);
        },
        onError: () => setLocalFeedback(old),
      },
    );
    haptic('light');
  };

  return (
    <div
      className={`renewal-news-story ${featured ? 'is-featured' : ''} ${hasImage ? 'has-photo' : 'is-text-only'}`}
    >
      {hasImage && (
        <button
          type="button"
          onClick={openNews}
          className="renewal-news-visual"
          aria-label={`Відкрити: ${item.title}`}
        >
          <NewsArt
            image={image}
            topic={topic}
            compact={!featured}
            onUnavailable={() => setFailedImage(image ?? null)}
          />
        </button>
      )}
      <button
        type="button"
        onClick={openNews}
        className="renewal-news-copy min-w-0 flex-1 text-left"
      >
        {(source || ago) && (
          <span className="mb-0.5 flex items-center gap-1.5 font-mono text-[9.5px] font-semibold text-tx3">
            {source && (
              <span className="rounded-[5px] border border-glassb px-1 py-[1px]">{source}</span>
            )}
            {ago && <span>{ago}</span>}
          </span>
        )}
        <span className="renewal-news-headline">{item.title}</span>
        {item.updated && (
          <span className="renewal-pill mt-2">{item.changeLabel ?? 'Оновлено'}</span>
        )}
        {item.translationStatus === 'pending' && (
          <span className="renewal-muted block mt-2">Переклад очікується · показано оригінал</span>
        )}
        {has(item.why) && <span className="renewal-news-excerpt">{item.why}</span>}
      </button>
      <div className="renewal-news-actions flex flex-none gap-1.5">
        {btn(
          '❤️',
          liked,
          () => {
            react(liked ? 'clear' : 'like');
          },
          'rgba(255,110,122,.16)',
          'var(--color-a1)',
          liked ? 'Прибрати вподобання' : 'Подобається',
        )}
        {btn(
          '🔖',
          saved,
          () => {
            const next = !saved;
            setSaved('news', item.url, next);
            saveMut.mutate(
              { save: next, url: item.url, title: item.title, category: topic },
              { onError: () => setSaved('news', item.url, saved) },
            );
            haptic('success');
          },
          'rgba(255,164,92,.16)',
          'var(--color-a2)',
          saved ? 'Прибрати зі збереженого' : 'Зберегти',
        )}
        <button
          type="button"
          className="renewal-news-less"
          aria-pressed={feedback === 'less'}
          disabled={voteMut.isPending}
          onClick={() => react(feedback === 'less' ? 'clear' : 'less')}
        >
          Менше такого
        </button>
      </div>
      {voteMut.error && (
        <p role="alert" className="renewal-muted">
          Не вдалося зберегти реакцію. Спробуй ще раз.
        </p>
      )}
      {feedback === 'less' && (
        <details className="renewal-news-feedback">
          <summary>Уточнити причину · необов’язково</summary>
          <div className="flex flex-wrap gap-2 mt-3">
            {(
              [
                ['topic', 'Нецікава тема'],
                ['repeat', 'Повтор'],
                ['weak', 'Мало змісту'],
                ['source', 'Джерело'],
              ] as const
            ).map(([reason, label]) => (
              <button
                key={reason}
                disabled={voteMut.isPending}
                aria-pressed={selectedReason === reason}
                className="renewal-secondary"
                onClick={() =>
                  voteMut.mutate(
                    { url: item.url, kind: 'less', reason },
                    { onSuccess: () => setSelectedReason(reason) },
                  )
                }
              >
                {label}
              </button>
            ))}
          </div>
        </details>
      )}
      {item.translated && item.originalTitle && (
        <details className="renewal-news-original">
          <summary aria-label="Показати оригінальний заголовок">EN</summary>
          <span>{item.originalTitle}</span>
        </details>
      )}
    </div>
  );
}
