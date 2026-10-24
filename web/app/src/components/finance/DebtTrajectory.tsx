import { useChartWidth, axisMoney } from './useChartWidth.ts';
import { useEffect, useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { paymentSchedule } from '../../lib/paymentSchedule.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { useReducedMotion } from '../../lib/useReducedMotion.ts';
export function DebtTrajectory({ payment: p }: { payment: Finance['payments'][number] }) {
  const rows = paymentSchedule(p, 1200),
    [choice, setChoice] = useState(0),
    [playing, setPlaying] = useState(false);
  const { ref, width } = useChartWidth(rows.length > 0 && p.remainingMinor != null);
  const index = Math.min(choice, Math.max(0, rows.length - 1));
  const reduced = useReducedMotion(),
    allowed = !reduced && document.documentElement.dataset.financeMotion !== 'off';
  useEffect(() => {
    if (!playing || !allowed) return;
    const timer = window.setTimeout(() => {
      if (index >= rows.length - 1) setPlaying(false);
      else setChoice(index + 1);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [playing, rows.length, index, allowed]);
  if (!rows.length || p.remainingMinor == null) return null;
  if (rows.some((r) => r.remaining == null))
    return (
      <p className="renewal-inset mt-3">
        Для графіка залишку бракує умов погашення. Суми й дати збережених платежів доступні в
        календарі; невідомий залишок не прирівнюється до нуля.
      </p>
    );
  const first = Date.parse(p.nextDate),
    last = Date.parse(rows.at(-1)!.date),
    span = Math.max(86400000, last - first);
  const x = (date: string) => 90 + ((Date.parse(date) - first) / span) * (width - 115),
    y = (v: number) => 180 - (145 * v) / Math.max(1, p.remainingMinor!);
  let path = `M70 ${y(p.remainingMinor)}`;
  rows.forEach((r) => {
    path += ` H${x(r.date)} V${y(r.remaining ?? 0)}`;
  });
  const row = rows[index]!;
  return (
    <div className="finance-debt-chart" ref={ref}>
      <svg
        viewBox={`0 0 ${width} 230`}
        role="img"
        aria-label="Плановий залишок тіла боргу після кожного платежу"
      >
        <title>Зменшення тіла боргу за збереженим графіком</title>
        <text x="63" y="40" textAnchor="end" className="analytics-axis">
          {axisMoney(p.remainingMinor)}
        </text>
        <text x="63" y="183" textAnchor="end" className="analytics-axis">
          0
        </text>
        <line x1="70" x2={width - 20} y1="180" y2="180" stroke="var(--color-glassb)" />
        <path
          d={path}
          fill="none"
          stroke="var(--color-info)"
          strokeWidth="3"
          strokeDasharray="7 3"
        />
        <circle cx={x(row.date)} cy={y(row.remaining ?? 0)} r="6" fill="var(--color-a2)" />
        <text x="85" y="215" className="analytics-axis">
          {rows[0]!.date}
        </text>
        <text x={width - 25} y="215" textAnchor="end" className="analytics-axis">
          {rows.at(-1)!.date}
        </text>
      </svg>
      <div className="finance-tabs-detail">
        <button
          className="renewal-secondary"
          disabled={index === 0}
          onClick={() => {
            setPlaying(false);
            setChoice(index - 1);
          }}
        >
          ← Попередня оплата
        </button>
        <button
          className="renewal-secondary"
          disabled={index === rows.length - 1}
          onClick={() => {
            setPlaying(false);
            setChoice(index + 1);
          }}
        >
          Наступна →
        </button>
        <button className="renewal-link" disabled={!allowed} onClick={() => setPlaying((v) => !v)}>
          {playing ? 'Пауза' : 'Програти графік'}
        </button>
      </div>
      <label className="renewal-field mt-3">
        Платіж графіка
        <select
          value={index}
          onChange={(e) => {
            setPlaying(false);
            setChoice(Number(e.target.value));
          }}
        >
          {rows.map((r, i) => (
            <option key={r.date} value={i}>
              {r.date} · {moneyLabel(r.payment)}
            </option>
          ))}
        </select>
      </label>
      <div className="finance-projection-day mt-3">
        <div>
          <span>Обрана дата</span>
          <b>{row.date}</b>
        </div>
        <div>
          <span>Платіж</span>
          <b>{moneyLabel(row.payment)}</b>
        </div>
        <div>
          <span>Залишок тіла</span>
          <b>{row.remaining == null ? 'Невідомо' : moneyLabel(row.remaining)}</b>
        </div>
        {row.overpayment != null && (
          <div>
            <span>Відсотки / переплата в платежі</span>
            <b>{moneyLabel(row.overpayment)}</b>
          </div>
        )}
      </div>
      <p className="renewal-chart-note mt-3">
        Пунктир — майбутній план, а не здійснені оплати. Точний вибір доступний кнопками й списком,
        без перетягування. Дострокове погашення змінить графік після підтвердження.
      </p>
    </div>
  );
}
