import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { financeView, moneyLabel } from '../../lib/financeView.ts';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { kyivParts, sumMoney } from '../../../../core/finance/planning.mjs';
export function SpendingRhythm({ finance: f, nowMs }: { finance: Finance; nowMs: number }) {
  const [days, setDays] = useState(7),
    [selected, setSelected] = useState<string | null>(null),
    [category, setCategory] = useState('all');
  const view = financeView(f, days, nowMs);
  const expense = view.txs.filter((t) => t.kind === 'expense' && t.amountUah != null);
  const categories = [...new Set(expense.map((t) => t.category))].sort();
  const txs = expense.filter((t) => category === 'all' || t.category === category);
  const total = -sumMoney(txs.map((t) => t.amountUah!));
  const chart = view.chart.map((p) => ({
    date: p.date,
    value:
      -sumMoney(
        txs.filter((t) => kyivParts(Date.parse(t.at)).date === p.date).map((t) => t.amountUah!),
      ) / 100,
  }));
  const date = selected ?? chart.at(-1)?.date;
  const entries = txs.filter((t) => kyivParts(Date.parse(t.at)).date === date);
  return (
    <details className="renewal-card renewal-disclosure">
      <summary className="renewal-section-head cursor-pointer">
        <h2 className="text-lg font-bold">Ритм особистих витрат</h2>
        <span className="renewal-pill">{moneyLabel(total)}</span>
      </summary>
      <div className="renewal-section-head">
        <span className="renewal-muted">
          Середнє за день
          <br />
          <b className="text-tx">{moneyLabel(Math.round(total / days))}</b>
        </span>
        <div className="renewal-segments">
          {[7, 30].map((n) => (
            <button
              key={n}
              aria-pressed={days === n}
              onClick={() => {
                setDays(n);
                setSelected(null);
              }}
            >
              {n}д
            </button>
          ))}
        </div>
      </div>
      <label className="renewal-field mb-4">
        Категорія
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">Усі особисті витрати</option>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <ObservationChart
        key={`${days}-${category}`}
        label="Особисті витрати за день"
        points={chart}
        unit="₴"
        onSelect={setSelected}
      />
      <div className="renewal-inset mt-3">
        <h3 className="font-semibold">
          {date
            ? new Date(date + 'T12:00:00Z').toLocaleDateString('uk-UA', {
                day: 'numeric',
                month: 'long',
              })
            : 'Обери день'}
        </h3>
        {entries.length ? (
          entries.map((t) => (
            <div className="finance-forecast-formula" key={t.id}>
              <div>
                <span>{t.description}</span>
                <b>{moneyLabel(-t.amountUah!)}</b>
              </div>
            </div>
          ))
        ) : (
          <p className="renewal-muted mt-2">За цей день у вибраній категорії витрат немає.</p>
        )}
      </div>
      <p className="renewal-chart-note mt-3">
        Перекази, корекції, внески на цілі та готівка парку не є особистими витратами. Обери день на
        графіку, щоб побачити операції.
      </p>
    </details>
  );
}
