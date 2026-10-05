import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFinanceReport, isSessionExpired } from '../../api/client.ts';
import { FINANCE_QUERY } from '../../api/finance-hooks.ts';
import { kyivParts, shiftDate } from '../../../../core/finance/planning.mjs';
import { validateReportRange } from '../../../../core/finance/reporting.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { financeCategoryLabel } from '../../../../core/finance/categories.mjs';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { ObservationChart } from '../charts/ObservationChart.tsx';
export function previousFinancePeriod(kind: 'week' | 'month', today = kyivParts(Date.now()).date) {
  if (kind === 'week') {
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const start = shiftDate(today, -dow);
    return { from: shiftDate(start, -7), to: shiftDate(start, -1) };
  }
  const last = shiftDate(`${today.slice(0, 7)}-01`, -1);
  return { from: `${last.slice(0, 7)}-01`, to: last };
}
export function FinanceReport({ onBack }: { onBack: () => void }) {
  const [today] = useState(() => kyivParts(Date.now()).date);
  const [draft, setDraft] = useState(() => previousFinancePeriod('week'));
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [validation, setValidation] = useState('');
  const query = useQuery({
    queryKey: [...FINANCE_QUERY, 'report', range?.from, range?.to],
    queryFn: () => fetchFinanceReport(range!.from, range!.to),
    enabled: range !== null,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const report = query.data;
  if (isSessionExpired(query.error)) return <SessionExpired />;
  return (
    <div className="renewal-finance flex flex-col gap-5">
      <button className="renewal-secondary self-start" onClick={onBack}>
        ← До фінансів
      </button>
      <div>
        <p className="renewal-eyebrow mb-2">ІСТОРІЯ ОБЛІКУ</p>
        <h1 className="text-2xl font-bold">Фінансові звіти</h1>
        <p className="renewal-muted mt-2">
          Обери період. Звіт завантажується лише за запитом і не змінює основний екран 7 / 30 днів.
        </p>
      </div>
      <form
        className="renewal-card flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            validateReportRange(draft.from, draft.to);
            setValidation('');
            if (range?.from === draft.from && range.to === draft.to) void query.refetch();
            else setRange({ ...draft });
          } catch (e) {
            setValidation(e instanceof Error ? e.message : 'Перевір дати');
          }
        }}
      >
        <div className="flex flex-wrap gap-2">
          {(['week', 'month'] as const).map((p) => (
            <button
              type="button"
              key={p}
              className="renewal-secondary"
              onClick={() => setDraft(previousFinancePeriod(p))}
            >
              {p === 'week' ? 'Минулий тиждень' : 'Минулий місяць'}
            </button>
          ))}
        </div>
        <div className="renewal-form-grid">
          {(['from', 'to'] as const).map((key) => (
            <label className="renewal-field" key={key}>
              {key === 'from' ? 'Від' : 'До включно'}
              <input
                type="date"
                value={draft[key]}
                max={today}
                required
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <p className="renewal-chart-note">
          До 366 днів в одному звіті. Дати й календарні тижні — за Києвом.
        </p>
        {validation && (
          <p role="alert" className="text-neg">
            {validation}
          </p>
        )}
        <button className="renewal-button" disabled={query.isFetching}>
          {query.isFetching ? 'Завантажую…' : 'Показати звіт'}
        </button>
      </form>
      {query.error && (
        <p role="alert" className="renewal-inset text-neg">
          {query.error instanceof Error ? query.error.message : 'Звіт недоступний'}
        </p>
      )}
      {report && (
        <>
          <section className="renewal-card">
            <p className="renewal-eyebrow mb-3">
              {report.from} — {report.to}
            </p>
            <h2 className="text-lg font-bold">Результат періоду</h2>
            <div className="renewal-big mt-3">{moneyLabel(report.resultMinor)}</div>
            <div className="renewal-metrics">
              {(
                [
                  ['Зароблено в таксі', report.taxiEarnedMinor],
                  ['Інші надходження', report.otherIncomeMinor],
                  ['Особисті витрати', report.expenseMinor],
                  ['Різниця розрахунків із парком', report.settlementDifferenceMinor],
                  ['Чисті внески на цілі', report.goalContributionsMinor],
                ] as [string, number][]
              ).map(([label, value]) => (
                <div className="renewal-metric" key={label}>
                  <span className="renewal-muted">{label}</span>
                  <strong>{moneyLabel(value)}</strong>
                </div>
              ))}
            </div>
            <p className="renewal-chart-note mt-3">
              Результат = заробіток таксі + інші надходження − витрати + різниця фактичних
              розрахунків із парком. Внески на цілі та власні перекази не є витратами. Це результат
              обліку за період, а не залишок на рахунках.
            </p>
          </section>
          {(report.unclassifiedCount > 0 ||
            report.unknownCurrencyCount > 0 ||
            report.taxiWeeks.some((w) => !w.complete)) && (
            <p className="renewal-inset renewal-muted">
              Звіт може бути неповним: {report.unclassifiedCount} операцій без визначеного типу,{' '}
              {report.unknownCurrencyCount} без гривневої суми.
              {report.taxiWeeks.some((w) => !w.complete) ? ' Є неповні зміни таксі.' : ''}
            </p>
          )}
          <section className="renewal-card">
            <h2 className="text-lg font-bold mb-3">Витрати за днями</h2>
            <ObservationChart
              key={`${report.from}-${report.to}`}
              label="Витрати у звіті"
              unit="₴"
              points={report.daily.map((d) => ({ date: d.date, value: d.expenseMinor / 100 }))}
            />
          </section>
          <section className="renewal-card">
            <h2 className="text-lg font-bold mb-4">Витрати за категоріями</h2>
            {report.categories.length ? (
              report.categories.map((c) => (
                <div key={c.category} className="mb-4">
                  <div className="renewal-section-head">
                    <b className="text-sm">{financeCategoryLabel(c.category)}</b>
                    <span className="font-mono text-sm">{moneyLabel(c.amountMinor)}</span>
                  </div>
                  <div className="renewal-progress">
                    <span
                      style={{
                        width: `${report.expenseMinor > 0 ? Math.max(0, Math.min(100, (c.amountMinor / report.expenseMinor) * 100)) : 0}%`,
                      }}
                    />
                  </div>
                  <p className="renewal-chart-note mt-2">{c.count} операцій</p>
                </div>
              ))
            ) : (
              <p className="renewal-muted">Записаних витрат за період немає.</p>
            )}
          </section>
          <section className="renewal-card">
            <h2 className="text-lg font-bold">Таксі · повні робочі тижні</h2>
            <p className="renewal-chart-note mt-2">
              Тижні, які перетинаються з вибраними датами. Нижче показано весь робочий тиждень від
              понеділка 13:00; сума «Зароблено в таксі» вище враховує тільки записи в межах дат
              звіту, зі ставкою всього тижня.
            </p>
            {report.taxiWeeks.map((w) => (
              <details key={w.key} className="renewal-inset mt-4">
                <summary className="renewal-link cursor-pointer">
                  Від {w.key} · {moneyLabel(w.earnedMinor)}
                </summary>
                <div className="renewal-metrics mt-3">
                  {(
                    [
                      ['Чиста каса', w.netCashMinor],
                      ['Брудна каса', w.grossMinor],
                      ['Комісія', w.commissionMinor],
                      ['Пальне', w.fuelMinor],
                      ['Чайові до поділу', w.tipsMinor],
                      ['Отримана готівка', w.heldMinor],
                      ['Розрахунок за формулою', w.expectedMinor],
                    ] as [string, number][]
                  ).map(([label, value]) => (
                    <div className="renewal-metric" key={label}>
                      <span className="renewal-muted">{label}</span>
                      <strong>{moneyLabel(value)}</strong>
                    </div>
                  ))}
                </div>
                <p className="renewal-muted mt-3">
                  {w.actualMinor == null
                    ? 'Фактичний розрахунок ще не записаний.'
                    : `Фактично: ${moneyLabel(w.actualMinor)} · різниця: ${moneyLabel(w.differenceMinor ?? 0)}`}
                </p>
                {!w.complete && <p className="text-neg text-sm mt-2">Неповні дані зміни</p>}
              </details>
            ))}
            {!report.taxiWeeks.length && (
              <p className="renewal-muted mt-3">Змін таксі за цей період немає.</p>
            )}
          </section>
          <p className="renewal-chart-note">
            Ручний облік, зміни та розрахунки таксі зберігаються в базі Cloudflare. Банківські
            операції зберігаються до 720 днів; давніший звіт може не містити повної банківської
            історії. Початкові залишки й перекази не зараховуються як дохід.
          </p>
        </>
      )}
    </div>
  );
}
