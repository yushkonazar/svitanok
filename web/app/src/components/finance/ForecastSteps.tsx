import { useState } from 'react';
import './finance-analytics.css';
import type { Finance } from '../../api/finance-schema.ts';
import type { financeForecast } from '../../lib/financeForecast.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { financeDate } from './analytics-format.ts';
import { sumMoney } from '../../../../core/finance/planning.mjs';
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
    'Ще заплановано на повсякденні витрати',
    'Майбутні відкладання',
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
    cumulative = sumMoney([cumulative, amount]);
    return { label: labels[i]!, amount, total: cumulative };
  });
  const max = Math.max(1, ...steps.map((s) => Math.abs(s.total)));
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
                  <span className="renewal-progress">
                    <span
                      style={{
                        width: `${(Math.abs(step.total) / max) * 100}%`,
                        background: step.total < 0 ? 'var(--color-neg)' : 'var(--color-a2)',
                      }}
                    />
                  </span>
                </>
              )}
            </span>
            <strong>
              {step.amount > 0 && i === 1 ? '+ ' : ''}
              {moneyLabel(step.amount)} ↗
            </strong>
          </button>
        ))}
      </div>
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
                  Минулі витрати вже змінили баланс. Тут лише ще не використана частина ввімкнених
                  планів.
                </p>
              </>
            )}
            {detail === 4 && (
              <>
                {result.goalPlans.map((g) => (
                  <div className="analytics-row" key={g.id}>
                    <span>Ціль: {g.name}</span>
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
