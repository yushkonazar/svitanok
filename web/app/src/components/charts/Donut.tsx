import { useId } from 'react';
import { clamp } from '../../lib/format.ts';

// Пончик прогресу (роадмеп v3, E1) — 1:1 з index.html:1600-1613. r=15.9155 обрано
// так, що довжина кола ≈100, тож dasharray=«p 100-p» = відсоток напряму;
// dashoffset=25 повертає старт із 3-ї на 12-ту годину.

export function Donut({ pct, size = 62 }: { pct: number; size?: number }) {
  const gid = useId();
  const p = clamp(Math.round(pct), 0, 100);
  return (
    <svg viewBox="0 0 42 42" width={size} height={size}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff6b57" />
          <stop offset="100%" stopColor="#ffb03a" />
        </linearGradient>
      </defs>
      <circle cx={21} cy={21} r={15.9155} fill="none" stroke="var(--color-border)" strokeWidth={4.5} />
      <circle
        cx={21}
        cy={21}
        r={15.9155}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth={4.5}
        strokeDasharray={`${p} ${100 - p}`}
        strokeDashoffset={25}
        strokeLinecap="round"
      />
      <text x={21} y={24.5} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="var(--color-fg)">
        {p}%
      </text>
    </svg>
  );
}
