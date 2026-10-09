import { useId, useState } from 'react';
import type { WeatherLocation } from '../../api/briefing-schema.ts';
/** Both provider measurements are visible; missing data is not a zero. */
export function PrecipitationChart({ hourly }: { hourly: NonNullable<WeatherLocation['hourly']> }) {
  const [index, setIndex] = useState(0);
  const points = hourly.filter((p) => p.popPercent != null || p.precipMm != null);
  if (!points.length) return null;
  const i = Math.min(index, points.length - 1),
    selected = points[i],
    max = Math.max(1, ...points.map((p) => p.precipMm ?? 0));
  const x = (n: number) => 18 + (n / Math.max(1, points.length - 1)) * 324,
    y = (n: number) => 106 - (n / 100) * 82;
  const path = points
    .map((p, n) =>
      p.popPercent == null
        ? ''
        : `${n === 0 || points[n - 1].popPercent == null ? 'M' : 'L'}${x(n)} ${y(p.popPercent)}`,
    )
    .join(' ');
  const hour = (h: number) => String(h).padStart(2, '0') + ':00';
  return (
    <section className="renewal-rain" aria-label="Погодинний прогноз опадів">
      <div className="renewal-section-head">
        <span className="renewal-eyebrow">ОПАДИ ПО ГОДИНАХ</span>
        <b className="text-xs text-info">{hour(selected.h)}</b>
      </div>
      <div className="weather-legend">
        <span>
          <i style={{ background: 'var(--color-info)' }} />
          Стовпчики · мм
        </span>
        <span>
          <i style={{ background: 'var(--color-a2)' }} />
          Лінія · імовірність
        </span>
      </div>
      <svg
        className="w-full"
        viewBox="0 0 360 139"
        role="img"
        aria-label="Кількість опадів у міліметрах та імовірність у відсотках"
      >
        <text x="6" y="12" fill="var(--color-info)" fontSize="10">
          {max.toFixed(1)} мм
        </text>
        <text x="348" y="12" textAnchor="end" fill="var(--color-a2)" fontSize="10">
          100%
        </text>
        {[24, 65, 106].map((y) => (
          <line key={y} x1="18" x2="342" y1={y} y2={y} stroke="var(--color-hair)" />
        ))}
        {points.map((p, n) => (
          <g key={p.at ?? n}>
            {p.precipMm != null && (
              <rect
                x={x(n) - Math.min(8, 130 / points.length)}
                y={106 - (p.precipMm / max) * 82}
                width={Math.min(16, 260 / points.length)}
                height={Math.max(p.precipMm > 0 ? 2 : 0, (p.precipMm / max) * 82)}
                rx="3"
                fill="var(--color-info)"
                fillOpacity={i === n ? 1 : 0.6}
              />
            )}
            <rect
              role="button"
              tabIndex={0}
              aria-label={`${hour(p.h)}: ${p.popPercent == null ? 'імовірність невідома' : p.popPercent + '%'}, ${p.precipMm == null ? 'кількість невідома' : p.precipMm.toFixed(1) + ' мм'}`}
              aria-pressed={i === n}
              onClick={() => setIndex(n)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setIndex(n);
                }
              }}
              x={x(n) - 10}
              y="18"
              width="20"
              height="96"
              fill="transparent"
            />
            {(n === 0 || n === points.length - 1 || n % Math.ceil(points.length / 5) === 0) && (
              <text x={x(n)} y="132" textAnchor="middle" fill="var(--color-tx2)" fontSize="10">
                {String(p.h).padStart(2, '0')}
              </text>
            )}
          </g>
        ))}
        <path
          d={path}
          fill="none"
          stroke="var(--color-a2)"
          strokeWidth="2.5"
          pointerEvents="none"
        />
        {selected.popPercent != null && (
          <circle
            cx={x(i)}
            cy={y(selected.popPercent)}
            r="4"
            fill="var(--color-a2)"
            pointerEvents="none"
          />
        )}
        <line
          x1={x(i)}
          x2={x(i)}
          y1="18"
          y2="111"
          stroke="var(--color-tx2)"
          strokeDasharray="3 4"
          pointerEvents="none"
        />
      </svg>
      <input
        className="w-full accent-[var(--color-info)]"
        type="range"
        min={0}
        max={points.length - 1}
        value={i}
        onChange={(e) => setIndex(Number(e.target.value))}
        aria-label="Година прогнозу опадів"
        aria-valuetext={hour(selected.h)}
      />
      <div className="weather-selected" aria-live="polite">
        <div>
          <small>Імовірність</small>
          <b>{selected.popPercent == null ? 'Немає даних' : `${selected.popPercent}%`}</b>
        </div>
        <div>
          <small>Кількість за годину</small>
          <b>{selected.precipMm == null ? 'Немає даних' : `${selected.precipMm.toFixed(1)} мм`}</b>
        </div>
      </div>
      <p className="renewal-chart-note mt-2">
        Ліва шкала — мм, права — %. Це погодинний, а не хвилинний прогноз.
      </p>
    </section>
  );
}
export function HourlyChart({ hourly }: { hourly: { h: number; t: number; at?: number }[] }) {
  const uid = useId(),
    [selected, setSelected] = useState(0);
  const pts = hourly.filter((p) => Number.isFinite(p.t));
  if (!pts.length) return <p className="renewal-muted">Температурний прогноз недоступний.</p>;
  const i = Math.min(selected, pts.length - 1),
    min = Math.min(...pts.map((p) => p.t)),
    max = Math.max(...pts.map((p) => p.t)),
    pad = Math.max(1, (max - min) * 0.2);
  // Provider order spans midnight: next-day 00:00 never jumps before 23:00.
  const timestamps = pts.map((p, n) =>
    p.at != null && Number.isFinite(p.at) ? p.at * 1000 : n * 3600000,
  );
  const span = timestamps.at(-1)! - timestamps[0];
  const x = (n: number) =>
    18 +
    (span > 0 ? (timestamps[n] - timestamps[0]) / span : n / Math.max(1, pts.length - 1)) * 324;
  const y = (v: number) => 104 - ((v - min + pad) / (max - min + 2 * pad)) * 78;
  const line = pts.map((p, n) => `${n ? 'L' : 'M'}${x(n)} ${y(p.t)}`).join(' ');
  const format = (t: number) =>
    `${t > 0 ? '+' : ''}${t.toLocaleString('uk-UA', { maximumFractionDigits: 1 })}°`;
  const time = (p: (typeof pts)[number]) => `${String(p.h).padStart(2, '0')}:00`;
  return (
    <section className="weather-temperature">
      <div className="renewal-section-head">
        <span className="renewal-eyebrow">ТЕМПЕРАТУРА ПО ГОДИНАХ</span>
        <b className="text-sm text-a2" aria-live="polite">
          {time(pts[i])} · {format(pts[i].t)}
        </b>
      </div>
      <svg viewBox="0 0 360 135" className="w-full" role="img" aria-label="температура по годинах">
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="var(--color-a2)" stopOpacity=".3" />
            <stop offset="1" stopColor="var(--color-a1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[min, (min + max) / 2, max]
          .filter((v, n, a) => a.indexOf(v) === n)
          .map((v) => (
            <g key={v}>
              <line x1="18" x2="342" y1={y(v)} y2={y(v)} stroke="var(--color-hair)" />
              <text x="18" y={y(v) - 5} fontSize="10" fill="var(--color-tx2)">
                {format(v)}
              </text>
            </g>
          ))}
        <path d={`${line} L${x(pts.length - 1)} 112 L${x(0)} 112 Z`} fill={`url(#${uid})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--color-a2)"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <line x1={x(i)} x2={x(i)} y1="18" y2="112" stroke="var(--color-a2)" strokeDasharray="3 4" />
        {pts.map((p, n) => (
          <g key={p.at ?? n}>
            <circle cx={x(n)} cy={y(p.t)} r={i === n ? 5 : 2} fill="var(--color-a2)" />
            {(n === 0 || n === pts.length - 1 || n % Math.ceil(pts.length / 5) === 0) && (
              <text x={x(n)} y="132" textAnchor="middle" fill="var(--color-tx2)" fontSize="10">
                {String(p.h).padStart(2, '0')}
              </text>
            )}
          </g>
        ))}
      </svg>
      <input
        type="range"
        className="w-full accent-[var(--color-a2)]"
        min={0}
        max={pts.length - 1}
        value={i}
        onChange={(e) => setSelected(Number(e.target.value))}
        aria-label="Година прогнозу температури"
        aria-valuetext={`${time(pts[i])}: ${format(pts[i].t)}`}
      />
      <p className="renewal-chart-note">
        Від {format(min)} до {format(max)} · обери годину на повзунку.
      </p>
    </section>
  );
}
