import type { Stats } from '../../api/schema.ts';
import { clamp, has } from '../../lib/format.ts';
import { SectionHead, StatRow } from '../ui/primitives.tsx';
import { Sparkline } from '../charts/Sparkline.tsx';
import { FUNNEL_SHORT, FUNNEL_STAGES } from '../jobs/stages.ts';

// B · Воронка та ціль (дизайн v2, Svitanok.dc.html): 4 міні-картки стадій,
// рядки конверсій, смуга тижневої цілі, спарклайн подач за 8 тижнів.
//
// Свідомо: макет прибрав гістограму «Розподіл fit% поданих» (замінив спарклайном
// подач) — це і був аудит статистики з роадмепу. stats.fitHistogram сервер далі
// рахує, тож повернути блок можна будь-коли без змін бекенду.

export function FunnelGoalBlock({ s }: { s: Stats }) {
  const appliedSum = s.appliedWeekly.reduce((a, w) => a + (w.count || 0), 0);
  const showApplied = s.appliedWeekly.some((w) => w.count > 0);
  const goalPct = has(s.goal.weeklyTarget)
    ? clamp(Math.round(((s.goal.weeklyApplied || 0) / Math.max(1, s.goal.weeklyTarget!)) * 100), 0, 100)
    : 0;

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHead>Воронка та ціль</SectionHead>

      <div className="flex gap-2">
        {FUNNEL_STAGES.map((st) => {
          const n = s.funnel[st.key] || 0;
          return (
            <div
              key={st.key}
              className="flex-1 rounded-2xl border border-glassb bg-glass px-2 py-3 text-center"
            >
              <div
                className="font-mono text-2xl font-medium"
                style={{ color: n ? 'var(--color-tx)' : 'var(--color-tx3)' }}
              >
                {n}
              </div>
              <div className="text-[9.5px] font-medium text-tx2">{FUNNEL_SHORT[st.key]}</div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-[9px]">
        {has(s.conversion.appliedToInterview) && (
          <StatRow label="Подав → співбесіда" value={`${s.conversion.appliedToInterview}%`} />
        )}
        {has(s.conversion.interviewToOffer) && (
          <StatRow label="Співбесіда → офер" value={`${s.conversion.interviewToOffer}%`} />
        )}
        {has(s.avgFitApplied) && <StatRow label="Середній fit% поданих" value={`${s.avgFitApplied}%`} />}
        {has(s.goal.weeklyTarget) && (
          <>
            <StatRow
              label="Тижневі відгуки (ціль)"
              value={`${s.goal.weeklyApplied || 0} / ${s.goal.weeklyTarget}`}
            />
            <div className="h-2 overflow-hidden rounded-full bg-track">
              <div
                className="h-full rounded-full"
                style={{ width: `${goalPct}%`, background: 'linear-gradient(90deg,var(--color-a1),var(--color-a2))' }}
              />
            </div>
          </>
        )}
      </div>

      {showApplied && (
        <div>
          <div className="mb-1 font-mono text-[9.5px] font-semibold tracking-[0.1em] text-tx3">
            ПОДАЧІ · 8 ТИЖНІВ (РАЗОМ {appliedSum})
          </div>
          <Sparkline values={s.appliedWeekly.map((w) => w.count)} />
        </div>
      )}
    </div>
  );
}
