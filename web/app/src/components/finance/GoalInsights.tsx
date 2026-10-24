import { useChartWidth } from './useChartWidth.ts';
import type { Finance } from '../../api/finance-schema.ts';
import { kyivParts, sumMoney, shiftDate } from '../../../../core/finance/planning.mjs';
import { savingsForecast } from '../../../../core/finance/savings-forecast.mjs';
import { useTick } from '../../lib/useTick.ts';
import { moneyLabel } from '../../lib/financeView.ts';
export function GoalInsights({
  finance: f,
  onHistory,
}: {
  finance: Finance;
  onHistory: (goalId: string, date?: string) => void;
}) {
  const { ref, width } = useChartWidth();
  const chartWidth = Math.max(260, width - 40);
  const now = useTick(60000),
    today = kyivParts(now).date,
    plans = savingsForecast(f, 93, now);
  return (
    <div ref={ref} className="flex flex-col gap-4">
      {f.goals.map((g) => {
        const moves = f.goalMoves
            .filter((m) => m.goalId === g.id)
            .sort((a, b) => a.at.localeCompare(b.at)),
          total = sumMoney(moves.map((m) => m.amountMinor)),
          plan = plans.find((p) => p.id === g.id);
        const grouped = new Map<string, number>();
        moves.forEach((m) => {
          const date = kyivParts(Date.parse(m.at)).date;
          grouped.set(date, (grouped.get(date) ?? 0) + m.amountMinor);
        });
        let accumulated = 0;
        const points = [...grouped].map(([date, v]) => ({ date, value: (accumulated += v) }));
        const first = points[0]?.date ?? today,
          last = plan?.events.at(-1)?.date ?? today;
        const minDate = Date.parse(shiftDate(first, -1)),
          maxDate = Math.max(Date.parse(today), Date.parse(last)),
          span = Math.max(86400000, maxDate - minDate);
        const x = (d: string) => 65 + ((Date.parse(d) - minDate) / span) * (chartWidth - 90),
          y = (v: number) =>
            184 - (Math.min(g.targetMinor * 1.25, v) / Math.max(1, g.targetMinor)) * 145;
        let path = `M65 ${y(0)}`;
        points.forEach((p) => {
          path += ` H${x(p.date)} V${y(p.value)}`;
        });
        let projected = total,
          projectPath = `M${x(points.at(-1)?.date ?? today)} ${y(total)}`;
        const projectedPoints =
          plan?.events.map((e) => ({
            date: e.date,
            value: (projected = Math.min(g.targetMinor, projected + e.amount)),
          })) ?? [];
        projectedPoints.forEach((p) => {
          projectPath += ` H${x(p.date)} V${y(p.value)}`;
        });
        const finish = projectedPoints.find((p) => p.value >= g.targetMinor)?.date;
        const byDeadline = g.deadline
          ? (projectedPoints.filter((p) => p.date <= g.deadline!).at(-1)?.value ?? total)
          : null;
        return (
          <section className="renewal-card" key={g.id}>
            <h2 className="text-lg font-bold">{g.name}</h2>
            <div className="renewal-big mt-2">{moneyLabel(total)}</div>
            <p className="renewal-muted">
              із {moneyLabel(g.targetMinor)} · залишилось{' '}
              {moneyLabel(Math.max(0, g.targetMinor - total))}
            </p>
            <div className="finance-goal-chart mt-3">
              <svg
                viewBox={`0 0 ${chartWidth} 225`}
                role="img"
                aria-label={`Повна історія накопичення: ${g.name}`}
              >
                <title>Усі фактичні внески та очікуваний подальший темп</title>
                <line
                  x1="65"
                  x2={chartWidth - 20}
                  y1={y(g.targetMinor)}
                  y2={y(g.targetMinor)}
                  stroke="var(--color-a2)"
                  strokeDasharray="5 4"
                />
                <text x="68" y={y(g.targetMinor) - 12} className="analytics-axis">
                  Ціль {moneyLabel(g.targetMinor)}
                </text>
                <path d={path} fill="none" stroke="var(--color-pos)" strokeWidth="3" />
                <path
                  d={projectPath}
                  fill="none"
                  stroke="var(--color-info)"
                  strokeWidth="2"
                  strokeDasharray="6 4"
                />
                {points.map((p) => (
                  <g key={p.date}>
                    <circle cx={x(p.date)} cy={y(p.value)} r="4" fill="var(--color-pos)" />
                    <circle
                      cx={x(p.date)}
                      cy={y(p.value)}
                      r="14"
                      fill="transparent"
                      onClick={() => onHistory(g.id, p.date)}
                    >
                      <title>
                        {p.date}: {moneyLabel(p.value)}
                      </title>
                    </circle>
                  </g>
                ))}
                <text x="65" y="214" className="analytics-axis">
                  {first}
                </text>
                <text x={chartWidth - 25} y="214" textAnchor="end" className="analytics-axis">
                  {last}
                </text>
              </svg>
            </div>
            <p className="renewal-chart-note">
              Суцільна лінія — всі записані внески й повернення. Пунктир — очікування, не здійснені
              перекази. Облік внесків не замінює звірку балансу банківської банки.
            </p>
            {plan && (
              <div className="renewal-inset mt-3">
                <p>
                  Ваш план:{' '}
                  <b>
                    {moneyLabel(plan.target)} /{' '}
                    {plan.period === 'week'
                      ? 'тиждень'
                      : plan.period === 'month'
                        ? 'місяць'
                        : 'день'}
                  </b>
                </p>
                <p className="renewal-muted mt-2">
                  {plan.events[0]
                    ? `Орієнтовний наступний внесок ${moneyLabel(plan.events[0].amount)} · ${plan.events[0].date}. `
                    : ''}
                  {plan.description}
                </p>
                {plan.gap > 0 && (
                  <p className="renewal-chart-note mt-2">
                    Різниця до планового темпу: {moneyLabel(plan.gap)}. Це не прострочення.
                  </p>
                )}
                <p className="renewal-chart-note mt-2">
                  {finish
                    ? `Очікуване досягнення за цим темпом: ${finish}.`
                    : 'За поточним темпом дата завершення поза 93-денним горизонтом або ще невідома.'}
                </p>
              </div>
            )}
            {g.deadline && (
              <p className="renewal-chart-note mt-3">
                Орієнтир цілі: {g.deadline}.
                {byDeadline != null && g.deadline <= shiftDate(today, 92)
                  ? ` До орієнтира за цим сценарієм ${moneyLabel(byDeadline)}; до цілі залишиться ${moneyLabel(Math.max(0, g.targetMinor - byDeadline))}.`
                  : ''}{' '}
                Дати окремих внесків гнучкі.
              </p>
            )}
            <button className="renewal-secondary mt-3" onClick={() => onHistory(g.id)}>
              Уся історія внесків ↗
            </button>
          </section>
        );
      })}
      {!f.goals.length && (
        <p className="renewal-muted">Створи ціль на головній сторінці фінансів.</p>
      )}
    </div>
  );
}
