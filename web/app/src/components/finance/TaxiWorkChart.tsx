import { useId, useState } from 'react';
import type { TaxiWork } from '../../lib/taxiWork.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { taxiRangeLabel } from '../../lib/taxiPeriods.ts';
import { amountNumber } from './analytics-format.ts';
import { axisMoney, useChartWidth } from './useChartWidth.ts';

const date = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Kyiv',
});
const time = new Intl.DateTimeFormat('uk-UA', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Kyiv',
});
const stamp = (at: number) => `${date.format(at)} · ${time.format(at)}`;
const VISIBLE_SHIFTS = 7;

export function TaxiWorkChart({
  work,
  onEditShift,
}: {
  work: TaxiWork;
  onEditShift?: (id: string) => void;
}) {
  const [mode, setMode] = useState<'pace' | 'shift'>('pace');
  const [checkpoint, setCheckpoint] = useState<number | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const gradientId = useId();
  const { ref, width } = useChartWidth();
  const shiftMode = mode === 'shift';
  const { pace, shifts } = work;
  const total = shiftMode ? shifts.length : pace.length;
  const requested = shiftMode ? shifts.findIndex((shift) => shift.id === shiftId) : checkpoint;
  const index = requested == null || requested < 0 ? total - 1 : Math.min(requested, total - 1);
  const start = shiftMode ? Math.max(0, Math.min(index - 3, total - VISIBLE_SHIFTS)) : 0;
  const points = shiftMode
    ? shifts.slice(start, start + VISIBLE_SHIFTS).map((shift) => ({
        at: Date.parse(shift.at),
        earnedMinor: shift.earnedMinor,
        previousMinor: null,
      }))
    : pace;
  const active = points[index - start];
  const selectedShift = shiftMode ? shifts[index] : undefined;
  const comparison = !shiftMode && work.previousReady;
  const values = points.flatMap((point) => [point.earnedMinor, point.previousMinor ?? 0]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const top = 10;
  const bottom = 110;
  const height = 137;
  const left = 54;
  const right = width - 20;
  const span = max - min || 100;
  const y = (amount: number) => bottom - ((amount - min) / span) * (bottom - top);
  const step = (right - left) / Math.max(1, shiftMode ? points.length : points.length - 1);
  const x = (i: number) => left + (shiftMode ? (i + 0.5) * step : i * step);
  const zero = y(0);
  const barWidth = Math.min(24, step * 0.56);
  const axis = [0];
  for (const amount of [min, max, Math.round((max + min) / 2)]) {
    if (axis.every((tick) => Math.abs(y(tick) - y(amount)) >= 14)) axis.push(amount);
  }
  const line = points.map((p, i) => `${x(i)},${y(p.earnedMinor)}`).join(' ');
  const labelAt = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
  const withinDay =
    !shiftMode && pace[0] && date.format(pace[0].at) === date.format(pace.at(-1)!.at);
  const select = (i: number) => {
    if (shiftMode) setShiftId(shifts[i]?.id ?? null);
    else setCheckpoint(i === pace.length - 1 ? null : i);
  };

  return (
    <div className="taxi-chart">
      <div className="renewal-segments" role="group" aria-label="Графік заробітку таксі">
        <button type="button" aria-pressed={!shiftMode} onClick={() => setMode('pace')}>
          Темп періоду
        </button>
        <button type="button" aria-pressed={shiftMode} onClick={() => setMode('shift')}>
          По змінах
        </button>
      </div>
      <div ref={ref}>
        {active && (shifts.length > 0 || comparison) ? (
          <>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={shiftMode ? 'Внесок кожної зміни' : 'Заробіток від початку періоду'}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                if (!rect.width) return;
                const position = ((event.clientX - rect.left) / rect.width) * width;
                const nearest = Math.round((position - left) / step - (shiftMode ? 0.5 : 0));
                select(start + Math.max(0, Math.min(points.length - 1, nearest)));
              }}
            >
              <defs>
                <linearGradient id={gradientId} x2="0" y2="1">
                  <stop offset="0" stopColor="currentColor" stopOpacity=".23" />
                  <stop offset="1" stopColor="currentColor" stopOpacity=".02" />
                </linearGradient>
              </defs>
              {axis.map((amount) => (
                <g key={amount}>
                  <line className="taxi-grid" x1={left} x2={right} y1={y(amount)} y2={y(amount)} />
                  <text x={left - 7} y={y(amount) + 3} textAnchor="end">
                    {Math.abs(amount) < 1000 ? amountNumber(amount) : axisMoney(amount)}
                  </text>
                </g>
              ))}
              {shiftMode ? (
                points.map((point, i) => (
                  <rect
                    key={shifts[start + i]!.id}
                    className={`taxi-bar${i === index - start ? ' taxi-bar-selected' : ''}`}
                    x={x(i) - barWidth / 2}
                    y={Math.min(y(point.earnedMinor), zero)}
                    width={barWidth}
                    height={Math.max(2, Math.abs(y(point.earnedMinor) - zero))}
                    rx="3"
                  />
                ))
              ) : (
                <>
                  {shifts.length > 0 && (
                    <polygon
                      points={`${x(0)},${zero} ${line} ${x(points.length - 1)},${zero}`}
                      fill={`url(#${gradientId})`}
                    />
                  )}
                  {comparison && (
                    <polyline
                      className="taxi-line-previous"
                      points={points
                        .map((point, i) => `${x(i)},${y(point.previousMinor ?? 0)}`)
                        .join(' ')}
                    />
                  )}
                  {shifts.length > 0 && <polyline className="taxi-line-current" points={line} />}
                  <line
                    className="taxi-grid taxi-chart-cursor"
                    x1={x(index)}
                    x2={x(index)}
                    y1={top}
                    y2={bottom}
                  />
                  {active.previousMinor !== null && (
                    <circle
                      className="taxi-dot-previous"
                      cx={x(index)}
                      cy={y(active.previousMinor)}
                      r="4"
                    />
                  )}
                  {shifts.length > 0 && (
                    <circle
                      className="taxi-dot-current"
                      cx={x(index)}
                      cy={y(active.earnedMinor)}
                      r="5"
                    />
                  )}
                </>
              )}
              {points.map((point, i) =>
                labelAt.has(i) ? (
                  <text key={i} x={x(i)} y={height - 8} textAnchor="middle">
                    {withinDay ? time.format(point.at) : date.format(point.at)}
                  </text>
                ) : null,
              )}
            </svg>
            {total > 1 && (
              <input
                className="taxi-chart-range"
                type="range"
                min={0}
                max={total - 1}
                value={index}
                aria-label={shiftMode ? 'Обрати зміну' : 'Обрати момент періоду'}
                aria-valuetext={stamp(active.at)}
                onChange={(event) => select(Number(event.target.value))}
              />
            )}
            <div className="taxi-chart-readout" aria-live="polite">
              <div className="taxi-chart-value">
                <span>
                  {selectedShift ? 'Внесок зміни' : 'Цей період'} · {stamp(active.at)}
                </span>
                <b>{moneyLabel(active.earnedMinor)}</b>
              </div>
              {active.previousMinor !== null && (
                <div className="taxi-chart-value taxi-chart-previous">
                  <span>Минулий · {stamp(pace[index]!.previousAt)}</span>
                  <b>{moneyLabel(active.previousMinor)}</b>
                </div>
              )}
              {selectedShift && (
                <>
                  <p className="taxi-shift-details">
                    Каса {moneyLabel(selectedShift.grossMinor)} · Комісія{' '}
                    {selectedShift.commissionReported === false
                      ? 'потребує уточнення'
                      : moneyLabel(selectedShift.commissionMinor)}{' '}
                    · Пальне {moneyLabel(selectedShift.fuelMinor)}
                    {selectedShift.dayComplete === false && ' · Зміна триває'}
                  </p>
                  {onEditShift && (
                    <button
                      type="button"
                      className="renewal-link"
                      onClick={() => onEditShift(selectedShift.id)}
                    >
                      Уточнити зміну
                    </button>
                  )}
                </>
              )}
            </div>
            {comparison && work.differentTerms && (
              <p className="renewal-chart-note">
                Минулий період мав інші умови або авто ·{' '}
                {taxiRangeLabel(work.previousPeriod.from, work.previousPeriod.to)}
              </p>
            )}
            {!shiftMode && !comparison && (
              <p className="renewal-chart-note">Немає зіставних записів за минулий період.</p>
            )}
          </>
        ) : (
          <p className="taxi-chart-empty">Графік з’явиться після першого запису зміни.</p>
        )}
      </div>
    </div>
  );
}
