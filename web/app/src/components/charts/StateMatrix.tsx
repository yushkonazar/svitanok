import { useMemo, useState } from 'react';
import type { CheckinPoint } from '../../api/schema.ts';
import { haptic } from '../../telegram.ts';

// Карта станів: енергія × настрій, 5×5 клітинок — скільки РАЗІВ (по слотах,
// не по добах) траплялась кожна пара за всю історію ряду. Геометрія
// НАВМИСНО повторює AffectPad (введення чек-іну, той самий 5×5): тапаєш по
// сітці — бачиш свої доби на ТІЙ САМІЙ сітці.
//
// ui-ux-pro-max (--domain chart): Heatmap/Matrix вимагає ≥20 клітинок і
// ЧИСЛО на клітинці, не лише колір (accessibility — «color only» high
// severity) — обидва дотримані.

export function StateMatrix({ series }: { series: CheckinPoint[] }) {
  const [tap, setTap] = useState<string | null>(null);

  const { grid, max, n } = useMemo(() => {
    const g: number[][] = Array.from({ length: 5 }, () => Array(5).fill(0));
    let count = 0;
    for (const p of series) {
      for (let i = 0; i < 3; i++) {
        const e = p.energyCurve[i];
        const m = p.moodCurve[i];
        if (typeof e === 'number' && typeof m === 'number') {
          const er = Math.min(5, Math.max(1, Math.round(e)));
          const mr = Math.min(5, Math.max(1, Math.round(m)));
          g[5 - er]![mr - 1]! += 1;
          count++;
        }
      }
    }
    return { grid: g, max: Math.max(1, ...g.flat()), n: count };
  }, [series]);

  if (n < 12) return null;

  const cell = 34;
  const gap = 3;
  const gx = 22;
  const gy = 4;
  const W = gx + 5 * cell + 4 * gap;
  const H = gy + 5 * cell + 4 * gap + 16;
  const tapped = tap
    ? { r: Number(tap.split(':')[0]), c: Number(tap.split(':')[1]) }
    : null;
  const tappedCount = tapped ? grid[tapped.r]![tapped.c]! : 0;

  const colorFor = (v: number) => {
    if (v === 0) return 'var(--color-track)';
    const t = v / max;
    // Той самий accent-градієнт, що решта дашборда (a1->a2), лише як
    // intensity-шкала: не додаємо третій незалежний колір у палітру.
    return `color-mix(in srgb, var(--color-a2) ${Math.round(18 + t * 62)}%, var(--color-track))`;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {[5, 4, 3, 2, 1].map((v, r) => (
          <text
            key={v}
            x={gx - 6}
            y={gy + r * (cell + gap) + cell / 2 + 3}
            fontSize="9"
            textAnchor="end"
            fill="var(--color-tx3)"
            fontFamily="var(--font-mono)"
          >
            {v}
          </text>
        ))}
        {[1, 2, 3, 4, 5].map((v, c) => (
          <text
            key={v}
            x={gx + c * (cell + gap) + cell / 2}
            y={gy + 5 * (cell + gap) - gap + 10}
            fontSize="9"
            textAnchor="middle"
            fill="var(--color-tx3)"
            fontFamily="var(--font-mono)"
          >
            {v}
          </text>
        ))}
        {grid.map((row, r) =>
          row.map((v, c) => {
            const key = `${r}:${c}`;
            const x = gx + c * (cell + gap);
            const y = gy + r * (cell + gap);
            return (
              <g
                key={key}
                onClick={() => {
                  haptic('light');
                  setTap(tap === key ? null : key);
                }}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  x={x}
                  y={y}
                  width={cell}
                  height={cell}
                  rx={7}
                  fill={colorFor(v)}
                  stroke={tap === key ? 'var(--color-a2)' : 'var(--color-glassb)'}
                  strokeWidth={tap === key ? 1.6 : 1}
                />
                {v > 0 && (
                  <text
                    x={x + cell / 2}
                    y={y + cell / 2 + 4}
                    fontSize="12"
                    textAnchor="middle"
                    fontFamily="var(--font-mono)"
                    fontWeight={600}
                    fill={v / max > 0.55 ? 'var(--color-onacc)' : 'var(--color-tx2)'}
                  >
                    {v}
                  </text>
                )}
              </g>
            );
          }),
        )}
      </svg>
      <div className="flex items-center justify-between text-[9.5px] text-tx3">
        <span>енергія ↑ · настрій →</span>
        <span className="font-mono">
          {tapped
            ? `енергія ${5 - tapped.r} · настрій ${tapped.c + 1} — ${tappedCount}×`
            : `${n} зрізів`}
        </span>
      </div>
    </div>
  );
}
