import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CONTENT_TOPICS, contentIdentity } from '../../../../core/brief/daily-content-display.mjs';
import {
  fetchContentArchive,
  fetchContentProfile,
  postContentAction,
  type ContentAction,
  type ContentProfile,
} from '../../api/daily-content.ts';
import type { FactData, StoicData } from '../../api/briefing-schema.ts';
import { textHash } from '../../lib/format.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { SaveButton } from './SaveButton.tsx';

export function useContentProfile() {
  return useQuery({ queryKey: ['dailyContent'], queryFn: fetchContentProfile, staleTime: 300000 });
}
export function ContentFeedback({
  kind,
  item,
}: {
  kind: 'fact' | 'quote';
  item: FactData | StoicData;
}) {
  const { data } = useContentProfile(),
    qc = useQueryClient();
  const id = contentIdentity(item, kind),
    signal = data?.feedback[`${kind}:${id}`];
  const mutation = useMutation({
    mutationFn: postContentAction,
    onSuccess: (_, action: ContentAction) => {
      if (action.type === 'feedback')
        qc.setQueryData<ContentProfile>(['dailyContent'], (old) =>
          old ? { ...old, feedback: { ...old.feedback, [`${kind}:${id}`]: action.signal } } : old,
        );
    },
  });
  return (
    <div className="daily-content-feedback">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['like', 'Цікаво'],
            ['less', 'Менше такого'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={signal === value}
            disabled={!data || mutation.isPending}
            onClick={() =>
              mutation.mutate({
                type: 'feedback',
                kind,
                id,
                date: data!.date,
                signal: signal === value ? 'clear' : value,
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      {mutation.isError && (
        <p className="mt-2 text-sm text-err" role="alert">
          {mutation.error.message}
        </p>
      )}
    </div>
  );
}
export function DailyContentTools() {
  const [open, setOpen] = useState<'archive' | 'topics' | null>(null);
  const { data: profile } = useContentProfile();
  return (
    <>
      <div className="daily-content-tools">
        <button type="button" onClick={() => setOpen('archive')}>
          Архів фактів і цитат ↗
        </button>
        <button type="button" onClick={() => setOpen('topics')}>
          Теми добірки
        </button>
      </div>
      {profile?.status?.state === 'reserve' && (
        <p className="renewal-muted text-xs">
          Нова добірка ще не пройшла перевірку. Сьогодні — матеріал із перевіреного резерву.
        </p>
      )}
      {open && (
        <Sheet
          label={open === 'archive' ? 'Архів фактів і цитат' : 'Теми добірки'}
          onClose={() => setOpen(null)}
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <h2 className="text-xl font-semibold">
              {open === 'archive' ? 'Вже відкриті думки й відкриття' : 'Що тобі цікаво?'}
            </h2>
            <button
              type="button"
              className="renewal-secondary shrink-0"
              aria-label="Закрити"
              onClick={() => setOpen(null)}
            >
              ×
            </button>
          </div>
          {open === 'archive' ? (
            <ContentArchive />
          ) : (
            <ContentTopics onClose={() => setOpen(null)} />
          )}
        </Sheet>
      )}
    </>
  );
}
function ContentTopics({ onClose }: { onClose: () => void }) {
  const { data, isError } = useContentProfile();
  if (!data)
    return (
      <p className="renewal-muted">
        {isError
          ? 'Не вдалося завантажити вподобання. Відкрий це вікно ще раз.'
          : 'Завантажуємо вподобання…'}
      </p>
    );
  return <TopicsForm initial={data.preferences.topics} onClose={onClose} />;
}
function TopicsForm({ initial, onClose }: { initial: string[]; onClose: () => void }) {
  const [topics, setTopics] = useState(initial),
    qc = useQueryClient();
  const save = useMutation({
    mutationFn: postContentAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dailyContent'] });
      onClose();
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="renewal-muted text-sm">
        Вподобання й реакції вплинуть на наступну місячну добірку. Сьогоднішній матеріал залишиться
        тим самим; різноманітність тем збережеться.
      </p>
      <div className="daily-content-topics grid grid-cols-2 gap-2">
        {Object.entries(CONTENT_TOPICS).map(([key, name]) => (
          <button
            type="button"
            className="renewal-secondary"
            key={key}
            aria-pressed={topics.includes(key)}
            onClick={() =>
              setTopics((old) => (old.includes(key) ? old.filter((n) => n !== key) : [...old, key]))
            }
          >
            {name}
          </button>
        ))}
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-err">
          {save.error.message}
        </p>
      )}
      <button
        type="button"
        className="renewal-button"
        disabled={!topics.length || save.isPending}
        onClick={() => save.mutate({ type: 'preferences', preferences: { topics } })}
      >
        Зберегти вподобання
      </button>
      <p className="renewal-muted text-xs">
        Російські автори, джерела й матеріали, пов’язані з Росією, виключені. Стоїцизм — основа
        цитат, поруч із перевіреними думками інших авторів.
      </p>
    </div>
  );
}
function ContentArchive() {
  const query = useInfiniteQuery({
    queryKey: ['dailyContentArchive'],
    queryFn: ({ pageParam }) => fetchContentArchive(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  if (query.isPending) return <p className="renewal-muted">Завантажуємо архів…</p>;
  if (query.isError)
    return (
      <div>
        <p role="alert">{query.error.message}</p>
        <button className="renewal-secondary mt-3" onClick={() => query.refetch()}>
          Спробувати ще раз
        </button>
      </div>
    );
  const items = query.data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      <p className="renewal-muted text-sm">
        Матеріали попередніх опублікованих днів за останні 90 днів. Майбутня добірка залишається
        сюрпризом.
      </p>
      {!items.length && (
        <p className="renewal-muted">
          Архів поступово наповнюється. Сьогоднішній матеріал з’явиться тут завтра.
        </p>
      )}
      {items.map((entry) => (
        <div className="renewal-card daily-archive-entry" key={entry.date}>
          <time className="renewal-muted font-mono text-xs">
            {new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'long' }).format(
              new Date(`${entry.date}T12:00:00Z`),
            )}
          </time>
          {entry.fact && (
            <article>
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold">{entry.fact.title ?? 'Факт дня'}</h3>
                <SaveButton kind="fact" id={textHash(entry.fact.fact)} title={entry.fact.fact} />
              </div>
              <p>{entry.fact.fact}</p>
              <Source url={entry.fact.sourceUrl} name={entry.fact.sourceName} />
            </article>
          )}
          {entry.quote && (
            <article>
              <div className="flex items-start justify-between gap-2">
                <p className="italic">{entry.quote.text}</p>
                <SaveButton
                  kind="quote"
                  id={textHash(`«${entry.quote.text}» — ${entry.quote.author}`)}
                  title={`«${entry.quote.text}» — ${entry.quote.author}`}
                />
              </div>
              <p className="renewal-muted mt-2 text-sm">
                {entry.quote.author} · {entry.quote.translation}
              </p>
              <Source url={entry.quote.sourceUrl} name={entry.quote.reference} />
            </article>
          )}
        </div>
      ))}
      {query.hasNextPage && (
        <button
          className="renewal-secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Завантажуємо…' : 'Попередні дні'}
        </button>
      )}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-sm text-err">
          Не вдалося завантажити попередні дні. Спробуй ще раз.
        </p>
      )}
    </div>
  );
}
function Source({ url, name }: { url?: string; name?: string }) {
  return url?.startsWith('https://') ? (
    <a
      className="renewal-link mt-2 block text-sm"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {name ?? 'Джерело'} ↗
    </a>
  ) : null;
}
