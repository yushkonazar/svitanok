import { useId } from 'react';

// Спарклайн (роадмеп v3, E1) — геометрія 1:1 з index.html:1569-1598.
// pad=4; x рівномірно, y інвертовано (більше значення -> вище). Горизонтальний
// градієнт #ff6b57->#ffb03a (SVG defs не читають CSS-змінні, тож хекс сталий).

const PAD = 4;

export function Sparkline({ values, w = 280, h = 56 }: { values: number[]; w?: number; h?: number }) {
  const gid = useId();
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) {
    return <div className="py-2 text-center text-xs text-muted">Недостатньо даних для графіка</div>;
  }

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const stepX = (w - 2 * PAD) / (pts.length - 1);
  const coords = pts.map((v, i) => ({
    x: PAD + i * stepX,
    y: PAD + (h - 2 * PAD) * (1 - (v - min) / span),
  }));

  const line = coords.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];
  const first = coords[0];
  const area = `${line} L${last.x.toFixed(1)} ${h - PAD} L${first.x.toFixed(1)} ${h - PAD} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ff6b57" />
          <stop offset="100%" stopColor="#ffb03a" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} opacity={0.14} />
      <path
        d={line}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last.x} cy={last.y} r={3} fill="#ffb03a" />
    </svg>
  );
}
