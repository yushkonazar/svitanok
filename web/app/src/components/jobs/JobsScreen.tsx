import { useState } from 'react';
import { useBriefing, useStats } from '../../api/hooks.ts';
import { readBlock, jobsDataSchema } from '../../api/briefing-schema.ts';
import { LoadingSkeleton, ErrorState, EmptyState } from '../ui/states.tsx';
import { FunnelWidget } from './FunnelWidget.tsx';
import { JobCard } from './JobCard.tsx';
import type { FunnelStage } from './stages.ts';

// Вкладка «Вакансії» (дизайн v2, Svitanok.dc.html): смуга воронки, далі картки
// (сортовані за fit%, як у макеті). Стадія береться зі stats.funnelList, не з
// блоку брифінгу. Відхилення — локальне session-ховання (job_dismiss ефемерний).
// Канбан із drag&drop і шторка картки — наступний крок (потребують термінальних
// стадій у stats-core), тож сегмент «Список/Канбан» поки не показуємо.

const JobsIcon = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--color-tx3)" strokeWidth="1.6" strokeLinecap="round">
    <rect x="3" y="7" width="18" height="13" rx="2.5" />
    <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
  </svg>
);

export function JobsScreen() {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const { data: briefData, isLoading, isError, error, refetch } = useBriefing();
  const { data: statsData } = useStats();

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !briefData) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Перевір з’єднання й спробуй ще раз.'}
        onRetry={() => refetch()}
      />
    );
  }

  const jobs = readBlock(briefData.brief.blocks, 'jobs', jobsDataSchema);
  const allItems = jobs?.items ?? [];
  const stats = statsData?.stats;

  const stageByUrl = new Map<string, FunnelStage>();
  for (const x of stats?.funnelList ?? []) stageByUrl.set(x.url, x.stage);

  const counts: Record<FunnelStage, number> = stats
    ? stats.funnel
    : allItems.reduce(
        (acc, it) => {
          if (it.funnelStage) acc[it.funnelStage]++;
          return acc;
        },
        { saved: 0, applied: 0, interview: 0, offer: 0 },
      );

  // Макет сортує картки за fit% (спадання); score<0 («оцінюється») — у кінець.
  const visible = allItems
    .filter((it) => !hidden.has(it.url))
    .slice()
    .sort((a, b) => b.score - a.score);

  return (
    <div className="flex flex-col gap-4">
      <FunnelWidget counts={counts} />

      {allItems.length ? (
        visible.map((it) => (
          <JobCard
            key={it.url}
            item={it}
            curStage={stageByUrl.get(it.url) ?? it.funnelStage ?? null}
            onDismiss={() => setHidden((s) => new Set(s).add(it.url))}
          />
        ))
      ) : (
        <EmptyState
          icon={JobsIcon}
          title="Ще немає вакансій"
          text="Збережені вакансії з’являться тут. Додай першу з пошуку."
          onReload={() => refetch()}
        />
      )}
    </div>
  );
}
