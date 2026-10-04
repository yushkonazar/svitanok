import type { Finance } from '../../api/finance-schema.ts';
import { paymentSchedule } from '../../lib/paymentSchedule.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { ObservationChart } from '../charts/ObservationChart.tsx';
import { shiftDate } from '../../../../core/finance/planning.mjs';
import { PageHeading } from '../ui/PageHeading.tsx';
import { isDebtKind } from '../../../../core/finance/payments.mjs';
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
  return (
    <div className="flex flex-col gap-5">
      <button className="renewal-link self-start" onClick={onBack}>
        ← До фінансів
      </button>
      <PageHeading eyebrow="ЗОБОВ’ЯЗАННЯ" title={p.name} accent="крок за кроком." />
      <section className="renewal-card renewal-money-hero">
        <span className="renewal-eyebrow">ЗАЛИШИЛОСЬ СПЛАТИТИ</span>
        <div className="renewal-big mt-3">{left == null ? '—' : moneyLabel(left)}</div>
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
              Погашено {moneyLabel(total! - left!)} із {moneyLabel(total!)} ·{' '}
              {percentage.toFixed(0)}%
            </p>
          </>
        )}
        <div className="renewal-metrics">
          <div className="renewal-metric">
            <span className="renewal-muted">Повний платіж</span>
            <strong>{moneyLabel(p.amountMinor)}</strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Річна ставка</span>
            <strong>{((p.rateBps ?? 0) / 100).toLocaleString('uk-UA')}%</strong>
          </div>
          <div className="renewal-metric">
            <span className="renewal-muted">Комісія в платежі</span>
            <strong>{moneyLabel(p.feeMinor ?? 0)}</strong>
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
      {left != null && (p.rateBps ?? 0) === 0 && rows.length > 0 && (
        <section className="renewal-card">
          <h2 className="text-lg font-semibold mb-4">Як зменшуватиметься борг</h2>
          <ObservationChart
            label="Плановий залишок боргу"
            unit="₴"
            points={[
              { date: shiftDate(p.nextDate, -1), value: left / 100 },
              ...rows.map((r) => ({ date: r.date, value: (r.remaining ?? 0) / 100 })),
            ].filter((r, i, a) => i === 0 || r.date !== a[i - 1].date)}
          />
          <p className="renewal-chart-note mt-3">
            Прогноз за фіксованим платежем, без дострокових оплат. Залишок зміниться в обліку лише
            після підтвердження фактичної оплати.
          </p>
        </section>
      )}
      <section className="renewal-card">
        <h2 className="text-lg font-semibold">Календар платежів</h2>
        {p.installmentsLeft === 0 && (left ?? 0) > 0 && (
          <p className="renewal-inset renewal-muted mt-3">
            Планові платежі закінчились, але є залишок боргу. Уточни графік у договорі та онови
            кількість платежів. Борг зберігається в обліку.
          </p>
        )}
        {(p.rateBps ?? 0) > 0 && (
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
              {r.remaining != null && <small>Після оплати: {moneyLabel(r.remaining)}</small>}
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
