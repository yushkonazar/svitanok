import { useId, useState, type PointerEvent } from 'react';

export interface Observation {
  date: string;
  value: number;
  approx?: boolean;
}
export function ObservationChart({
  points,
  label,
  unit = '',
  color = 'var(--color-a2)',
  maxGapDays,
  domain,
  onSelect,
  formatDate,
  formatValue,
}: {
  points: Observation[];
  label: string;
  unit?: string;
  color?: string;
  maxGapDays?: number;
  domain?: [number, number];
  onSelect?: (date: string) => void;
  formatDate?: (date: string) => string;
  formatValue?: (value: number) => string;
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
  const min = domain?.[0] ?? lo - pad,
    max = domain?.[1] ?? hi + pad;
  const timestamps = valid.map((p) => Date.parse(p.date));
  const first = Math.min(...timestamps),
    last = Math.max(...timestamps);
  const left = formatValue && domain ? 76 : 12;
  const x = (i: number) =>
    valid.length === 1
      ? (left + 348) / 2
      : left + ((timestamps[i] - first) / (last - first || 1)) * (348 - left);
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
    formatDate?.(s) ??
    new Date(s).toLocaleDateString('uk-UA', {
      day: 'numeric',
      month: 'short',
      ...(s.includes('T') ? { hour: '2-digit' as const, minute: '2-digit' as const } : {}),
      timeZone: 'Europe/Kyiv',
    });
  const fmt = (n: number) =>
    n.toLocaleString('uk-UA', { maximumFractionDigits: unit === 'год' || unit === '/5' ? 1 : 4 });
  const readout = (n: number) => formatValue?.(n) ?? fmt(n) + (unit ? ` ${unit}` : '');
  const selectAt = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const px = Math.max(12, Math.min(348, ((event.clientX - bounds.left) / bounds.width) * 360));
    const nearest = valid.reduce(
      (best, _, i) => (Math.abs(x(i) - px) < Math.abs(x(best) - px) ? i : best),
      0,
    );
    setSelected(nearest);
    onSelect?.(valid[nearest].date);
  };
  return (
    <div className="renewal-observation">
      <div className="flex items-baseline justify-between gap-2" aria-live="polite">
        <span className="text-xs text-tx2">{date(point.date)}</span>
        <b className="font-mono text-sm">
          {point.approx ? '≈ ' : ''}
          {readout(point.value)}
        </b>
      </div>
      <svg
        viewBox="0 0 360 128"
        role="img"
        className="w-full observation-interactive"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          selectAt(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) selectAt(event);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        aria-label={`${label}: мінімум ${readout(lo)}, максимум ${readout(hi)}. ${valid.length} спостережень.`}
      >
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor={color} stopOpacity=".24" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[32, 72, 110].map((h) => (
          <line key={h} x1={left} x2="348" y1={h} y2={h} stroke="var(--color-hair)" />
        ))}
        {domain &&
          [min, (min + max) / 2, max].map((v) => (
            <text
              key={v}
              x={formatValue ? left - 6 : left}
              y={y(v) + (formatValue ? 3 : -4)}
              textAnchor={formatValue ? 'end' : 'start'}
              fill="var(--color-tx3)"
              fontSize={formatValue ? 11 : 9}
            >
              {formatValue?.(v) ?? fmt(v)}
            </text>
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
            fill={p.approx ? 'var(--color-bg2)' : color}
            stroke={color}
            strokeWidth={p.approx ? 2 : 0}
          />
        ))}
      </svg>
      <input
        type="range"
        className="w-full accent-[var(--color-a2)]"
        min={0}
        max={valid.length - 1}
        value={index}
        onChange={(e) => {
          const n = Number(e.target.value);
          setSelected(n);
          onSelect?.(valid[n].date);
        }}
        aria-label={`Дата: ${label}`}
        aria-valuetext={`${date(point.date)}: ${point.approx ? 'приблизно ' : ''}${readout(point.value)}`}
      />
      <div className="flex justify-between text-[11px] text-tx3">
        <span>{date(valid[0].date)}</span>
        <span>{date(valid[valid.length - 1].date)}</span>
      </div>
      {(!formatValue || hasGap) && (
        <p className="renewal-muted mt-2">
          {formatValue ? (
            'Пропуски не з’єднані лінією'
          ) : (
            <>
              Мінімум {fmt(lo)} · максимум {fmt(hi)} {unit}
              {hasGap ? ' · пропуски не з’єднані лінією' : ''}
            </>
          )}
        </p>
      )}
    </div>
  );
}
