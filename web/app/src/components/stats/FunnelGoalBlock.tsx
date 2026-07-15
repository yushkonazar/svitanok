import type { Stats } from '../../api/schema.ts';
import { clamp, has } from '../../lib/format.ts';
import { Card, StatLine, SubHead } from '../ui/primitives.tsx';
import { Sparkline } from '../charts/Sparkline.tsx';
import { BarsChart } from '../charts/BarsChart.tsx';

// B · Воронка та ціль (роадмеп v3, E1) — index.html funnelGoalBlock (2602-2656).

const STAGES = [
  { key: 'saved', label: 'Збережено' },
  { key: 'applied', label: 'Подав' },
  { key: 'interview', label: 'Співбесіда' },
  { key: 'offer', label: 'Офер' },
] as const;

const GRAD = 'linear-gradient(135deg, var(--grad-from), var(--grad-to))';

export function FunnelGoalBlock({ s }: { s: Stats }) {
  const appliedSum = s.appliedWeekly.reduce((a, w) => a + (w.count || 0), 0);
  const showApplied = s.appliedWeekly.some((w) => w.count > 0);
  const showFit = s.fitHistogram.some((b) => b.count > 0);
  const goalPct = has(s.goal.weeklyTarget)
    ? clamp(Math.round(((s.goal.weeklyApplied || 0) / Math.max(1, s.goal.weeklyTarget!)) * 100), 0, 100)
    : 0;

  return (
    <Card title="🎯 B · Воронка та ціль">
      <div className="flex gap-2">
        {STAGES.map((st) => (
          <div key={st.key} className="flex flex-1 flex-col items-center rounded-2xl bg-surface-2 p-2">
            <span className="text-xl font-bold">{s.funnel[st.key] || 0}</span>
            <span className="text-[11px] text-muted">{st.label}</span>
          </div>
        ))}
      </div>

      <div className="mt-2">
        {has(s.conversion.appliedToInterview) && (
          <StatLine label="Подав → співбесіда" value={`${s.conversion.appliedToInterview}%`} />
        )}
        {has(s.conversion.interviewToOffer) && (
          <StatLine label="Співбесіда → офер" value={`${s.conversion.interviewToOffer}%`} />
        )}
        {has(s.avgFitApplied) && (
          <StatLine label="Середній fit% поданих" value={`${s.avgFitApplied}%`} />
        )}

        {has(s.goal.weeklyTarget) && (
          <>
            <StatLine
              label="Тижневі відгуки (ціль)"
              value={`${s.goal.weeklyApplied || 0} / ${s.goal.weeklyTarget}`}
            />
            <div className="mt-1 h-3 overflow-hidden rounded-full bg-track">
              <div className="h-full rounded-full" style={{ width: `${goalPct}%`, background: GRAD }} />
            </div>
          </>
        )}
      </div>

      {showApplied && (
        <>
          <SubHead>Подачі · 8 тижнів (разом {appliedSum})</SubHead>
          <Sparkline values={s.appliedWeekly.map((w) => w.count)} w={480} h={44} />
        </>
      )}

      {showFit && (
        <>
          <SubHead>Розподіл fit% поданих</SubHead>
          <BarsChart
            items={s.fitHistogram.map((b) => ({ label: b.label, value: b.count }))}
            showCount
            variant="hist"
          />
        </>
      )}
    </Card>
  );
}
