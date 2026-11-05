import { useId } from 'react';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import { stateDate, stateNumber, slotNames } from './state-format.ts';
const slots = ['morning', 'afternoon', 'evening'] as const;
const colors = ['var(--color-a2)', 'var(--color-info)', 'var(--color-pos)'];
export function StateTimeline({
  days,
  metric,
  selected,
  onSelect,
}: {
  days: AdaptiveDay[];
  metric: 'energy' | 'mood';
  selected: string;
  onSelect: (date: string) => void;
}) {
  const id = useId(),
    at = Math.max(
      0,
      days.findIndex((d) => d.date === selected),
    );
  const x = (i: number) => 20 + (i / Math.max(1, days.length - 1)) * 320,
    y = (v: number) => 124 - (v - 1) * 26;
  const hasData = days.some((d) =>
    slots.some((s) => typeof d[s][metric] === 'number' && d[s][metric] >= 1 && d[s][metric] <= 5),
  );
  if (!hasData)
    return <p className="state-empty">Для цього показника ще немає підтверджених оцінок.</p>;
  const pick = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((event.clientX - rect.left) / rect.width) * 360;
    const index = Math.max(
      0,
      Math.min(days.length - 1, Math.round(((px - 20) / 320) * (days.length - 1))),
    );
    if (days[index]) onSelect(days[index].date);
  };
  return (
    <div className="state-timeline">
      <div className="state-chart-heading">
        <b>{stateDate(selected)}</b>
        <span>Шкала 1–5</span>
      </div>
      <svg
        viewBox="0 0 360 145"
        role="img"
        aria-label={`${metric === 'energy' ? 'Енергія' : 'Настрій'}: ранок, день і вечір. Пропущені оцінки залишаються порожніми.`}
        className="state-chart"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          pick(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture?.(e.pointerId)) pick(e);
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture?.(e.pointerId)}
        onPointerCancel={(e) => e.currentTarget.releasePointerCapture?.(e.pointerId)}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <g key={n}>
            <line x1="20" x2="340" y1={y(n)} y2={y(n)} stroke="var(--color-hair)" />
            <text x="3" y={y(n) + 3} fill="var(--color-tx3)" fontSize="9">
              {n}
            </text>
          </g>
        ))}
        {slots.map((slot, j) => {
          let previous = false;
          const points = days.flatMap((d, i) => {
            const v = d[slot][metric];
            if (typeof v !== 'number' || v < 1 || v > 5) {
              previous = false;
              return [];
            }
            const point = { i, v, start: !previous };
            previous = true;
            return [point];
          });
          return (
            <g key={slot}>
              <path
                d={points.map((p) => `${p.start ? 'M' : 'L'}${x(p.i)} ${y(p.v)}`).join(' ')}
                fill="none"
                stroke={colors[j]}
                strokeWidth="2"
                strokeDasharray={j === 1 ? '5 3' : j === 2 ? '2 3' : undefined}
                strokeLinecap="round"
              />
              {points.map((p) => (
                <circle
                  key={p.i}
                  cx={x(p.i)}
                  cy={y(p.v)}
                  r={p.i === at ? 4.2 : 2}
                  fill={colors[j]}
                  stroke={p.i === at ? 'var(--color-bg)' : 'none'}
                  strokeWidth="1.5"
                />
              ))}
            </g>
          );
        })}
        <line
          x1={x(at)}
          x2={x(at)}
          y1="15"
          y2="132"
          stroke="var(--color-tx2)"
          strokeDasharray="3 4"
          opacity=".6"
        />
      </svg>
      <label className="state-range-label" htmlFor={id}>
        Дата на графіку
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={Math.max(0, days.length - 1)}
        value={at}
        aria-label={`Дата: ${metric === 'energy' ? 'Енергія' : 'Настрій'}`}
        aria-valuetext={`${stateDate(selected)}. ${slots.map((slot) => `${slotNames[slot]}: ${typeof days[at]?.[slot][metric] === 'number' ? stateNumber(days[at]![slot][metric] as number) : 'немає оцінки'}`).join('. ')}`}
        onChange={(e) => {
          const day = days[Number(e.target.value)];
          if (day) onSelect(day.date);
        }}
      />
      <div className="state-chart-ends">
        <span>{stateDate(days[0]!.date)}</span>
        <span>{stateDate(days.at(-1)!.date)}</span>
      </div>
      <div className="state-chart-legend">
        {slots.map((slot, i) => (
          <div key={slot}>
            <i style={{ background: colors[i] }} aria-hidden="true" />
            <span>{slotNames[slot]}</span>
            <b>
              {stateNumber(
                typeof days[at]?.[slot][metric] === 'number'
                  ? (days[at]![slot][metric] as number)
                  : null,
              )}
            </b>
          </div>
        ))}
      </div>
    </div>
  );
}
