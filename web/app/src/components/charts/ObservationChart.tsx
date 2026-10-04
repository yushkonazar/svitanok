import { useId, useState } from 'react';

export interface Observation {
  date: string;
  value: number;
}
export function ObservationChart({
  points,
  label,
  unit = '',
  color = 'var(--color-a2)',
  maxGapDays,
}: {
  points: Observation[];
  label: string;
  unit?: string;
  color?: string;
  maxGapDays?: number;
}) {
  const uid = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const valid = points
    .filter((p) => Number.isFinite(p.value) && Number.isFinite(Date.parse(p.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (!valid.length)
    return <p className="renewal-muted">Історія з’явиться після першого спостереження.</p>;
  const index = Math.min(selected ?? valid.length - 1, valid.length - 1);
  const point = valid[index];
  const values = valid.map((p) => p.value);
  const lo = Math.min(...values),
    hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.2, Math.abs(hi) * 0.0005, 0.00001);
  const min = lo - pad,
    max = hi + pad;
  const timestamps = valid.map((p) => Date.parse(p.date));
  const first = Math.min(...timestamps),
    last = Math.max(...timestamps);
  const x = (i: number) =>
    valid.length === 1 ? 180 : 12 + ((timestamps[i] - first) / (last - first || 1)) * 336;
  const y = (v: number) => 110 - ((v - min) / (max - min)) * 96;
  const hasGap =
    maxGapDays != null &&
    timestamps.some((t, i) => i > 0 && t - timestamps[i - 1] > maxGapDays * 86400000);
  const path = valid
    .map(
      (p, i) =>
        `${!i || (maxGapDays != null && timestamps[i] - timestamps[i - 1] > maxGapDays * 86400000) ? 'M' : 'L'}${x(i)} ${y(p.value)}`,
    )
    .join(' ');
  const date = (s: string) =>
    new Date(s).toLocaleDateString('uk-UA', {
      day: 'numeric',
      month: 'short',
      timeZone: 'Europe/Kyiv',
    });
  const fmt = (n: number) => n.toLocaleString('uk-UA', { maximumFractionDigits: 4 });
  return (
    <div className="renewal-observation">
      <div className="flex items-baseline justify-between gap-2" aria-live="polite">
        <span className="text-xs text-tx2">{date(point.date)}</span>
        <b className="font-mono text-sm">
          {fmt(point.value)} {unit}
        </b>
      </div>
      <svg
        viewBox="0 0 360 128"
        className="w-full"
        role="img"
        aria-label={`${label}: мінімум ${fmt(lo)}, максимум ${fmt(hi)}. ${valid.length} спостережень.`}
      >
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor={color} stopOpacity=".24" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[32, 72, 110].map((h) => (
          <line key={h} x1="12" x2="348" y1={h} y2={h} stroke="var(--color-hair)" />
        ))}
        {valid.length > 1 && !hasGap && (
          <path d={`${path} L${x(valid.length - 1)} 122 L${x(0)} 122 Z`} fill={`url(#${uid})`} />
        )}
        <path
          d={path}
          stroke={color}
          strokeWidth="2.5"
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <line
          x1={x(index)}
          x2={x(index)}
          y1="8"
          y2="122"
          stroke={color}
          strokeOpacity=".4"
          strokeDasharray="3 4"
        />
        {valid.map((p, i) => (
          <circle
            key={`${p.date}-${i}`}
            cx={x(i)}
            cy={y(p.value)}
            r={i === index ? 5 : 2}
            fill={color}
          />
        ))}
      </svg>
      <input
        type="range"
        className="w-full accent-[var(--color-a2)]"
        min={0}
        max={valid.length - 1}
        value={index}
        onChange={(e) => setSelected(Number(e.target.value))}
        aria-label={`Дата: ${label}`}
        aria-valuetext={`${date(point.date)}: ${fmt(point.value)} ${unit}`}
      />
      <div className="flex justify-between text-[11px] text-tx3">
        <span>{date(valid[0].date)}</span>
        <span>{date(valid[valid.length - 1].date)}</span>
      </div>
      <p className="renewal-muted mt-2">
        Мінімум {fmt(lo)} · максимум {fmt(hi)} {unit}
        {hasGap ? ' · пропуски не з’єднані лінією' : ''}
      </p>
    </div>
  );
}
