import { useState } from 'react';
import { useToggleSaveNews } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import { haptic } from '../../telegram.ts';
import type { NewsStory } from '../../lib/newsStories.ts';
import { NewsIcon } from './NewsIcon.tsx';

export function NewsSaveButton({
  story,
  compact = false,
}: {
  story: NewsStory;
  compact?: boolean;
}) {
  const { item, topic } = story,
    { isSaved, setSaved } = useSaved(),
    save = useToggleSaveNews();
  const [localSaved, setLocalSaved] = useState<boolean | null>(null);
  const saved = localSaved ?? (isSaved('news', item.url) || !!story.knownSaved);
  return (
    <>
      <button
        className="news-action"
        type="button"
        disabled={save.isPending}
        aria-pressed={saved}
        aria-label={
          compact ? `${saved ? 'Прибрати зі збереженого' : 'Зберегти'}: ${item.title}` : undefined
        }
        onClick={async () => {
          const next = !saved;
          setLocalSaved(next);
          setSaved('news', item.url, next);
          haptic('light');
          try {
            await save.mutateAsync({
              save: next,
              url: item.url,
              title: item.title,
              category: topic,
            });
          } catch {
            // The shared saved state must roll back even if the reader opened the article
            // and this card unmounted while the request was in flight.
            setLocalSaved(saved);
            setSaved('news', item.url, saved);
          }
        }}
      >
        <NewsIcon name="bookmark" />
        {saved ? 'Збережено' : 'Зберегти'}
      </button>
      {save.error && (
        <p role="alert" className="news-action-error">
          Не вдалося зберегти дію. Спробуй ще раз.
        </p>
      )}
    </>
  );
}
