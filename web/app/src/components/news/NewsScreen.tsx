import { useState } from 'react';
import { useBriefing, useSettings } from '../../api/hooks.ts';
import { readBlock, newsDataSchema, type NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { LoadingSkeleton, ErrorState, EmptyState } from '../ui/states.tsx';
import { Segmented } from '../ui/Segmented.tsx';
import { DigestCard } from './DigestCard.tsx';
import { TopicChipRow } from './TopicChipRow.tsx';
import { NewsBentoTile, MutedNewsTile } from './NewsBentoTile.tsx';
import { TopicSheet } from './TopicSheet.tsx';

// Вкладка «Новини» (редизайн: інтерактивні блоки замість рядків) — дайджест
// топ-подій зверху, сегмент 🌍 Світ/🇺🇦 Україна, ряд тем-чіпів (усі теми
// регіону, і приглушені теж — притлумлені), bento-сітка активних тем із
// лідер-новиною одразу в плитці, тап відкриває Sheet із повним списком.
// Регіон-фільтр — той самий g.scope===scope, що й раніше: щойно тема без
// країни (Кіберспорт/Футбол/Релізи) отримала scope:'world' у config.yml,
// вона сама лишається лише в Світі, нічого зайвого фільтрувати не треба.

type Scope = 'world' | 'ua';

const SCOPES = [
  { id: 'world', label: '🌍 Світ' },
  { id: 'ua', label: '🇺🇦 Україна' },
] as const;

const NewsIcon = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--color-tx3)" strokeWidth="1.6" strokeLinecap="round">
    <path d="M3 12h5l2 3h4l2-3h5" />
    <path d="M4.5 8 6 4h12l1.5 4" />
    <path d="M3 12v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
  </svg>
);

const topicKey = (g: NewsGroupT) => `${g.scope}:${g.topic}`;

export function NewsScreen() {
  const [scope, setScope] = useState<Scope>('world');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch } = useBriefing();
  const { data: settings } = useSettings();

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Перевір з’єднання з мережею й спробуй ще раз.'}
        onRetry={() => refetch()}
      />
    );
  }

  const news = readBlock(data.brief.blocks, 'news', newsDataSchema);
  const allGroups = news?.groups ?? [];
  // Приглушені теми тут БІЛЬШЕ НЕ ховаємо (фідбек власника, редизайн) —
  // притлумлений чіп/плитка лишається тапабельною (peek без унмуту).
  // Серверний ефект (rss лишається у фетчі, newsdata — ріжеться) настає
  // окремо, у applyTopicMutes.
  const muted = new Set(settings?.settings.mutedTopics ?? []);
  const scoped = allGroups.filter((g) => g.scope === scope);
  const unmuted = scoped.filter((g) => !muted.has(g.topic));
  const mutedGroups = scoped.filter((g) => muted.has(g.topic));
  const openGroup = openKey ? (allGroups.find((g) => topicKey(g) === openKey) ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <DigestCard groups={allGroups.filter((g) => !muted.has(g.topic))} />

      <Segmented segments={SCOPES} value={scope} onChange={setScope} />

      {!news || !allGroups.length ? (
        <EmptyState
          icon={NewsIcon}
          title="Новин поки немає"
          text="На сьогодні стрічка порожня. Загляни пізніше або онови вручну."
          onReload={() => refetch()}
        />
      ) : scoped.length === 0 ? (
        <EmptyState
          icon={NewsIcon}
          title="У цій категорії порожньо"
          text="Тут поки нічого немає. Спробуй іншу категорію або онови."
          onReload={() => refetch()}
        />
      ) : (
        <>
          <TopicChipRow groups={scoped} muted={muted} onSelect={(g) => setOpenKey(topicKey(g))} />

          <div className="grid grid-cols-2 gap-2.5">
            {unmuted.map((g) => (
              <NewsBentoTile key={g.topic} group={g} onOpen={() => setOpenKey(topicKey(g))} />
            ))}
          </div>

          {mutedGroups.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {mutedGroups.map((g) => (
                <MutedNewsTile key={g.topic} group={g} onOpen={() => setOpenKey(topicKey(g))} />
              ))}
            </div>
          )}
        </>
      )}

      {openGroup && <TopicSheet group={openGroup} onClose={() => setOpenKey(null)} />}
    </div>
  );
}
