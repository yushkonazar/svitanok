import { useJobStage } from '../../api/hooks.ts';
import { prettyJobTitle } from '../../lib/jobTitle.ts';
import { Card, Ph } from '../ui/primitives.tsx';
import { FUNNEL_STAGES, STAGE_LABEL, type FunnelStage } from './stages.ts';

// Деталі стадії воронки (роадмеп v3, E3/D5) — 1:1 з index.html funnelDetailHtml
// (2422-2444): список вакансій стадії + кнопки переміщення між стадіями + видалення.

export interface FunnelRow {
  url: string;
  title: string;
}

export function FunnelDetail({ stage, rows }: { stage: FunnelStage; rows: FunnelRow[] }) {
  const move = useJobStage();

  return (
    <Card title={STAGE_LABEL[stage]}>
      {rows.length ? (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.url} className="border-t border-border/50 pt-2 first:border-t-0 first:pt-0">
              <div className="mb-1.5 truncate text-sm font-medium" title={r.title}>
                {prettyJobTitle(r.url, r.title)}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {FUNNEL_STAGES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    disabled={s.key === stage}
                    onClick={() => move.mutate({ url: r.url, title: r.title, stage: s.key })}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                      s.key === stage
                        ? 'bg-accent text-on-accent'
                        : 'bg-surface-2 text-muted hover:bg-border'
                    }`}
                  >
                    {s.short}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Прибрати з воронки"
                  onClick={() => move.mutate({ url: r.url, title: r.title, stage: null })}
                  className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-down transition-colors hover:bg-border"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Ph>Список цієї стадії з’явиться, коли будуть дані</Ph>
      )}
    </Card>
  );
}
