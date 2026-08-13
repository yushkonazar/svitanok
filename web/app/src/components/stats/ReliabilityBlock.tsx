import { useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { pluralUk } from '../../lib/plural.ts';
import { haptic } from '../../telegram.ts';
import { SectionHead, StatRow, Ph } from '../ui/primitives.tsx';
import { useCountUp } from '../ui/CountUp.tsx';
import { useInView } from '../../lib/useInView.ts';
import { daysWindowLabel } from '../../lib/windowLabel.ts';

// E · Надійність (повний редизайн) — це системна довіра ("чи бот на часі"),
// не особистий прогрес власника, тож картка свідомо ТИХІША за решту екрана:
// той самий градієнтний "стрік"-стиль, що в Активності (візуальна
// консистентність між двома стрік-концепціями), але меншого розміру, і без
// власного BIG-заголовка-плитки.
//
// Дот-таймлайн — не Heatmap (той для 12-тижневої/84-денної щільності);
// reliability.days — бінарний факт на день за ~30 днів, рядок компактних
// крапок читається природніше. Диференціація ok/dead-man — і колір, і форма
// (заповнене коло проти кільця), не лише колір (ui-ux-pro-max, ux-guidelines
// "Color Only" — High severity).

function DotTimeline({ days }: { days: { d: string; ok: boolean }[] }) {
  const [tapped, setTapped] = useState<string | null>(null);
  const tappedDay = days.find((d) => d.d === tapped);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-[3px]">
        {days.map((day) => (
          <button
            key={day.d}
            type="button"
            onClick={() => {
              haptic('light');
              setTapped(day.d === tapped ? null : day.d);
            }}
            className="h-[9px] w-[9px] flex-none"
            style={
              day.ok
                ? { borderRadius: '2.5px', background: 'var(--color-pos)', opacity: 0.75 }
                : {
                    borderRadius: '50%',
                    background: 'transparent',
                    border: '1.5px solid var(--color-neg)',
                  }
            }
            aria-label={`${day.d}: ${day.ok ? 'вчасно' : 'dead-man спрацював'}`}
          />
        ))}
      </div>
      <span className="font-mono text-[9.5px] text-tx3">
        {tappedDay
          ? `${tappedDay.d}: ${tappedDay.ok ? 'вчасно' : 'dead-man спрацював'}`
          : 'Тапни на крапку — покаже дату'}
      </span>
    </div>
  );
}

export function ReliabilityBlock({ s }: { s: Stats }) {
  const r = s.reliability;
  const hasData = has(r.total) && r.total > 0;
  const [ref, inView] = useInView<HTMLDivElement>();
  const streakShown = useCountUp(r.streak, inView);

  return (
    <div className="flex flex-col gap-2.5">
      <SectionHead>Надійність</SectionHead>
      {hasData ? (
        <>
          <div ref={ref} className="flex items-baseline gap-1.5">
            <span
              className="font-mono text-[26px] font-medium leading-none tracking-[-0.02em]"
              style={{
                background: 'var(--grad)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              {streakShown}
            </span>
            <span className="text-[11px] font-medium text-tx2">
              {r.streak > 0 ? 'днів поспіль бот на часі' : 'бот сьогодні не на часі'}
              {r.best > r.streak && (
                <span className="ml-1 font-mono text-tx3">(рекорд {r.best})</span>
              )}
            </span>
          </div>

          {r.days.length > 1 && (
            <>
              <span className="font-mono text-[9.5px] tracking-[0.08em] text-tx3">
                ЖУРНАЛ · {daysWindowLabel(s.windows.reliabilityDays, r.days.length)}
              </span>
              <DotTimeline days={r.days} />
            </>
          )}

          {/* ⚠️ onTime/total — лічильники ЗА ВЕСЬ ЧАС (recordReliability лише
              інкрементує їх, ніколи не скидає), а от журнал днів обрізаний на
              reliabilityDays. Підпис казав «із N останніх днів» — тобто
              приписував довічному лічильнику вікно, якого в нього немає. */}
          <StatRow
            label="Вчасно"
            value={`${r.onTime} із ${r.total} днів за весь час`}
            valueClass="text-pos"
          />
          {r.deadman > 0 && (
            <span className="font-mono text-[9.5px] text-tx3">
              Dead-man спрацював {r.deadman} {pluralUk(r.deadman, ['раз', 'рази', 'разів'])}
            </span>
          )}
        </>
      ) : (
        <Ph>Дані про стабільність доставки з’являться згодом</Ph>
      )}
    </div>
  );
}
