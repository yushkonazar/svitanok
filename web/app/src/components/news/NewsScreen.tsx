import { useState } from 'react';
import { useBriefing, useSettings } from '../../api/hooks.ts';
import { readBlock, newsDataSchema } from '../../api/briefing-schema.ts';
import { LoadingSkeleton, ErrorState, EmptyState } from '../ui/states.tsx';
import { Segmented } from '../ui/Segmented.tsx';
import { NewsGroup } from './NewsGroup.tsx';

// Вкладка «Новини» (дизайн v2, Svitanok.dc.html): сегмент 🌍 Світ / 🇺🇦 Україна,
// далі групи за темами. Стани — скелетон / порожньо / помилка.

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

export function NewsScreen() {
  const [scope, setScope] = useState<Scope>('world');
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
  // Приглушені теми ховаємо і тут: серверний ефект настане лише в НАСТУПНОМУ
  // брифінгу, а вже згенерований усе одно містить теми, які власник щойно вимкнув.
  const muted = new Set(settings?.settings.mutedTopics ?? []);
  const visible = (news?.groups ?? []).filter((g) => g.scope === scope && !muted.has(g.topic));

  return (
    <div className="flex flex-col gap-4">
      <Segmented segments={SCOPES} value={scope} onChange={setScope} />

      {!news || !news.groups.length ? (
        <EmptyState
          icon={NewsIcon}
          title="Новин поки немає"
          text="На сьогодні стрічка порожня. Загляни пізніше або онови вручну."
          onReload={() => refetch()}
        />
      ) : visible.length ? (
        visible.map((g) => <NewsGroup key={`${g.scope}:${g.topic}`} group={g} />)
      ) : (
        <EmptyState
          icon={NewsIcon}
          title="У цій категорії порожньо"
          text="Тут поки нічого немає. Спробуй іншу категорію або онови."
          onReload={() => refetch()}
        />
      )}
    </div>
  );
}
