import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { financeDisplay } from '../../../../core/finance/display.mjs';
import { paymentSchedule } from '../../../../core/finance/payments.mjs';
import { shiftDate, sumMoney } from '../../../../core/finance/planning.mjs';
import { moneyLabel, type financeView } from '../../lib/financeView.ts';
import {
  isDuePayment,
  isOpenPayment,
  isPaymentDate,
  nextTodayPayment,
  possibleBankPayment,
} from '../../lib/todayPayment.ts';
import { financeDate, counted } from './analytics-format.ts';
import { Sheet } from './FinanceSheet.tsx';
import type { FinanceFormRequest } from './FinanceForm.tsx';

export function FinanceOverview({
  finance: f,
  view,
  today,
  explanations,
  onAction,
  onExplain,
  onPayment,
  onPayments,
  onSavings,
  onTaxi,
}: {
  finance: Finance;
  view: ReturnType<typeof financeView>;
  today: string;
  explanations: boolean;
  onAction: (request: FinanceFormRequest) => void;
  onExplain: () => void;
  onPayment: (id: string) => void;
  onPayments: () => void;
  onSavings: () => void;
  onTaxi: (key: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const due = f.payments.filter((p) => isDuePayment(p, today));
  const nearest = nextTodayPayment(f.payments, today);
  const unsettled = f.taxiWeeks.filter((week) => !week.settled);
  const incomplete = unsettled.find((week) => !week.complete);
  const positive = unsettled.filter((week) => week.complete && week.settlementMinor > 0);
  const negative = unsettled.filter((week) => week.complete && week.settlementMinor < 0);
  const unknownAccounts = f.accounts.filter((a) => a.currency === 'UAH' && a.balanceMinor == null);
  const metric = financeDisplay(f.display).overviewMetric;
  const until = shiftDate(today, 6);
  const scheduled = preview
    ? f.payments
        .filter((p) => isOpenPayment(p) && (!isPaymentDate(p.nextDate) || p.nextDate <= until))
        .map((p) => ({
          payment: p,
          rows: isPaymentDate(p.nextDate)
            ? paymentSchedule(p, 1200).filter((r) => r.date <= until)
            : [],
          review: possibleBankPayment(p, f.transactions) != null,
        }))
    : [];
  const reviewRequired = scheduled.some((p) => p.review || !p.rows.length);
  const projected = sumMoney([
    view.available,
    -sumMoney(scheduled.flatMap((p) => p.rows.map((r) => r.payment))),
  ]);

  const upcoming = due.length ? (
    <button className="finance-overview-row finance-overview-attention" onClick={onPayments}>
      <span>На підтвердження</span>
      <strong>{counted(due.length, 'оплата', 'оплати', 'оплат')} ›</strong>
    </button>
  ) : nearest.kind === 'payment' ? (
    <button className="finance-overview-row" onClick={() => onPayment(nearest.payment.id)}>
      <span>
        Найближча оплата
        <small>
          {nearest.payment.name} · {financeDate(nearest.payment.nextDate)}
        </small>
      </span>
      <strong>
        {nearest.amountMinor == null ? 'Суму уточнити' : moneyLabel(nearest.amountMinor)} ›
      </strong>
    </button>
  ) : null;
  const taxiAmounts = (metric === 'taxi' || f.settings.taxiVisible) && (
    <>
      {[
        {
          weeks: positive,
          label: positive.some((week) => week.closed)
            ? 'Таксопарк має доплатити'
            : 'Очікувана доплата таксопарку',
        },
        { weeks: negative, label: 'Зарезервовано для таксопарку' },
      ].map(({ weeks, label }) =>
        weeks.length ? (
          <button
            className="finance-overview-row"
            key={label}
            onClick={() => onTaxi((weeks.find((week) => week.closed) ?? weeks[0]).key)}
          >
            <span>
              {label}
              {weeks.some((week) => !week.closed) && <small>Попередній розрахунок</small>}
            </span>
            <strong>
              {moneyLabel(Math.abs(sumMoney(weeks.map((week) => week.settlementMinor))))} ›
            </strong>
          </button>
        ) : null,
      )}
    </>
  );

  return (
    <section className="renewal-card renewal-money-hero finance-overview" aria-label="Вільні кошти">
      <button className="finance-balance-button" onClick={onExplain} aria-haspopup="dialog">
        <span className="renewal-eyebrow">
          Вільні кошти{f.accounts.some((a) => a.currency !== 'UAH') ? ' · UAH' : ''}
        </span>
        <span className={`renewal-big ${view.available < 0 ? 'text-neg' : 'text-a2'}`}>
          {view.unknownBalances ? '—' : moneyLabel(view.available)}
        </span>
        <span className="renewal-link">Як пораховано ↗</span>
      </button>
      {unknownAccounts.length > 0 && (
        <p className="renewal-chart-note">
          Уточни залишки · {unknownAccounts.map((a) => a.name).join(', ')}
        </p>
      )}
      {incomplete && (
        <button className="renewal-link text-left" onClick={() => onTaxi(incomplete.key)}>
          Бракує даних за період таксі ↗
        </button>
      )}
      {explanations && (
        <p className="renewal-chart-note">
          Власні гривневі кошти за вирахуванням резерву парку та коштів, зарезервованих на цілі.
        </p>
      )}
      <div className="finance-quick-actions">
        <button className="renewal-button" onClick={() => onAction({ kind: 'expense' })}>
          Записати витрату
        </button>
        <button className="renewal-secondary" onClick={() => onAction({ kind: 'income' })}>
          Додати дохід
        </button>
        <button
          className="renewal-secondary finance-personal-action"
          onClick={() => onAction({ kind: 'taxi-personal' })}
          aria-label="Особистий дохід"
          aria-describedby="finance-personal-kinds"
        >
          <span>Особистий дохід</span>
          <small id="finance-personal-kinds">Решта · чайові · поїздка</small>
        </button>
      </div>
      <div className="finance-overview-context">
        {due.length > 0 && upcoming}
        {metric === 'savings' && (
          <button className="finance-overview-row" onClick={onSavings}>
            <span>У цілях</span>
            <strong>{moneyLabel(view.savings)} ›</strong>
          </button>
        )}
        {due.length === 0 && metric === 'payment' && upcoming}
        {taxiAmounts}
        {nearest.kind !== 'empty' && (
          <button
            className="renewal-link finance-preview-link"
            onClick={() => setPreview(true)}
            aria-haspopup="dialog"
          >
            Після оплат на 7 днів ↗
          </button>
        )}
      </div>
      {preview && (
        <Sheet label="Після оплат на 7 днів" onClose={() => setPreview(false)}>
          <div className="renewal-finance">
            <h2 className="text-lg font-bold">Після оплат на 7 днів</h2>
            {!view.unknownBalances && !reviewRequired && (
              <p className={`renewal-big ${projected < 0 ? 'text-neg' : ''}`}>
                {moneyLabel(projected)}
              </p>
            )}
            <p className="renewal-chart-note">
              {view.unknownBalances
                ? 'Для оцінки бракує даних про поточні кошти.'
                : reviewRequired
                  ? 'Для оцінки потрібно звірити списання або уточнити суму оплати.'
                  : 'Оцінка після запланованих оплат, включно з попередніми, що ще очікують підтвердження.'}
            </p>
            {!scheduled.length && <p>Запланованих оплат у ці дні немає.</p>}
            {scheduled.map(({ payment, rows, review }) => (
              <div key={payment.id} className="renewal-list-row">
                <span>
                  {payment.name}
                  <small>
                    {review
                      ? 'Можливе списання в банку'
                      : rows.length > 1
                        ? `${counted(rows.length, 'оплата', 'оплати', 'оплат')} · до ${financeDate(rows.at(-1)!.date)}`
                        : rows.length
                          ? financeDate(rows[0].date)
                          : 'Уточни дату або суму оплати'}
                  </small>
                </span>
                {rows.length > 0 && <b>{moneyLabel(sumMoney(rows.map((r) => r.payment)))}</b>}
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </section>
  );
}
