import { useState } from 'react';
import { useBriefing, useStats } from '../../api/hooks.ts';
import { readBlock, jobsDataSchema } from '../../api/briefing-schema.ts';
import { LoadingSkeleton, ErrorState, EmptyState } from '../ui/states.tsx';
import { Cascade } from '../ui/Cascade.tsx';
import { Segmented } from '../ui/Segmented.tsx';
import { FunnelWidget } from './FunnelWidget.tsx';
import { JobCard } from './JobCard.tsx';
import { KanbanBoard, type KanbanCard } from './KanbanBoard.tsx';
import { JobSheet } from './JobSheet.tsx';
import type { FunnelStage } from './stages.ts';

// Вкладка «Вакансії» (дизайн v2, Svitanok.dc.html): сегмент Список/Канбан.
// - СПИСОК: смуга воронки + картки сьогоднішнього брифінгу (сортовані за fit%).
// - КАНБАН: лейни-стадії з drag&drop; джерело — stats.funnelList, тож видно й
//   вакансії з МИНУЛИХ днів (список їх не показує — саме це раніше закривав
//   FunnelDetail). fit% підтягуємо з брифінгу за url, якщо вакансія ще в ньому.
// Відхилення («Не цікавить») — персистентне (stats.dismissedUrls, фідбек
// власника: раніше було лише сесійне ховання, вакансія поверталась після
// перезаходу), плюс миттєве локальне ховання ДО підтвердження мутації.

const JobsIcon = (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--color-tx3)"
    strokeWidth="1.6"
    strokeLinecap="round"
  >
    <rect x="3" y="7" width="18" height="13" rx="2.5" />
    <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
  </svg>
);

type View = 'list' | 'kanban';

const VIEWS = [
  { id: 'list', label: 'Список' },
  { id: 'kanban', label: 'Канбан' },
] as const;

export function JobsScreen() {
  const [view, setView] = useState<View>('list');
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [openUrl, setOpenUrl] = useState<string | null>(null);
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
  const scoreByUrl = new Map<string, number>();
  for (const it of allItems) scoreByUrl.set(it.url, it.score);

  const counts: Record<FunnelStage, number> = stats
    ? stats.funnel
    : allItems.reduce(
        (acc, it) => {
          if (it.funnelStage) acc[it.funnelStage]++;
          return acc;
        },
        // Фолбек лише для демо-брифінгу без stats; термінальні тут нулі —
        // funnelStage у брифінгу їх не має (реальна стадія завжди зі stats).
        { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0, failed: 0 },
      );

  // Канбан — з воронки (усі дні), не з брифінгу.
  const kanbanCards: KanbanCard[] = (stats?.funnelList ?? []).map((x) => ({
    url: x.url,
    title: x.title,
    stage: x.stage,
    score: scoreByUrl.get(x.url) ?? null,
    ts: x.ts,
    history: x.history,
  }));

  // Персистентне (stats.dismissedUrls) + сесійне (hidden, миттєвий відгук ДО
  // підтвердження мутації) — обидва разом: перше переживає перезахід у
  // застосунок, друге ховає картку без очікування round-trip до сервера.
  const dismissedUrls = new Set(stats?.dismissedUrls ?? []);
  const visible = allItems
    .filter((it) => !hidden.has(it.url) && !dismissedUrls.has(it.url))
    .slice()
    .sort((a, b) => b.score - a.score);

  const openCard = openUrl ? kanbanCards.find((c) => c.url === openUrl) : null;

  return (
    <div className="flex flex-col gap-4">
      <Segmented segments={VIEWS} value={view} onChange={setView} />

      {view === 'list' ? (
        <>
          <FunnelWidget counts={counts} />
          {allItems.length ? (
            // Cascade (заморожений), а не голий cascade(i): «Не цікавить»
            // зсуває індекси карток нижче, і живий delay рестартував би їм fadeUp.
            visible.map((it, i) => (
              <Cascade key={it.url} i={i} step={55} cap={5}>
                <JobCard
                  item={it}
                  curStage={stageByUrl.get(it.url) ?? it.funnelStage ?? null}
                  onDismiss={() => setHidden((s) => new Set(s).add(it.url))}
                />
              </Cascade>
            ))
          ) : (
            <EmptyState
              icon={JobsIcon}
              title="Ще немає вакансій"
              text="Збережені вакансії з’являться тут. Додай першу з пошуку."
              onReload={() => refetch()}
            />
          )}
        </>
      ) : kanbanCards.length ? (
        <KanbanBoard cards={kanbanCards} onOpenCard={setOpenUrl} />
      ) : (
        <EmptyState
          icon={JobsIcon}
          title="Воронка порожня"
          text="Признач вакансії стадію у списку — вони з’являться на дошці."
        />
      )}

      {openCard && <JobSheet card={openCard} onClose={() => setOpenUrl(null)} />}
    </div>
  );
}
