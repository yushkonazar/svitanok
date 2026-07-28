import type { Stats } from '../../api/schema.ts';
import { clamp, has } from '../../lib/format.ts';
import { useInView } from '../../lib/useInView.ts';
import { SectionHead, StatRow } from '../ui/primitives.tsx';
import { MiniTrend } from '../charts/MiniTrend.tsx';

// Ритм (повний редизайн статистики, замінює колишню «Воронка та ціль») —
// картки-лічильники стадій (saved/applied/interview/offer) прибрано ЦІЛКОМ:
// вони буквально дублювали jobs/FunnelWidget.tsx на вкладці «Вакансії» (той
// самий s.funnel, той самий вигляд). Лишається лише унікальний контент,
// якого там немає: конверсії з дійшов-до-стадії (F1, чесний знаменник),
// закриті, тижнева ціль-смуга — і два тренди (fit%/подачі по тижнях) замість
// голого числа/базового спарклайна, щоб "чи я на правильному шляху" читалось
// з форми лінії, а не лише з одного відсотка.

export function RhythmBlock({ s }: { s: Stats }) {
  // Смуга цілі заповнюється, коли доїхала до екрана — той самий barFill, що
  // й смуги навичок у MasteryBlock.
  const [goalRef, goalInView] = useInView<HTMLDivElement>();
  const goalPct = has(s.goal.weeklyTarget)
    ? clamp(Math.round(((s.goal.weeklyApplied || 0) / Math.max(1, s.goal.weeklyTarget!)) * 100), 0, 100)
    : 0;
  const appliedSum = s.appliedWeekly.reduce((a, w) => a + (w.count || 0), 0);

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHead>Ритм</SectionHead>

      <div className="flex flex-col gap-[9px]">
        {/* Конверсії з «дійшов до» (F1): знаменник — усі, хто КОЛИСЬ був на
            стадії, тож відмова його не зменшує. */}
        {has(s.conversion.appliedToInterview) && (
          <StatRow
            label="Подав → співбесіда"
            value={
              <>
                {s.conversion.appliedToInterview}%
                {s.reached.applied > 0 && (
                  <span className="ml-1.5 font-normal text-tx3">
                    {s.reached.interview}/{s.reached.applied}
                  </span>
                )}
              </>
            }
          />
        )}
        {has(s.conversion.interviewToOffer) && (
          <StatRow
            label="Співбесіда → офер"
            value={
              <>
                {s.conversion.interviewToOffer}%
                {s.reached.interview > 0 && (
                  <span className="ml-1.5 font-normal text-tx3">
                    {s.reached.offer}/{s.reached.interview}
                  </span>
                )}
              </>
            }
          />
        )}
        {(s.funnel.rejected > 0 || s.funnel.failed > 0) && (
          <StatRow
            label="Закрито (відмова / провал)"
            value={`${s.funnel.rejected} / ${s.funnel.failed}`}
          />
        )}
        {has(s.goal.weeklyTarget) && (
          <>
            <StatRow
              label="Тижневі відгуки (ціль)"
              value={`${s.goal.weeklyApplied || 0} / ${s.goal.weeklyTarget}`}
            />
            <div ref={goalRef} className="h-2 overflow-hidden rounded-full bg-track">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${goalPct}%`,
                  background: 'linear-gradient(90deg,var(--color-a1),var(--color-a2))',
                  animation: 'barFill .8s cubic-bezier(.22,1,.36,1) backwards',
                  animationPlayState: goalInView ? 'running' : 'paused',
                }}
              />
            </div>
          </>
        )}
      </div>

      {has(s.avgFitApplied) && (
        <div>
          <div className="mb-1 flex items-baseline gap-1.5">
            <span className="font-mono text-[9.5px] font-semibold tracking-[0.1em] text-tx3">
              FIT% ПОДАНИХ · 8 ТИЖНІВ
            </span>
            <span className="font-mono text-[11px] font-semibold text-tx2">
              {s.avgFitApplied}% зараз
            </span>
          </div>
          <MiniTrend
            weeks={s.fitWeekly.map((w) => w.week)}
            series={s.fitWeekly.map((w) => w.avgFit)}
          />
        </div>
      )}

      {appliedSum > 0 && (
        <div>
          <div className="mb-1 font-mono text-[9.5px] font-semibold tracking-[0.1em] text-tx3">
            ПОДАЧІ · 8 ТИЖНІВ (РАЗОМ {appliedSum})
          </div>
          <MiniTrend
            weeks={s.appliedWeekly.map((w) => w.week)}
            series={s.appliedWeekly.map((w) => w.count)}
          />
        </div>
      )}
    </div>
  );
}
