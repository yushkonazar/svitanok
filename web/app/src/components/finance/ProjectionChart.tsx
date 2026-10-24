import { useState } from 'react';
import { useChartWidth, axisMoney } from './useChartWidth.ts';
import type { Projection } from '../../../../core/finance/projection.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
export function ProjectionChart({ projection: p }: { projection: Projection }) {
  const [selected, setSelected] = useState('');
  const { ref, width } = useChartWidth(!p.incomplete && p.daily.length > 0);
  if (p.incomplete || !p.daily.length) return null;
  const row = p.daily.find((d) => d.date === selected) ?? p.daily[0]!;
  const values = p.daily.flatMap((d) => [d.lower, d.upper, d.balance, 0]),
    min = Math.min(...values),
    max = Math.max(...values),
    span = Math.max(100, max - min);
  const x = (i: number) => 68 + (i * (width - 95)) / Math.max(1, p.daily.length - 1),
    y = (n: number) => 204 - ((n - min) * 164) / span;
  const path = (field: 'balance' | 'lower' | 'upper') =>
    p.daily.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d[field])}`).join(' ');
  const area =
    path('upper') +
    ' ' +
    [...p.daily]
      .reverse()
      .map((d, i) => `L${x(p.daily.length - 1 - i)},${y(d.lower)}`)
      .join(' ') +
    ' Z';
  return (
    <div className="finance-projection-chart mt-4" ref={ref}>
      <svg viewBox={`0 0 ${width} 245`} role="img" aria-label="Сценарії вільних коштів за днями">
        <title>Прогноз залишку й сценарний діапазон, гривні</title>
        {[min, min + span / 2, max].map((v, i) => (
          <g key={i}>
            <line x1="68" x2={width - 25} y1={y(v)} y2={y(v)} stroke="var(--color-glassb)" />
            <text x="62" y={y(v) + 4} textAnchor="end" className="analytics-axis">
              {axisMoney(v)}
            </text>
          </g>
        ))}
        <line
          x1="68"
          x2={width - 25}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--color-neg)"
          strokeDasharray="4 4"
          opacity=".6"
        />
        <path d={area} fill="var(--color-info)" opacity=".13" />
        <path d={path('balance')} fill="none" stroke="var(--color-info)" strokeWidth="3" />
        {p.daily.map((d, i) => (
          <g key={d.date}>
            <circle
              cx={x(i)}
              cy={y(d.balance)}
              r={row.date === d.date ? 6 : 3}
              fill={d.balance < 0 ? 'var(--color-neg)' : 'var(--color-info)'}
            />
            <circle
              cx={x(i)}
              cy={y(d.balance)}
              r="15"
              fill="transparent"
              onClick={() => setSelected(d.date)}
            >
              <title>
                {d.date}: {moneyLabel(d.balance)}
              </title>
            </circle>
            {(i === 0 || i === p.daily.length - 1) && (
              <text x={x(i)} y="233" textAnchor="middle" className="analytics-axis">
                {d.date.slice(8)}.{d.date.slice(5, 7)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <p className="renewal-chart-note">
        Суцільна лінія — основний сценарій, зона — варіанти іншого темпу роботи, витрат і часу
        внесків. Це не гарантований імовірнісний інтервал.
      </p>
      <label className="renewal-field mt-3">
        Розрахунок дня
        <select value={row.date} onChange={(e) => setSelected(e.target.value)}>
          {p.daily.map((d) => (
            <option key={d.date} value={d.date}>
              {d.date} · {moneyLabel(d.balance)}
            </option>
          ))}
        </select>
      </label>
      <div className="finance-projection-day mt-3">
        <div>
          <span>Очікувані надходження</span>
          <b>{moneyLabel(row.income)}</b>
        </div>
        <div>
          <span>Відомі оплати</span>
          <b>{moneyLabel(row.payment)}</b>
        </div>
        <div>
          <span>Повсякденні витрати</span>
          <b>{moneyLabel(row.expense)}</b>
        </div>
        <div>
          <span>Гнучкі внески</span>
          <b>{moneyLabel(row.saving)}</b>
        </div>
        <div>
          <span>Вільно наприкінці дня</span>
          <b>{moneyLabel(row.balance)}</b>
        </div>
      </div>
      <details className="mt-3">
        <summary className="renewal-link">Усі дні таблицею</summary>
        <div className="finance-table-scroll">
          <table className="finance-data-table">
            <caption className="sr-only">Денна траєкторія прогнозу в гривнях</caption>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Надходження</th>
                <th>Оплати</th>
                <th>Побутові</th>
                <th>Внески</th>
                <th>Вільно</th>
              </tr>
            </thead>
            <tbody>
              {p.daily.map((d) => (
                <tr key={d.date}>
                  <th>{d.date}</th>
                  <td>{moneyLabel(d.income)}</td>
                  <td>{moneyLabel(d.payment)}</td>
                  <td>{moneyLabel(d.expense)}</td>
                  <td>{moneyLabel(d.saving)}</td>
                  <td>{moneyLabel(d.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
