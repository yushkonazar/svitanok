import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import type { CheckinSlot } from '../../api/schema.ts';
import { stateDate, stateDays, slotNames } from './state-format.ts';
import {
  stateBand,
  stateBandNames,
  stateBuckets,
  stateExact,
  stateHasSlots,
  stateMetricNames,
  stateRollup,
  stateSeries,
  stateSlotColors,
  stateSlots,
  stateValues,
  type StateMetricKey,
  type StateSlotFilter,
} from './state-series.ts';
import { StateLevel } from './StateVisuals.tsx';

export function StateTimeline({
  days,
  previous,
  metric,
  slot,
  selected,
  highlighted,
  onSelect,
}: {
  days: AdaptiveDay[];
  previous: AdaptiveDay[];
  metric: StateMetricKey;
  slot: StateSlotFilter;
  selected: string;
  highlighted?: string[];
  onSelect: (date: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    if (!root.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.round(entry?.contentRect.width ?? 0);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const weekly = days.length === 90;
  const hasSlots = stateHasSlots(metric);
  const sleep = metric === 'sleep',
    change = metric === 'change';
  const lines = useMemo(() => {
    const slots: readonly CheckinSlot[] =
      hasSlots && slot === 'all' ? stateSlots : [hasSlots && slot !== 'all' ? slot : 'evening'];
    return slots.map((slot) => {
      const series = stateSeries(days, metric, slot);
      return {
        slot,
        series,
        past: stateSeries(previous, metric, slot),
        buckets: stateBuckets(series, metric, weekly),
        color: stateSlotColors[hasSlots ? stateSlots.indexOf(slot) : 0]!,
      };
    });
  }, [days, previous, hasSlots, metric, slot, weekly]);
  const at = Math.max(
    0,
    days.findIndex((day) => day.date === selected),
  );
  const values = lines.flatMap((line) => stateValues(line.series));
  const top = 14,
    bottom = 130,
    left = 71,
    right = Math.max(left + 50, width - 10);
  const max = sleep ? Math.max(8, Math.ceil(Math.max(...values) / 2) * 2) : change ? 4 : 5;
  const min = sleep ? 0 : change ? -4 : 1;
  const x = (i: number) => left + (i / Math.max(1, days.length - 1)) * (right - left);
  const y = (value: number) => bottom - ((value - min) / (max - min)) * (bottom - top);
  const axis =
    metric === 'sleep'
      ? ['0 год', `${max / 2} год`, `${max} год`]
      : metric === 'energy'
        ? ['Мало', 'Помірно', 'Багато']
        : stateBandNames[metric];
  const caption = weekly ? (sleep ? 'Медіани за тижнями' : 'Середні за тижнями') : 'За днями';
  const dates = new Set(highlighted);
  const selectedBucket = lines[0]?.buckets.find(({ start, end }) => at >= start && at < end);
  const activeX = x(selectedBucket ? (selectedBucket.start + selectedBucket.end - 1) / 2 : at);
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.round(((px - left) / (right - left)) * (days.length - 1));
    const day = days[Math.max(0, Math.min(days.length - 1, index))];
    if (day) onSelect(day.date);
  };
  const word = (value: number | null) =>
    value == null
      ? 'немає даних'
      : metric === 'sleep'
        ? stateExact(metric, value)
        : stateBandNames[metric][stateBand(value, metric)].toLowerCase();
  const periodValue = (series: (number | null)[]) => {
    const value = stateRollup(series, metric);
    return value == null
      ? 'немає записів'
      : `${stateExact(metric, value)} · ${stateDays(stateValues(series).length)}`;
  };
  return (
    <div ref={root} className="state-timeline">
      {values.length ? (
        <>
          <div className="state-chart-heading">
            <b>{stateDate(selected)}</b>
            <span>{caption}</span>
          </div>
          <svg
            viewBox={`0 0 ${width} 146`}
            role="img"
            aria-label={`${stateMetricNames[metric]}: ${caption.toLowerCase()}. Пропущені оцінки залишаються порожніми.`}
            className="state-chart"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              pick(event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) pick(event);
            }}
            onPointerUp={(event) => event.currentTarget.releasePointerCapture?.(event.pointerId)}
            onPointerCancel={(event) =>
              event.currentTarget.releasePointerCapture?.(event.pointerId)
            }
          >
            {[min, (min + max) / 2, max].map((value, index) => (
              <g key={value}>
                <line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="var(--color-hair)" />
                <text
                  x={left - 8}
                  y={y(value) + 4}
                  textAnchor="end"
                  fill="var(--color-tx2)"
                  fontSize="11"
                >
                  {axis[index]}
                </text>
              </g>
            ))}
            <g className="state-cursor-motion" style={{ transform: `translateX(${activeX}px)` }}>
              <line
                y1={top}
                y2={bottom}
                stroke="var(--color-tx2)"
                strokeDasharray="3 4"
                opacity=".65"
              />
            </g>
            {lines.map(({ slot, buckets, color }) => {
              let connected = false;
              const points = buckets.flatMap(({ start, end, value }) => {
                if (value == null) {
                  connected = false;
                  return [];
                }
                const point = {
                  start,
                  value,
                  x: x((start + end - 1) / 2),
                  open: !connected,
                  active: at >= start && at < end,
                  marked:
                    dates.size > 0 && days.slice(start, end).some((day) => dates.has(day.date)),
                };
                connected = true;
                return [point];
              });
              const active = points.find((point) => point.active);
              return (
                <g key={slot}>
                  <path
                    d={points.map((p) => `${p.open ? 'M' : 'L'}${p.x} ${y(p.value)}`).join(' ')}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeDasharray={
                      lines.length > 1
                        ? [undefined, '5 3', '2 3'][stateSlots.indexOf(slot)]
                        : undefined
                    }
                    strokeLinecap="round"
                    opacity={dates.size ? '.55' : '1'}
                  />
                  {points.map((p) => (
                    <circle
                      key={p.start}
                      cx={p.x}
                      cy={y(p.value)}
                      r={p.marked ? 4 : weekly ? 3 : 2.4}
                      fill={color}
                      opacity={dates.size && !p.marked ? '.45' : '1'}
                    />
                  ))}
                  {active && (
                    <g
                      className="state-cursor-motion"
                      style={{ transform: `translate(${active.x}px, ${y(active.value)}px)` }}
                    >
                      <circle r="5" fill={color} stroke="var(--color-bg)" strokeWidth="1.5" />
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
          <label className="state-range-label" htmlFor={id}>
            Дата на графіку
          </label>
          <input
            id={id}
            type="range"
            min={0}
            max={days.length - 1}
            value={at}
            aria-label={`Дата: ${stateMetricNames[metric]}`}
            aria-valuetext={`${stateDate(selected)}. ${lines
              .map(
                (line) =>
                  `${hasSlots ? `${slotNames[line.slot]}: ` : ''}${word(line.series[at] ?? null)}`,
              )
              .join('. ')}`}
            onChange={(event) => {
              const day = days[Number(event.target.value)];
              if (day) onSelect(day.date);
            }}
          />
          <div className="state-chart-ends">
            <span>{stateDate(days[0]!.date)}</span>
            <span>{stateDate(days.at(-1)!.date)}</span>
          </div>
          <div className="state-chart-legend" aria-live="polite">
            {lines.map(({ slot, color, series }) => {
              const value = series[at] ?? null;
              return (
                <span key={slot}>
                  {value != null && !sleep && !change && <StateLevel color={color} value={value} />}
                  {hasSlots && <span>{slotNames[slot]} · </span>}
                  <b>{word(value)}</b>
                </span>
              );
            })}
          </div>
          <details className="state-subdetails state-exact">
            <summary>Точні значення за період</summary>
            {lines.map(({ slot, series, past }) => (
              <div key={slot}>
                <b>
                  {hasSlots ? `${slotNames[slot]} · ` : ''}
                  {sleep ? 'Медіана' : 'Середнє'}
                </b>
                <p className="state-caption">Цей період · {periodValue(series)}</p>
                <p className="state-caption">Попередній період · {periodValue(past)}</p>
              </div>
            ))}
          </details>
        </>
      ) : (
        <p className="state-empty">Для цього показника ще немає підтверджених оцінок.</p>
      )}
    </div>
  );
}
