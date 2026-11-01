import { useState } from 'react';
import './finance-analytics.css';
import type { Finance } from '../../api/finance-schema.ts';
import type { financeForecast } from '../../lib/financeForecast.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { Sheet } from './FinanceSheet.tsx';
import { financeDate } from './analytics-format.ts';
import { sumMoney } from '../../../../core/finance/planning.mjs';
import { budgetPeriod } from '../../../../core/finance/budget-history.mjs';
export function ForecastSteps({
  result,
  finance,
  onPayment,
}: {
  result: ReturnType<typeof financeForecast>;
  finance: Finance;
  onPayment?: (id: string) => void;
}) {
  const [detail, setDetail] = useState<number | null>(null);
  const past = result.payments.filter((p) => p.date < result.today),
    future = result.payments.filter((p) => p.date >= result.today);
  const labels = [
    'Вільні кошти зараз',
    'Очікувані надходження',
    'Майбутні й непідтверджені оплати',
    'Очікувані повсякденні витрати',
    'Очікувані відкладання',
  ];
  const amounts = [
    result.available,
    result.expectedIncome,
    -result.obligations,
    -result.plannedExpense,
    -result.saving,
  ];
  let cumulative = 0;
  const steps = amounts.map((amount, i) => {
    const from = cumulative;
    cumulative = sumMoney([cumulative, amount]);
    return { label: labels[i]!, amount, from, total: cumulative };
  });
  const min = Math.min(0, ...steps.map((s) => s.total));
  const max = Math.max(0, ...steps.map((s) => s.total));
  const span = Math.max(1, max - min);
  return (
    <>
      <div className="finance-forecast-steps mt-4">
        {steps.map((step, i) => (
          <button className="analytics-operation" key={step.label} onClick={() => setDetail(i)}>
            <span>
              <b>
                {i + 1}. {step.label}
              </b>
              {!result.incomplete && (
                <>
                  <small>Після кроку: {moneyLabel(step.total)}</small>
                </>
              )}
            </span>
            <strong>
              {step.amount > 0 && i === 1 ? '+ ' : ''}
              {moneyLabel(step.amount)} ↗
            </strong>
            {!result.incomplete && (
              <span className="finance-waterfall-track" aria-hidden="true">
                <i style={{ left: `${(-min / span) * 100}%` }} />
                <span
                  style={{
                    left: `${((Math.min(step.from, step.total) - min) / span) * 100}%`,
                    width: `${(Math.abs(step.amount) / span) * 100}%`,
                    background: step.amount < 0 ? 'var(--color-neg)' : 'var(--color-info)',
                  }}
                />
              </span>
            )}
          </button>
        ))}
      </div>
      {!result.incomplete && (
        <p className="renewal-chart-note">
          Смужки показують рух від залишку перед кроком до залишку після нього на спільній шкалі.
          Пунктир — нуль.
        </p>
      )}
      {detail !== null && (
        <Sheet label="Деталі прогнозу" onClose={() => setDetail(null)}>
          <div className="renewal-finance">
            <div className="renewal-section-head">
              <h2 className="text-xl font-bold">{labels[detail]}</h2>
              <button
                className="renewal-secondary"
                onClick={() => setDetail(null)}
                aria-label="Закрити деталі прогнозу"
              >
                ×
              </button>
            </div>
            <p className="renewal-chart-note mt-3">
              Сценарій за введеними даними. Цей перегляд не виконує платежів.
            </p>
            {detail === 0 && (
              <>
                {finance.accounts.map((a) => (
                  <div className="analytics-row" key={a.id}>
                    <span>{a.name}</span>
                    <b>
                      {a.balanceMinor == null ? 'Невідомо' : moneyLabel(a.balanceMinor, a.currency)}
                    </b>
                  </div>
                ))}
                <p className="renewal-inset mt-3">
                  Гривневі власні кошти мінус резерв парку й внутрішні резерви цілей. Валюти та
                  кредитні ліміти окремо; невідомі залишки роблять прогноз неповним.
                </p>
              </>
            )}
            {detail === 1 && (
              <>
                {result.taxi.count > 0 && (
                  <div className="renewal-inset mt-3">
                    <b>
                      Таксі · очікувана зміна вільних коштів:{' '}
                      {moneyLabel(result.taxi.estimateMinor)}
                    </b>
                    <p className="renewal-chart-note mt-2">
                      {result.taxi.reason} Записаних робочих днів: {result.taxi.count}.
                    </p>
                  </div>
                )}
                {result.incomes.map((i, n) => (
                  <div className="analytics-row" key={n}>
                    <span>
                      {i.name}
                      <small>{financeDate(i.date)}</small>
                    </span>
                    <b>{moneyLabel(i.amount)}</b>
                  </div>
                ))}
                {!result.incomes.length && (
                  <p className="renewal-muted mt-3">Планових надходжень у цьому проміжку немає.</p>
                )}
              </>
            )}
            {detail === 2 && (
              <>
                {[
                  ['Минулі дати без підтвердження', past],
                  ['Майбутні оплати', future],
                ].map(([title, items]) => (
                  <div key={String(title)} className="mt-4">
                    <h3 className="font-bold">{String(title)}</h3>
                    {(items as typeof past).map((p, i) => (
                      <button
                        className="analytics-operation"
                        key={i}
                        disabled={!onPayment}
                        onClick={() => {
                          setDetail(null);
                          onPayment?.(p.id);
                        }}
                      >
                        <span>
                          {p.name}
                          <small>{financeDate(p.date)}</small>
                        </span>
                        <strong>{moneyLabel(p.payment)}</strong>
                      </button>
                    ))}
                    <p className="renewal-chart-note">
                      Разом: {moneyLabel(sumMoney((items as typeof past).map((p) => p.payment)))}
                    </p>
                  </div>
                ))}
                <p className="renewal-inset mt-3">
                  Минула дата в обліку не доводить прострочення в банку. Звір оплату перед
                  підтвердженням.
                </p>
              </>
            )}
            {detail === 3 && (
              <>
                {result.plans
                  .filter((p) => p.purpose === 'expense')
                  .map((p) => (
                    <div className="analytics-row" key={p.id}>
                      <span>
                        {p.name}
                        <small>Платежі на {moneyLabel(p.covered)} уже враховано окремо</small>
                      </span>
                      <b>{moneyLabel(p.amount)}</b>
                    </div>
                  ))}
                <p className="renewal-chart-note mt-3">
                  Минулі витрати вже змінили баланс. Тут оцінка майбутніх витрат за історією або
                  залишком вибраних планів. Пов’язані оплати за графіками виключені з навчання, щоб
                  не рахувати їх удруге.
                </p>
              </>
            )}
            {detail === 4 && (
              <>
                {result.goalPlans.map((g) => (
                  <div className="analytics-row" key={g.id}>
                    <span>
                      Ціль: {g.name}
                      <small>
                        {g.description} План {moneyLabel(g.target)} /{' '}
                        {g.period === 'week' ? 'тиждень' : g.period === 'month' ? 'місяць' : 'день'}
                        ; очікуваний темп {g.pace}%.
                      </small>
                      <small>
                        Різниця до плану завершених періодів: {moneyLabel(g.gap)}.{' '}
                        {g.adaptive
                          ? 'Очікування адаптоване до фактичного темпу; це не сума боргу.'
                          : 'Модель враховує невнесену частину; окремо додавати її не потрібно.'}
                      </small>
                      <small>
                        У поточному періоді:{' '}
                        {moneyLabel(
                          sumMoney(
                            g.events
                              .filter((e) => e.date <= budgetPeriod(g.period, result.today).end)
                              .map((e) => e.amount),
                          ),
                        )}
                        ; у наступних:{' '}
                        {moneyLabel(
                          sumMoney(
                            g.events
                              .filter((e) => e.date > budgetPeriod(g.period, result.today).end)
                              .map((e) => e.amount),
                          ),
                        )}
                        .
                      </small>
                    </span>
                    <b>{moneyLabel(g.amount)}</b>
                  </div>
                ))}
                {result.plans
                  .filter((p) => p.purpose === 'saving')
                  .map((p) => (
                    <div className="analytics-row" key={p.id}>
                      <span>План: {p.name}</span>
                      <b>{moneyLabel(p.amount)}</b>
                    </div>
                  ))}
                <p className="renewal-inset mt-3">
                  Пов’язані плани й цілі перекриваються: їх не потрібно складати вручну. Узгоджена
                  сума відкладань у прогнозі: {moneyLabel(result.saving)}. Уже внесені резерви та
                  перекази вдруге не віднімаються.
                </p>
              </>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
