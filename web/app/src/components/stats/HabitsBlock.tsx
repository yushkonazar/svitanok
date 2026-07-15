import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { Card, StatLine, SubHead, Ph } from '../ui/primitives.tsx';
import { BarsChart } from '../charts/BarsChart.tsx';
import { HeatmapGrid } from '../charts/HeatmapGrid.tsx';

// A · Звички (роадмеп v3, E1) — index.html:2488-2501.

function StreakTile({ emoji, n, t, rec }: { emoji: string; n: number; t: string; rec?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-0.5 rounded-2xl bg-surface-2 p-3 text-center">
      <div className="text-xl">{emoji}</div>
      <div className="text-2xl font-bold">{n}</div>
      <div className="text-xs text-muted">{t}</div>
      {rec && <div className="text-[11px] text-accent">{rec}</div>}
    </div>
  );
}

export function HabitsBlock({ s }: { s: Stats }) {
  const showHeatmap = s.heatmap.some((c) => c.v > 0);
  return (
    <Card title="🔥 A · Звички">
      <div className="flex gap-2.5">
        <StreakTile
          emoji="🔥"
          n={s.streaks.openDays || 0}
          t="днів поспіль відкрито"
          rec={has(s.streaks.bestOpenDays) ? `рекорд ${s.streaks.bestOpenDays}` : undefined}
        />
        <StreakTile emoji="🎤" n={s.streaks.mockDays || 0} t="днів поспіль питання" />
      </div>

      <div className="mt-3">
        {s.weekly.length ? (
          <BarsChart items={s.weekly.map((d) => ({ label: d.day, value: d.value || 0 }))} />
        ) : (
          <Ph>Немає даних за тиждень</Ph>
        )}
      </div>

      {showHeatmap && (
        <>
          <SubHead>Активність · 12 тижнів</SubHead>
          <HeatmapGrid cells={s.heatmap} />
        </>
      )}

      {has(s.timeToOpenMin) && (
        <StatLine label="Час до відкриття (медіана)" value={`+${s.timeToOpenMin} хв після 08:00`} />
      )}
    </Card>
  );
}
