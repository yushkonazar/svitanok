import { useChartWidth, axisMoney } from './useChartWidth.ts';
import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import type { FinanceAnalytics } from '../../api/finance-analytics-schema.ts';
import { budgetRows, orderedBudgets, budgetLimit, periodWindow } from '../../lib/budgetPlanning.ts';
import { budgetAnalysisAccumulator } from '../../../../core/finance/budget-analysis.mjs';
import { quantile } from '../../../../core/finance/adaptive-model.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
export type BudgetPoint = {
  key: string;
  label: string;
  actual: number;
  plan: number | null;
  partial?: boolean;
};
export function BudgetHistoryChart({
  points,
  label,
  onSelect,
}: {
  points: BudgetPoint[];
  label: string;
  onSelect?: (key: string) => void;
}) {
  const { ref, width: chartWidth } = useChartWidth();
  const max = Math.max(1, ...points.flatMap((p) => [p.actual, p.plan ?? 0]));
  const count = Math.max(1, points.length),
    width = (chartWidth - 90) / count;
  return (
    <div className="mt-3 finance-budget-chart" ref={ref}>
      <svg viewBox={`0 0 ${chartWidth} 225`} role="img" aria-label={label}>
        <title>{label} · факт і план у гривнях</title>
        {[0, 0.5, 1].map((n) => (
          <g key={n}>
            <line
              x1="65"
              x2={chartWidth - 20}
              y1={178 - n * 146}
              y2={178 - n * 146}
              stroke="var(--color-glassb)"
            />
            <text x="57" y={182 - n * 146} textAnchor="end" className="analytics-axis">
              {axisMoney(max * n)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = 68 + i * width,
            h = (p.actual / max) * 146,
            plan = p.plan != null ? 178 - (p.plan / max) * 146 : null;
          return (
            <g key={p.key}>
              <rect
                x={x + width * 0.16}
                y={178 - h}
                width={Math.max(1, width * 0.65)}
                height={Math.max(0.5, h)}
                rx="2"
                fill={
                  p.plan != null && p.actual > p.plan ? 'var(--color-neg)' : 'var(--color-info)'
                }
                opacity={p.partial ? 0.65 : 0.9}
              />
              {plan != null && (
                <line
                  x1={x + width * 0.08}
                  x2={x + width * 0.88}
                  y1={plan}
                  y2={plan}
                  stroke="var(--color-a2)"
                  strokeWidth="3"
                />
              )}
              {(i %
                Math.max(1, Math.ceil(count / Math.max(2, Math.floor((chartWidth - 90) / 48)))) ===
                0 ||
                i === count - 1) && (
                <text x={x + width * 0.5} y="202" textAnchor="middle" className="analytics-axis">
                  {p.label}
                </text>
              )}
              <rect
                x={x}
                y="20"
                width={width}
                height="160"
                fill="transparent"
                onClick={() => onSelect?.(p.key)}
              >
                <title>
                  {p.key}: факт {moneyLabel(p.actual)};{' '}
                  {p.plan != null ? `план ${moneyLabel(p.plan)}` : 'історичний план невідомий'}
                  {p.partial ? ' · неповний період' : ''}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <p className="renewal-chart-note">
        Стовпчики — факт, риски — план. Напівпрозорий стовпчик — неповний період. Усі точні суми
        доступні в таблиці.
      </p>
    </div>
  );
}
export function BudgetHistoryAnalytics({
  finance,
  data,
  nowMs,
  onBudget,
}: {
  finance: Finance;
  data: FinanceAnalytics;
  nowMs: number;
  onBudget: (budget: ReturnType<typeof budgetRows>[number]) => void;
}) {
  const [compareCurrent, setCompareCurrent] = useState(false);
  const fallback = budgetAnalysisAccumulator(finance, data.selection);
  if (!data.budgetAnalysis) finance.transactions.forEach((t) => fallback.consume(t));
  const analyses = data.budgetAnalysis ?? fallback.finish(),
    rows = orderedBudgets(budgetRows(finance, nowMs));
  return (
    <>
      <section className="renewal-card">
        <h2 className="text-lg font-bold">Як змінюються витрати в межах бюджетів</h2>
        <p className="renewal-chart-note mt-2">
          Період: {data.selection.from} — {data.selection.to}. Поточний план редагується на головній
          сторінці; тут — історія поведінки.
        </p>
        <label className="flex gap-3 mt-3">
          <input
            type="checkbox"
            checked={compareCurrent}
            onChange={(e) => setCompareCurrent(e.target.checked)}
          />
          Порівняти з нинішніми лімітами замість історичних
        </label>
        {compareCurrent && (
          <p className="finance-context-note mt-3">
            Це порівняння минулих витрат із сьогоднішніми межами, а не план, який діяв тоді.
          </p>
        )}
      </section>
      {rows
        .filter((b) => b.purpose === 'expense')
        .map((b) => {
          const analysis = analyses.find((a) => a.id === b.id);
          if (!analysis) return null;
          const groups = new Map<string, BudgetPoint>();
          analysis.points.forEach((d) => {
            const w = periodWindow(b.period, d.date),
              key = b.period === 'day' ? d.date : w.start;
            const old = groups.get(key) ?? {
              key,
              label: b.period === 'month' ? key.slice(0, 7) : key.slice(8) + '.' + key.slice(5, 7),
              actual: 0,
              plan: 0,
              partial: w.start < data.selection.from || w.end > data.selection.to,
            };
            old.actual += d.amountMinor;
            const plan = compareCurrent
              ? Math.round(
                  budgetLimit(b, finance.budgets, d.date) / periodWindow(b.period, d.date).days,
                )
              : d.planMinor;
            old.plan = old.plan != null && plan != null ? old.plan + plan : null;
            groups.set(key, old);
          });
          const points = [...groups.values()],
            known = points.filter((p) => p.plan != null),
            over = known.filter((p) => p.actual > p.plan!).length;
          return (
            <section className="renewal-card" key={b.id}>
              <h3 className="text-lg font-bold">{b.category}</h3>
              <div className="renewal-metrics">
                <div className="renewal-metric">
                  <span className="renewal-muted">Записано за період</span>
                  <strong>{moneyLabel(analysis.totalMinor)}</strong>
                </div>
                <div className="renewal-metric">
                  <span className="renewal-muted">
                    Типова сума за{' '}
                    {b.period === 'day' ? 'день' : b.period === 'week' ? 'тиждень' : 'місяць'}
                  </span>
                  <strong>{moneyLabel(Math.round(quantile(points.map((p) => p.actual))))}</strong>
                </div>
              </div>
              <BudgetHistoryChart
                points={points}
                label={`${b.category}: факт і план`}
                onSelect={() => onBudget(b)}
              />
              {known.length > 0 && (
                <p className="renewal-chart-note mt-2">
                  Перевищень: {over} з {known.length} періодів із відомим планом.
                </p>
              )}
              {!analysis.historyKnown && !compareCurrent && (
                <p className="finance-context-note mt-3">
                  Для частини дат історичний ліміт не збережено. Факт показано; старий план не
                  вигадується.
                </p>
              )}
              <details className="mt-3">
                <summary className="renewal-link">Точні суми</summary>
                <div className="finance-table-scroll">
                  <table className="finance-data-table">
                    <thead>
                      <tr>
                        <th>Період</th>
                        <th>Факт</th>
                        <th>{compareCurrent ? 'Нинішній ліміт' : 'Історичний план'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {points.map((p) => (
                        <tr key={p.key}>
                          <th>
                            {p.key}
                            {p.partial ? ' · частково' : ''}
                          </th>
                          <td>{moneyLabel(p.actual)}</td>
                          <td>{p.plan == null ? 'Невідомо' : moneyLabel(p.plan)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              <button className="renewal-secondary mt-3" onClick={() => onBudget(b)}>
                Операції бюджету ↗
              </button>
              <p className="renewal-chart-note mt-3">
                {analysis.definitionScope} Вкладені бюджети не додаються як нові витрати.
              </p>
            </section>
          );
        })}
      {!rows.some((b) => b.purpose === 'expense') && (
        <p className="renewal-muted">Створи бюджет на основній сторінці фінансів.</p>
      )}
      {rows
        .filter((b) => b.purpose === 'saving')
        .map((b) => (
          <section className="renewal-card" key={b.id}>
            <h3 className="font-bold">{b.category} · відкладання</h3>
            <p className="renewal-chart-note mt-2">
              Внески й повернення аналізуються в повній історії цілей; вони не є витратами.
            </p>
            <button className="renewal-link mt-3" onClick={() => onBudget(b)}>
              Переглянути внески ↗
            </button>
          </section>
        ))}
    </>
  );
}
