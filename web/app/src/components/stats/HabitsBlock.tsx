import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { SectionHead, StatRow } from '../ui/primitives.tsx';
import { WeekBars } from '../charts/WeekBars.tsx';
import { Heatmap } from '../charts/Heatmap.tsx';

// A · Звички (дизайн v2, Svitanok.dc.html): дві скляні плитки стріків (перша —
// градієнтним числом), тижневі стовпчики, теплокарта 12 тижнів, медіана часу.

function Tile({
  n,
  emoji,
  label,
  note,
  gradient = false,
}: {
  n: number;
  emoji?: string;
  label: string;
  note?: string;
  gradient?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col gap-0.5 rounded-2xl border border-glassb bg-glass p-3.5">
      <div className="flex items-baseline gap-1.5">
        <span
          className="font-mono text-[44px] font-medium leading-none tracking-[-0.03em]"
          style={
            gradient
              ? { background: 'var(--grad)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }
              : undefined
          }
        >
          {n}
        </span>
        {emoji && <span className="text-[15px]">{emoji}</span>}
      </div>
      <span className="text-[10.5px] font-medium leading-[1.3] text-tx2">{label}</span>
      {note && <span className="font-mono text-[10px] font-semibold text-tx3">{note}</span>}
    </div>
  );
}

export function HabitsBlock({ s }: { s: Stats }) {
  const showHeatmap = s.heatmap.some((c) => c.v > 0);
  return (
    <div className="flex flex-col gap-3.5">
      <SectionHead>Звички</SectionHead>

      <div className="flex gap-2.5">
        <Tile
          gradient
          n={s.streaks.openDays || 0}
          emoji="🔥"
          label="днів поспіль відкрито"
          note={has(s.streaks.bestOpenDays) ? `РЕКОРД ${s.streaks.bestOpenDays}` : undefined}
        />
        <Tile n={s.streaks.mockDays || 0} label="днів поспіль питання" />
      </div>

      <WeekBars days={s.weekly} />

      {showHeatmap && (
        <div>
          <div className="mb-1.5 font-mono text-[9.5px] font-semibold tracking-[0.1em] text-tx3">
            АКТИВНІСТЬ · 12 ТИЖНІВ
          </div>
          <Heatmap cells={s.heatmap} />
        </div>
      )}

      {has(s.timeToOpenMin) && (
        <div className="pt-0.5">
          <StatRow label="Час до відкриття (медіана)" value={`+${s.timeToOpenMin} хв після 08:00`} />
        </div>
      )}
    </div>
  );
}
