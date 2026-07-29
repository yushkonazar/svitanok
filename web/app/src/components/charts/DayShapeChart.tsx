import { useMemo } from 'react';
import type { CheckinPoint } from '../../api/schema.ts';
import { buildTrendPaths } from '../../lib/trendPath.ts';

// Форма дня: середні енергія/настрій по трьох зрізах доби (ранок/післяобід/
// вечір) за ВСЮ історію ряду, а не одне число «середня енергія». Дані вже
// рахуються на бекенді (checkinSeries[].energyCurve/moodCurve) — доти
// зберігались і ніде не показувались (checkinSeries споживався лише через
// .length і .sleepH). D3 — лише координати (buildTrendPaths, той самий
// хелпер, що InterestTrend), DOM малює React.

const W = 300;
const H = 84;
const SLOT_LABEL = ['ранок', 'післяобід', 'вечір'];

function averageCurve(series: CheckinPoint[], key: 'energyCurve' | 'moodCurve'): (number | null)[] {
  const sums = [0, 0, 0];
  const counts = [0, 0, 0];
  for (const p of series) {
    const curve = p[key];
    for (let i = 0; i < 3; i++) {
      const v = curve[i];
      if (typeof v === 'number') {
        sums[i]! += v;
        counts[i]! += 1;
      }
    }
  }
  return sums.map((s, i) => (counts[i] ? Math.round((s / counts[i]!) * 10) / 10 : null));
}

export function DayShapeChart({ series }: { series: CheckinPoint[] }) {
  const energy = useMemo(() => averageCurve(series, 'energyCurve'), [series]);
  const mood = useMemo(() => averageCurve(series, 'moodCurve'), [series]);
  const n = series.length;

  const { lineOf } = useMemo(
    () => buildTrendPaths([energy, mood], { width: W, height: H, padX: 8, padY: 14 }),
    [energy, mood],
  );

  const hasEnergy = energy.some((v) => v !== null);
  const hasMood = mood.some((v) => v !== null);
  if (!hasEnergy && !hasMood) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {[1, 3, 5].map((v) => {
          const y = 14 + ((5 - v) / 4) * (H - 14 - 14);
          return (
            <g key={v}>
              <line x1={8} x2={W - 8} y1={y} y2={y} stroke="var(--color-hair)" strokeWidth="1" />
              <text x={0} y={y + 3} fontSize="8" fill="var(--color-tx3)" fontFamily="var(--font-mono)">
                {v}
              </text>
            </g>
          );
        })}
        {hasMood && (
          <path
            d={lineOf(mood) ?? undefined}
            fill="none"
            stroke="var(--color-tx3)"
            strokeWidth="1.6"
            strokeDasharray="4 3"
            strokeLinecap="round"
          />
        )}
        {hasEnergy && (
          <path
            d={lineOf(energy) ?? undefined}
            fill="none"
            stroke="var(--color-a2)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )}
        {hasEnergy &&
          energy.map(
            (v, i) =>
              v !== null && (
                <circle
                  key={i}
                  cx={8 + (i / 2) * (W - 16)}
                  cy={14 + ((5 - v) / 4) * (H - 14 - 14)}
                  r={2.6}
                  fill="var(--color-a2)"
                />
              ),
          )}
        {SLOT_LABEL.map((lbl, i) => (
          <text
            key={lbl}
            x={8 + (i / 2) * (W - 16)}
            y={H - 2}
            fontSize="9"
            textAnchor="middle"
            fill="var(--color-tx3)"
          >
            {lbl}
          </text>
        ))}
      </svg>
      <div className="flex items-center gap-3 text-[10px] text-tx3">
        <span className="flex items-center gap-1">
          <span className="inline-block h-[2px] w-3 rounded-full" style={{ background: 'var(--color-a2)' }} />
          енергія
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-[2px] w-3 rounded-full"
            style={{ background: 'var(--color-tx3)', opacity: 0.7 }}
          />
          настрій
        </span>
        <span className="ml-auto font-mono">{n} діб</span>
      </div>
    </div>
  );
}
