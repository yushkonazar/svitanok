import { Card } from '../ui/primitives.tsx';
import { FUNNEL_STAGES, type FunnelStage } from './stages.ts';

// Віджет воронки (роадмеп v3, E3) — 1:1 з index.html funnelWidget (2360-2403):
// 4 стадії з лічильниками; тап розкриває деталі стадії (FunnelDetail у JobsScreen).

export function FunnelWidget({
  counts,
  active,
  onToggle,
}: {
  counts: Record<FunnelStage, number>;
  active: FunnelStage | null;
  onToggle: (stage: FunnelStage | null) => void;
}) {
  return (
    <Card title="Воронка">
      <div className="flex gap-2">
        {FUNNEL_STAGES.map((s) => {
          const on = active === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onToggle(on ? null : s.key)}
              className={`flex flex-1 flex-col items-center rounded-2xl p-2 transition-colors ${
                on ? 'bg-accent/20 ring-1 ring-accent' : 'bg-surface-2 hover:bg-border'
              }`}
            >
              <span className="text-xl font-bold">{counts[s.key] || 0}</span>
              <span className="text-[11px] text-muted">{s.label}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
