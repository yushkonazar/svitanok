import { useState } from 'react';
import { useNewsFeedback, useToggleSaveNews, useStats, useNewsSnapshot } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import type { NewsStory } from '../../lib/newsStories.ts';
import { haptic } from '../../telegram.ts';
import { NewsIcon } from './NewsIcon.tsx';
export function NewsActions({
  story,
  following,
  muted,
  busy,
  canFollow = true,
  onFollow,
  onMute,
}: {
  story: NewsStory;
  following: boolean;
  muted: boolean;
  busy: boolean;
  canFollow?: boolean;
  onFollow: () => void;
  onMute: () => void;
}) {
  const { item, topic } = story,
    { isSaved, setSaved } = useSaved(),
    save = useToggleSaveNews(),
    feedback = useNewsFeedback(),
    live = useNewsSnapshot(),
    stats = useStats();
  const [localVote, setVote] = useState<'like' | 'less' | 'clear' | null>(null),
    [localSaved, setLocalSaved] = useState<boolean | null>(null),
    [reason, setReason] = useState<string | null>(null);
  const vote = localVote ?? live.data?.feedback?.[item.url],
    liked = vote ? vote === 'like' : stats.data?.stats.votes?.[item.url] === 'up';
  const saved = localSaved ?? (isSaved('news', item.url) || !!story.knownSaved);
  const react = (kind: 'like' | 'less' | 'clear', why?: 'topic' | 'repeat' | 'weak' | 'source') => {
    if (feedback.isPending) return;
    const old = localVote;
    setVote(kind);
    feedback.mutate(
      { url: item.url, kind, ...(why ? { reason: why } : {}) },
      { onError: () => setVote(old) },
    );
    haptic('light');
  };
  return (
    <div className="news-detail-actions">
      {busy && (
        <p className="news-explanation" role="status">
          Зберігаю…
        </p>
      )}
      <div className="news-action-grid">
        <button
          className="news-action"
          type="button"
          disabled={save.isPending}
          aria-pressed={saved}
          onClick={() => {
            const next = !saved;
            setLocalSaved(next);
            setSaved('news', item.url, next);
            save.mutate(
              { save: next, url: item.url, title: item.title, category: topic },
              {
                onError: () => {
                  setLocalSaved(saved);
                  setSaved('news', item.url, saved);
                },
              },
            );
            haptic('light');
          }}
        >
          <NewsIcon name="bookmark" />
          {saved ? 'Збережено' : 'Зберегти'}
        </button>
        {canFollow && (
          <button
            className="news-action"
            type="button"
            disabled={busy}
            aria-pressed={following}
            onClick={onFollow}
          >
            <NewsIcon name="follow" />
            {following ? 'Стежу' : 'Стежити за подією'}
          </button>
        )}
        {!story.archived && (
          <button
            className="news-action"
            type="button"
            disabled={feedback.isPending}
            aria-pressed={liked}
            onClick={() => react(liked ? 'clear' : 'like')}
          >
            <NewsIcon name="heart" />
            Подобається
          </button>
        )}
        {canFollow && (
          <button
            className="news-action"
            type="button"
            disabled={busy}
            aria-pressed={muted}
            onClick={onMute}
          >
            <NewsIcon name="hide" />
            {muted ? 'Повернути у стрічку' : 'Приглушити на 24 год'}
          </button>
        )}
      </div>
      {!story.archived && (
        <details className="news-secondary-detail">
          <summary>Налаштувати рекомендації</summary>
          <div className="news-feedback-reasons">
            {(
              [
                ['topic', 'Нецікава тема'],
                ['repeat', 'Повтор'],
                ['weak', 'Мало змісту'],
                ['source', 'Не підходить джерело'],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                disabled={feedback.isPending}
                aria-pressed={reason === id}
                onClick={() => {
                  setReason(id);
                  react('less', id);
                }}
                key={id}
              >
                {label}
              </button>
            ))}
            {vote === 'less' && (
              <button
                type="button"
                onClick={() => {
                  setReason(null);
                  react('clear');
                }}
              >
                Скасувати «менше такого»
              </button>
            )}
          </div>
        </details>
      )}
      {(save.error || feedback.error) && (
        <p role="alert" className="news-action-error">
          Не вдалося зберегти дію. Спробуй ще раз.
        </p>
      )}
    </div>
  );
}
