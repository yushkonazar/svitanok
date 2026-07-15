import { useState } from 'react';
import { useBriefing, useStats } from '../../api/hooks.ts';
import { readBlock, jobsDataSchema } from '../../api/briefing-schema.ts';
import { Ph } from '../ui/primitives.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { FunnelWidget } from './FunnelWidget.tsx';
import { FunnelDetail, type FunnelRow } from './FunnelDetail.tsx';
import { JobCard } from './JobCard.tsx';
import type { FunnelStage } from './stages.ts';

// Вкладка «Вакансії» (роадмеп v3, E3) — 1:1 з index.html renderJobs (2344-2357):
// віджет воронки (завжди), опційно деталі активної стадії, потім картки вакансій.
// Стадія береться зі stats (funnelList), не з блоку. Відхилення (job_dismiss) —
// локальне session-ховання, як vanilla HIDDEN_JOBS.

export function JobsScreen() {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [activeStage, setActiveStage] = useState<FunnelStage | null>(null);
  const { data: briefData, isLoading, isError, error, refetch } = useBriefing();
  const { data: statsData } = useStats();

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !briefData) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Не вдалося завантажити вакансії'}
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

  let rows: FunnelRow[] = [];
  if (activeStage) {
    // funnelList авторитетний, коли stats є (навіть порожній масив — як vanilla
    // `if (fl)`); демо-фолбек на items.funnelStage лише поки stats не завантажено.
    if (stats && Array.isArray(stats.funnelList)) {
      rows = stats.funnelList
        .filter((x) => x.stage === activeStage)
        .map((x) => ({ url: x.url, title: x.title }));
    } else {
      rows = allItems
        .filter((it) => it.funnelStage === activeStage)
        .map((it) => ({ url: it.url, title: it.title }));
    }
  }

  const visibleItems = allItems.filter((it) => !hidden.has(it.url));

  return (
    <div>
      <FunnelWidget counts={counts} active={activeStage} onToggle={setActiveStage} />
      {activeStage && <FunnelDetail stage={activeStage} rows={rows} />}

      {/* Гейт на allItems (не visibleItems): відхилення ховає лише картки, а не
          показує «Вакансій немає» — як vanilla (плейсхолдер лише при 0 вакансій). */}
      {allItems.length ? (
        visibleItems.map((it) => (
          <JobCard
            key={it.url}
            item={it}
            curStage={stageByUrl.get(it.url) ?? it.funnelStage ?? null}
            onDismiss={() => setHidden((s) => new Set(s).add(it.url))}
          />
        ))
      ) : (
        <Ph>Вакансій немає</Ph>
      )}
    </div>
  );
}
