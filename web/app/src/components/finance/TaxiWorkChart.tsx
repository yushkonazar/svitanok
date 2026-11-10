import { useId, useState } from 'react';
import type { TaxiWork } from '../../lib/taxiWork.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { taxiRangeLabel } from '../../lib/taxiPeriods.ts';
import { amountNumber, counted } from './analytics-format.ts';
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
const SERIES = [
  { key: 'earnedMinor', tone: 'current', label: 'Поточна' },
  { key: 'previousMinor', tone: 'previous', label: 'Минула' },
  { key: 'averageMinor', tone: 'average', label: 'Середнє' },
] as const;

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
  const visibleShifts = shiftMode ? shifts.slice(start, start + VISIBLE_SHIFTS) : [];
  const selectedShift = shiftMode ? shifts[index] : undefined;
  const selectedPoint = shiftMode ? undefined : pace[index];
  const times = shiftMode
    ? visibleShifts.map((shift) => Date.parse(shift.at))
    : pace.map((point) => point.at);
  const activeAt = times[index - start];
  const activeSeries = SERIES.filter(({ key }) => {
    if (!selectedPoint) return false;
    if (key === 'earnedMinor') return shifts.length > 0;
    return selectedPoint[key] !== null;
  });
  const values = shiftMode
    ? visibleShifts.flatMap((shift) => [
        shift.grossMinor,
        shift.cashReported ? shift.receivedCashMinor : 0,
      ])
    : pace.flatMap((point) => activeSeries.map(({ key }) => point[key] ?? 0));
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const top = 10;
  const bottom = 110;
  const height = 137;
  const left = 51;
  const right = width - 20;
  const span = max - min || 100;
  const y = (amount: number) => bottom - ((amount - min) / span) * (bottom - top);
  const step = (right - left) / Math.max(1, visibleShifts.length);
  const startAt = times[0] ?? 0;
  const elapsed = Math.max(1, (times.at(-1) ?? 0) - startAt);
  const x = (i: number) =>
    shiftMode
      ? left + (i + 0.5) * step
      : left + (((times[i] ?? startAt) - startAt) / elapsed) * (right - left);
  const zero = y(0);
  const barWidth = Math.min(26, step * 0.64);
  const axis = [0];
  for (const amount of [min, max, Math.round((max + min) / 2)]) {
    if (axis.every((tick) => Math.abs(y(tick) - y(amount)) >= 14)) axis.push(amount);
  }
  const stepPath = (key: (typeof SERIES)[number]['key']) =>
    pace
      .map((point, i) =>
        i === 0 ? `M ${x(i)} ${y(point[key] ?? 0)}` : `H ${x(i)} V ${y(point[key] ?? 0)}`,
      )
      .join(' ');
  const labelAt = new Set([0, Math.floor((times.length - 1) / 2), times.length - 1]);
  const withinDay =
    !shiftMode && times.length > 0 && date.format(startAt) === date.format(times.at(-1));
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
        {activeAt !== undefined && (visibleShifts.length > 0 || activeSeries.length > 0) ? (
          <>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={
                shiftMode ? 'Каса й отримана готівка по змінах' : 'Заробіток від початку періоду'
              }
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                if (!rect.width) return;
                const position = ((event.clientX - rect.left) / rect.width) * width;
                let nearest = 0;
                for (let i = 1; i < times.length; i++) {
                  if (Math.abs(x(i) - position) < Math.abs(x(nearest) - position)) nearest = i;
                }
                select(start + nearest);
              }}
            >
              <defs>
                <linearGradient id={gradientId} x2="0" y2="1">
                  <stop offset="0" stopColor="currentColor" stopOpacity=".20" />
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
                visibleShifts.map((shift, i) => (
                  <g
                    key={shift.id}
                    className={`taxi-bar-group${i === index - start ? ' taxi-bar-selected' : ''}`}
                  >
                    <rect
                      className="taxi-bar"
                      x={x(i) - barWidth / 2}
                      y={y(shift.netCashMinor)}
                      width={barWidth}
                      height={Math.max(1, zero - y(shift.netCashMinor))}
                      rx="2"
                    />
                    {shift.commissionMinor > 0 && (
                      <rect
                        className="taxi-bar-fee"
                        x={x(i) - barWidth / 2}
                        y={y(shift.grossMinor)}
                        width={barWidth}
                        height={y(shift.netCashMinor) - y(shift.grossMinor)}
                        rx="2"
                      />
                    )}
                    {shift.cashReported && (
                      <line
                        className="taxi-bar-cash"
                        x1={x(i) - barWidth / 2 - 2}
                        x2={x(i) + barWidth / 2 + 2}
                        y1={y(shift.receivedCashMinor)}
                        y2={y(shift.receivedCashMinor)}
                      />
                    )}
                  </g>
                ))
              ) : (
                <>
                  {shifts.length > 0 && (
                    <path
                      d={`${stepPath('earnedMinor')} V ${zero} H ${x(0)} Z`}
                      fill={`url(#${gradientId})`}
                    />
                  )}
                  <line
                    className="taxi-grid taxi-chart-cursor"
                    x1={x(index)}
                    x2={x(index)}
                    y1={top}
                    y2={bottom}
                  />
                  {[...activeSeries].reverse().map(({ key, tone }) => (
                    <g key={key}>
                      <path className={`taxi-line-${tone}`} d={stepPath(key)} />
                      <circle
                        className={`taxi-dot-${tone}`}
                        cx={x(index)}
                        cy={y(selectedPoint?.[key] ?? 0)}
                        r={tone === 'current' ? 5 : 4}
                      />
                    </g>
                  ))}
                </>
              )}
              {times.map((at, i) =>
                labelAt.has(i) ? (
                  <text key={i} x={x(i)} y={height - 8} textAnchor="middle">
                    {withinDay ? time.format(at) : date.format(at)}
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
                aria-valuetext={stamp(activeAt)}
                onChange={(event) => select(Number(event.target.value))}
              />
            )}
            {selectedShift ? (
              <div className="taxi-shift-readout" aria-live="polite">
                <div className="taxi-work-row">
                  <span>Твій заробіток · {stamp(activeAt)}</span>
                  <b>
                    {selectedShift.commissionReported ? '' : '≈ '}
                    {moneyLabel(selectedShift.earnedMinor)}
                  </b>
                </div>
                <dl className="taxi-work-ledger">
                  <dt>Каса до комісії</dt>
                  <dd>
                    {selectedShift.commissionReported
                      ? moneyLabel(selectedShift.grossMinor)
                      : 'Уточнити комісію'}
                  </dd>
                  <dt className="taxi-swatch taxi-swatch-current">Чиста каса</dt>
                  <dd>{moneyLabel(selectedShift.netCashMinor)}</dd>
                  <dt className="taxi-swatch taxi-swatch-fee">Комісія</dt>
                  <dd>
                    {selectedShift.commissionReported
                      ? moneyLabel(selectedShift.commissionMinor)
                      : 'Уточнити'}
                  </dd>
                  <dt className="taxi-swatch taxi-swatch-cash">Отримана готівка</dt>
                  <dd>
                    {selectedShift.cashReported
                      ? moneyLabel(selectedShift.receivedCashMinor)
                      : 'Уточнити'}
                  </dd>
                  <dt>Пальне</dt>
                  <dd>{moneyLabel(selectedShift.fuelMinor)}</dd>
                </dl>
                {selectedShift.dayComplete === false && (
                  <p className="renewal-chart-note">Зміна триває.</p>
                )}
                {onEditShift && (
                  <button
                    type="button"
                    className="renewal-link"
                    onClick={() => onEditShift(selectedShift.id)}
                  >
                    Уточнити зміну
                  </button>
                )}
              </div>
            ) : (
              selectedPoint && (
                <div className="taxi-pace-readout" aria-live="polite">
                  <p className="renewal-chart-note">Накопичено до {stamp(activeAt)}</p>
                  <table className="taxi-data-table" aria-label="Темп до вибраного моменту">
                    <thead>
                      <tr>
                        <th scope="col">Перезмінка</th>
                        <th scope="col">Разом, ₴</th>
                        <th scope="col">Приріст</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeSeries.map(({ key, tone, label }) => {
                        const previous = pace[index - 1]?.[key];
                        const value = selectedPoint[key] ?? 0;
                        const change = previous == null ? null : value - previous;
                        return (
                          <tr key={key}>
                            <th scope="row" className={`taxi-swatch taxi-swatch-${tone}`}>
                              {label}
                            </th>
                            <td>{amountNumber(value)}</td>
                            <td>
                              {change === null
                                ? '—'
                                : `${change > 0 ? '+' : ''}${amountNumber(change)}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <details className="taxi-pace-help">
                    <summary>Як читати темп</summary>
                    <p>
                      Кожна точка показує заробіток від старту перезмінки до кінця дня або поточного
                      часу. Рівна ділянка означає нульовий приріст за записами.
                    </p>
                    {work.previousReady && (
                      <p>
                        Минула · {taxiRangeLabel(work.previousPeriod.from, work.previousPeriod.to)}
                        {work.differentTerms ? ' · інші умови або авто' : ''}.
                      </p>
                    )}
                    {work.averagePeriods > 0 && (
                      <p>
                        Середній темп ·{' '}
                        {counted(
                          work.averagePeriods,
                          'зіставна завершена перезмінка',
                          'зіставні завершені перезмінки',
                          'зіставних завершених перезмінок',
                        )}
                        .
                      </p>
                    )}
                  </details>
                </div>
              )
            )}
          </>
        ) : (
          <p className="taxi-chart-empty">Графік з’явиться після першого запису зміни.</p>
        )}
      </div>
    </div>
  );
}
