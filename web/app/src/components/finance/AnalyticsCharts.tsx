import { useEffect, useId, useRef, useState } from 'react';
import { moneyLabel } from '../../lib/financeView.ts';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
export const analyticsColors = [
  'var(--color-a2)',
  'var(--color-info)',
  'var(--color-pos)',
  'var(--color-a1)',
  'var(--color-tx2)',
  'var(--color-neg)',
];
function categoryColor(category: string) {
  let hash = 0;
  for (const char of category) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 58% 58%)`;
}
export function CategoryDonut({
  rows,
  onSelect,
  onOther,
}: {
  rows: { category: string; amountMinor: number; count: number }[];
  onSelect: (category: string) => void;
  onOther: () => void;
}) {
  const positive = rows.filter((r) => r.amountMinor > 0),
    total = positive.reduce((s, r) => s + r.amountMinor, 0);
  const shown = positive.slice(0, 5),
    others = positive.slice(5);
  const pieces = [
    ...shown,
    ...(others.length
      ? [
          {
            category: '',
            amountMinor: others.reduce((s, r) => s + r.amountMinor, 0),
            count: others.reduce((s, r) => s + r.count, 0),
          },
        ]
      : []),
  ];
  const colors = new Map<string, string>();
  for (const piece of pieces) {
    if (!piece.category) {
      colors.set('', analyticsColors[4]!);
      continue;
    }
    colors.set(piece.category, categoryColor(piece.category));
  }
  const radius = 63,
    circle = 2 * Math.PI * radius;
  let offset = 0;
  if (!total) return <p className="renewal-muted">У вибраному періоді й фільтрах витрат немає.</p>;
  return (
    <>
      <svg
        className="analytics-donut"
        viewBox="0 0 190 190"
        role="img"
        aria-label="Частки особистих витрат за категоріями"
      >
        <title>Витрати за категоріями</title>
        {pieces.map((p) => {
          const length = (p.amountMinor / total) * circle,
            start = offset;
          offset += length;
          return (
            <circle
              key={p.category}
              cx="95"
              cy="95"
              r={radius}
              fill="none"
              stroke={colors.get(p.category)}
              strokeWidth="24"
              strokeDasharray={`${length} ${circle - length}`}
              strokeDashoffset={-start}
              transform="rotate(-90 95 95)"
              onClick={() => (p.category ? onSelect(p.category) : onOther())}
              className="analytics-slice"
            >
              <title>
                {p.category ? financeCategoryLabel(p.category) : 'Інші категорії'}:{' '}
                {moneyLabel(p.amountMinor)}
              </title>
            </circle>
          );
        })}
        <text x="95" y="91" textAnchor="middle" className="analytics-donut-number">
          {positive.length}
        </text>
        <text x="95" y="112" textAnchor="middle" className="analytics-axis">
          категорій
        </text>
      </svg>
      {pieces.map((p) => (
        <button
          type="button"
          className="analytics-category"
          key={p.category}
          onClick={() => (p.category ? onSelect(p.category) : onOther())}
        >
          <span>
            <i style={{ background: colors.get(p.category) }} aria-hidden="true" />
            {p.category ? financeCategoryLabel(p.category) : 'Інші категорії'}
          </span>
          <span>
            <b>{moneyLabel(p.amountMinor)}</b>
            <small>
              {((p.amountMinor / total) * 100).toLocaleString('uk-UA', {
                maximumFractionDigits: 1,
              })}
              % · {p.count} оплат
            </small>
          </span>
        </button>
      ))}
    </>
  );
}
export interface AnalyticsPoint {
  key: string;
  label: string;
  amountMinor: number;
  previousMinor?: number;
}
export function AnalyticsBars({
  points,
  label,
  onSelect,
  selected,
  comparison = false,
  mode = 'bars',
  pickerLabel = 'Обрати точку',
}: {
  points: AnalyticsPoint[];
  label: string;
  onSelect?: (key: string) => void;
  selected?: string | null;
  comparison?: boolean;
  mode?: 'bars' | 'line';
  pickerLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(320),
    id = useId();
  const hasPoints = points.length > 0;
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 100) setWidth(w);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [hasPoints]);
  if (!points.length) return <p className="renewal-muted">За цим вибором даних ще немає.</p>;
  const left = 57,
    right = 8,
    bottom = 143,
    top = 23,
    h = bottom - top,
    max = Math.max(1, ...points.flatMap((p) => [p.amountMinor, p.previousMinor ?? 0])),
    min = Math.min(0, ...points.flatMap((p) => [p.amountMinor, p.previousMinor ?? 0]));
  const y = (v: number) => bottom - ((v - min) / (max - min)) * h,
    zero = y(0);
  const span = Math.max(1, width - left - right),
    step = span / points.length;
  const ticks = [
    ...new Set([
      0,
      Math.floor((points.length - 1) / 3),
      Math.floor(((points.length - 1) * 2) / 3),
      points.length - 1,
    ]),
  ];
  const chosen = points.find((p) => p.key === selected);
  return (
    <div ref={ref} className="analytics-bars">
      {comparison && (
        <p className="analytics-legend">
          <span>
            <i style={{ background: 'var(--color-a2)' }} />
            Обраний
          </span>
          <span>
            <i style={{ background: 'var(--color-info)' }} />
            Попередній
          </span>
        </p>
      )}
      <svg
        width="100%"
        height="180"
        viewBox={`0 0 ${width} 180`}
        role="img"
        aria-label={label}
        onClick={(e) => {
          if (!onSelect) return;
          const box = e.currentTarget.getBoundingClientRect(),
            x = ((e.clientX - box.left) / box.width) * width,
            py = ((e.clientY - box.top) / box.height) * 180;
          if (x < left || x > width - right || py < top || py > bottom) return;
          const index = Math.max(0, Math.min(points.length - 1, Math.floor((x - left) / step)));
          onSelect(points[index]!.key);
        }}
      >
        <title>{label}</title>
        <text x="3" y="14" className="analytics-axis">
          ₴
        </text>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={width - right}
              y1={bottom - t * h}
              y2={bottom - t * h}
              className="analytics-gridline"
            />
            <text x={left - 8} y={bottom - t * h + 4} textAnchor="end" className="analytics-axis">
              {((min + (max - min) * t) / 100).toLocaleString('uk-UA', {
                notation: 'compact',
                maximumFractionDigits: 1,
              })}
            </text>
          </g>
        ))}
        {mode === 'line' && (
          <path
            d={points
              .map((p, i) => `${i ? 'L' : 'M'}${left + (i + 0.5) * step} ${y(p.amountMinor)}`)
              .join(' ')}
            fill="none"
            stroke="var(--color-a2)"
            strokeWidth="2.5"
          />
        )}
        {mode === 'line' && points.length === 1 && (
          <circle
            cx={left + step * 0.5}
            cy={y(points[0]!.amountMinor)}
            r="4"
            fill="var(--color-a2)"
          />
        )}
        {mode === 'bars' &&
          points.map((p, i) => (
            <g key={p.key} opacity={selected && selected !== p.key ? 0.35 : 1}>
              <rect
                x={left + i * step + step * 0.14}
                y={Math.min(zero, y(p.amountMinor))}
                width={Math.max(1, step * (comparison ? 0.33 : 0.72))}
                height={Math.abs(y(p.amountMinor) - zero)}
                rx="2"
                fill={p.amountMinor < 0 ? 'var(--color-neg)' : 'var(--color-a2)'}
              >
                <title>
                  {p.label}: {moneyLabel(p.amountMinor)}
                </title>
              </rect>
              {comparison && (
                <rect
                  x={left + i * step + step * 0.53}
                  y={Math.min(zero, y(p.previousMinor ?? 0))}
                  width={Math.max(1, step * 0.33)}
                  height={Math.abs(y(p.previousMinor ?? 0) - zero)}
                  rx="2"
                  fill="var(--color-info)"
                >
                  <title>Попередній: {moneyLabel(p.previousMinor ?? 0)}</title>
                </rect>
              )}
            </g>
          ))}
        {ticks.map((i) => (
          <text
            key={i}
            x={left + (i + 0.5) * step}
            y="167"
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
            className="analytics-axis"
          >
            {points[i]!.label}
          </text>
        ))}
      </svg>
      {onSelect && (
        <label className="renewal-field analytics-chart-picker" htmlFor={id}>
          {pickerLabel}
          <select id={id} value={selected ?? ''} onChange={(e) => onSelect(e.target.value)}>
            <option value="">Увесь період</option>
            {points.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label} · {moneyLabel(p.amountMinor)}
              </option>
            ))}
          </select>
        </label>
      )}
      {chosen && (
        <p className="renewal-chart-note" aria-live="polite">
          {chosen.label}: {moneyLabel(chosen.amountMinor)}
        </p>
      )}
    </div>
  );
}
