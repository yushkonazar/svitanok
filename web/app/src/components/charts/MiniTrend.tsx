import { useId } from 'react';
import { buildTrendPaths } from '../../lib/trendPath.ts';
import { shortDateFromIso } from '../../lib/dateLabel.ts';
import { useInView } from '../../lib/useInView.ts';

// Односерійний тренд-графік (лінія+заливка, дати знизу) — той самий
// візуальний стиль, що топ-тема в InterestTrend.tsx, для одиночних рядів
// (fit%, подачі), де фокус-перемикання між темами не потрібне. `null` у
// series (тиждень без даних) -> реальна перерва в лінії, не провал до нуля
// (buildTrendPaths.defined()).

const W = 300;
const H = 70;
const PAD_X = 3;
const PAD_Y = 6;

export function MiniTrend({ weeks, series }: { weeks: string[]; series: (number | null)[] }) {
  const gradId = useId();
  const [ref, inView] = useInView<SVGSVGElement>();
  const { lineOf, areaOf } = buildTrendPaths([series], {
    width: W,
    height: H,
    padX: PAD_X,
    padY: PAD_Y,
  });
  const values = series.filter((v): v is number => v != null);
  if (values.length < 2) {
    return <div className="py-1 font-mono text-[9.5px] text-tx3">НЕДОСТАТНЬО ДАНИХ</div>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--color-a1)" />
            <stop offset="1" stopColor="var(--color-a2)" />
          </linearGradient>
        </defs>
      </svg>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        <path
          d={areaOf(series) ?? undefined}
          fill={`url(#${gradId})`}
          opacity="0.14"
          stroke="none"
          style={{
            animation: 'fadeInSoft .9s ease-out backwards',
            animationPlayState: inView ? 'running' : 'paused',
          }}
        />
        <path
          d={lineOf(series) ?? undefined}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="2"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset="0"
          style={{
            animation: 'lineDraw .9s cubic-bezier(.4,0,.2,1) backwards',
            animationPlayState: inView ? 'running' : 'paused',
          }}
        />
      </svg>
      <div className="flex items-center justify-between font-mono text-[9px] text-tx3">
        <span>{shortDateFromIso(weeks[0])}</span>
        <span>{shortDateFromIso(weeks[weeks.length - 1])}</span>
      </div>
    </div>
  );
}
