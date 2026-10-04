import type { Finance } from '../../api/finance-schema.ts';
import { paymentSchedule } from '../../lib/paymentSchedule.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { shiftDate } from '../../../../core/finance/planning.mjs';
import { PageHeading } from '../ui/PageHeading.tsx';
import {
  isDebtKind,
  fixedDebtPayment,
  interestDebtPayment,
  INTEREST_METHOD_LABELS,
} from '../../../../core/finance/payments.mjs';
export function PaymentDetail({
  payment: p,
  onBack,
  onEdit,
  onPay,
  onCloseDebt,
  onCancel,
}: {
  payment: Finance['payments'][number];
  onBack: () => void;
  onEdit: () => void;
  onPay: () => void;
  onCloseDebt: () => void;
  onCancel: () => void;
}) {
  const rows = paymentSchedule(p),
    total = p.totalMinor,
    left = p.remainingMinor;
  const percentage =
    total && left != null ? Math.max(0, Math.min(100, ((total - left) / total) * 100)) : null;
  const projectedRows = p.interestMethod ? paymentSchedule(p, 1200) : [];
  const projectedTotal = projectedRows.reduce((sum, row) => sum + row.payment, 0);
  return (
    <div className="flex flex-col gap-5">
      <button className="renewal-link self-start" onClick={onBack}>
        ← До фінансів
      </button>
      <PageHeading eyebrow="ЗОБОВ’ЯЗАННЯ" title={p.name} accent="крок за кроком." />
      <section className="renewal-card renewal-money-hero">
        <span className="renewal-eyebrow">ЗАЛИШИЛОСЬ СПЛАТИТИ</span>
        <div className="renewal-big mt-3">
          {left == null ? '—' : moneyLabel(left + (p.overpaymentRemainingMinor ?? 0))}
        </div>
        {p.overpaymentTotalMinor != null && (
          <div className="renewal-inset mt-3">
            <p>Сума покупки: {moneyLabel(total ?? 0)}</p>
            <p>Переплата за договором: {moneyLabel(p.overpaymentTotalMinor)}</p>
            <p>Разом за договором: {moneyLabel((total ?? 0) + p.overpaymentTotalMinor)}</p>
            <p className="renewal-muted mt-2">
              Залишок тіла {moneyLabel(left ?? 0)} · переплати{' '}
              {moneyLabel(p.overpaymentRemainingMinor ?? 0)}
            </p>
            <p className="renewal-muted">
              Сплачено переплати: {moneyLabel(p.overpaymentPaidMinor ?? 0)}
            </p>
          </div>
        )}
        {p.interestMethod && (
          <div className="renewal-inset mt-3">
            <p>{INTEREST_METHOD_LABELS[p.interestMethod]}</p>
            <p className="renewal-muted">
              Показаний залишок — тіло боргу. Відсотки розраховуються щомісяця за номінальною
              ставкою ÷ 12.
            </p>
            {projectedRows.length > 0 && projectedRows.at(-1)?.remaining === 0 && (
              <p className="renewal-muted mt-2">
                Прогноз до сплати: {moneyLabel(projectedTotal)} · відсотки й комісії:{' '}
                {moneyLabel(projectedTotal - (left ?? 0))}.
              </p>
            )}
          </div>
        )}
        <p className="renewal-muted">
          {p.installmentsLeft == null ? 'За твоїм графіком' : `${p.installmentsLeft} платежів`} ·{' '}
          {p.status === 'done' ? 'Завершено' : p.status === 'paused' ? 'Призупинено' : 'Активний'}
        </p>
        {percentage != null && (
          <>
            <div className="renewal-progress">
              <span style={{ width: `${percentage}%` }} />
            </div>
            <p className="renewal-muted mt-3">
              Погашено тіла {moneyLabel(total! - left!)} із {moneyLabel(total!)} ·{' '}
              {percentage.toFixed(0)}%
            </p>
          </>
        )}
        <div className="renewal-metrics">
          <div className="renewal-metric">
            <span className="renewal-muted">Повний платіж</span>
            <strong>
              {moneyLabel(
                interestDebtPayment(p)?.amountMinor ??
                  fixedDebtPayment(p)?.amountMinor ??
                  p.amountMinor,
              )}
            </strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">
              {p.overpaymentTotalMinor != null ? 'Початковий термін' : 'Річна ставка'}
            </span>
            <strong>
              {p.overpaymentTotalMinor != null
                ? `${p.termMonths} міс.`
                : `${((p.rateBps ?? 0) / 100).toLocaleString('uk-UA')}%`}
            </strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">
              {p.overpaymentTotalMinor != null
                ? 'Переплата наступного платежу'
                : p.interestMethod
                  ? 'Відсотки й комісія'
                  : 'Комісія в платежі'}
            </span>
            <strong>
              {moneyLabel(
                interestDebtPayment(p)?.overpaymentMinor ??
                  fixedDebtPayment(p)?.overpaymentMinor ??
                  p.feeMinor ??
                  0,
              )}
            </strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Наступна дата</span>
            <strong>
              {new Date(p.nextDate + 'T12:00:00Z').toLocaleDateString('uk-UA', {
                day: 'numeric',
                month: 'short',
              })}
            </strong>
          </div>
        </div>
        {p.lender && <p className="renewal-muted mt-4">Кредитор · {p.lender}</p>}
        {p.note && <p className="renewal-muted mt-2">{p.note}</p>}
        <div className="renewal-payment-actions mt-4">
          <button disabled={p.status !== 'active'} className="renewal-button" onClick={onPay}>
            Підтвердити оплату
          </button>
          <button className="renewal-secondary" onClick={onEdit}>
            Налаштувати
          </button>
          {isDebtKind(p.kind) && (
            <button
              className="renewal-secondary"
              onClick={onCloseDebt}
              disabled={p.status !== 'active' || p.remainingMinor == null || p.remainingMinor === 0}
            >
              Достроково погасити
            </button>
          )}
          {p.kind === 'subscription' && p.status !== 'done' && (
            <button className="renewal-secondary" onClick={onCancel}>
              Скасувати підписку
            </button>
          )}
        </div>
      </section>
      {left != null && ((p.rateBps ?? 0) === 0 || p.interestMethod) && rows.length > 0 && (
        <section className="renewal-card">
          <h2 className="text-lg font-semibold mb-4">Як зменшуватиметься борг</h2>
          <ObservationChart
            label="Плановий залишок тіла боргу"
            unit="₴"
            points={[
              { date: shiftDate(p.nextDate, -1), value: left / 100 },
              ...rows.map((r) => ({ date: r.date, value: (r.remaining ?? 0) / 100 })),
            ].filter((r, i, a) => i === 0 || r.date !== a[i - 1].date)}
          />
          <p className="renewal-chart-note mt-3">
            Прогноз за обраним графіком, без дострокових оплат. Залишок зміниться в обліку лише
            після підтвердження фактичної оплати.
          </p>
        </section>
      )}
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Календар платежів</h2>
        {p.installmentsLeft === 0 && (left ?? 0) + (p.overpaymentRemainingMinor ?? 0) > 0 && (
          <p className="renewal-inset renewal-muted mt-3">
            Планові платежі закінчились, але є залишок боргу. Уточни графік у договорі та онови
            кількість платежів. Борг зберігається в обліку.
          </p>
        )}
        {(p.rateBps ?? 0) > 0 && !p.interestMethod && (
          <p className="renewal-muted mt-3">
            Показуємо повні платежі за введеним договором. Погашення тіла потрібно вказувати при
            оплаті; точний банківський графік із самої ставки визначити не можна.
          </p>
        )}
        {rows.map((r) => (
          <div className="renewal-list-row" key={r.date}>
            <span>
              {new Date(r.date + 'T12:00:00Z').toLocaleDateString('uk-UA', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
              {r.remaining != null && (
                <small>Після оплати: {moneyLabel(r.remaining + (r.extraRemaining ?? 0))}</small>
              )}
              {r.overpayment != null && (
                <small>З платежу переплата: {moneyLabel(r.overpayment)}</small>
              )}
            </span>
            <strong>{moneyLabel(r.payment)}</strong>
          </div>
        ))}
        {(p.installmentsLeft ?? 0) > 24 && (
          <p className="renewal-muted mt-3">Показано найближчі 24 платежі.</p>
        )}
        <p className="renewal-chart-note mt-3">
          Нагадування за {p.remindDays} дн. · Для 29–31 числа врахована тривалість місяця.
        </p>
      </section>
    </div>
  );
}
