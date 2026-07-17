import { useId } from 'react';
import { clamp } from '../../lib/format.ts';

// Пончик прогресу (дизайн v2, Svitanok.dc.html): 64×64, r=26, товщина 7,
// градієнт a2→a1, старт із 12-ї години (rotate −90), відсоток у центрі.
// C = 2πr ≈ 163.4 — саме звідси dasharray/dashoffset макета.

const R = 26;
const C = 2 * Math.PI * R;

export function Donut({ pct, size = 64 }: { pct: number; size?: number }) {
  const gid = useId();
  const p = clamp(Math.round(pct), 0, 100);
  const offset = C * (1 - p / 100);

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="flex-none" role="img" aria-label={`Прогрес ${p}%`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFA45C" />
          <stop offset="1" stopColor="#FF6E7A" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r={R} fill="none" stroke="var(--color-track)" strokeWidth="7" />
      <circle
        cx="32"
        cy="32"
        r={R}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={C.toFixed(1)}
        // ПРАВДА — тут, у DOM. Анімація нижче лише додає, звідки приїхати, тож
        // якщо вона не програється (reduced-motion, фонова вкладка) — дуга вже
        // на місці, а не порожня.
        strokeDashoffset={offset.toFixed(1)}
        transform="rotate(-90 32 32)"
        style={{
          animation: 'donutDraw .9s cubic-bezier(.22,1,.36,1)',
          ['--donut-c' as string]: C.toFixed(1),
        }}
      />
      <text
        x="32"
        y="36"
        textAnchor="middle"
        fill="var(--color-tx)"
        fontFamily="JetBrains Mono Variable"
        fontSize="13"
        fontWeight="700"
      >
        {p}%
      </text>
    </svg>
  );
}
