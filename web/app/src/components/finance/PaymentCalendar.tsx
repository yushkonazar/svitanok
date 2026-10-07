import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { paymentCalendar } from '../../lib/paymentCalendar.ts';
import { financeView, moneyLabel } from '../../lib/financeView.ts';
import { kyivParts } from '../../../../core/finance/planning.mjs';
import { Sheet } from '../ui/Sheet.tsx';
import { useTick } from '../../lib/useTick.ts';
export function PaymentCalendar({
  finance: f,
  onClose,
  onPayment,
}: {
  finance: Finance;
  onClose: () => void;
  onPayment: (id: string) => void;
}) {
  const [days, setDays] = useState(30);
  const now = useTick(60000);
  const view = financeView(f, 7, now);
  const unknown =
    view.unknownBalances ||
    f.payments.some(
      (p) =>
        p.status === 'active' &&
        p.installmentsLeft === 0 &&
        (p.remainingMinor ?? 0) + (p.overpaymentRemainingMinor ?? 0) > 0,
    );
  const plan = paymentCalendar(f, kyivParts(now).date, days, unknown ? null : view.available);
  return (
    <Sheet label="Календар майбутніх платежів" onClose={onClose}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Коли потрібні гроші</h2>
        <button className="renewal-secondary" aria-label="Закрити календар" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="renewal-segments mt-4">
        {[7, 30].map((n) => (
          <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>
            {n} днів
          </button>
        ))}
      </div>
      <p className="renewal-chart-note mt-4">
        План за відомими платежами, включно з простроченими. Нові доходи й повсякденні витрати не
        прогнозуються. Жодного списання ця сторінка не виконує.
      </p>
      {unknown && (
        <p role="status" className="renewal-inset mt-3">
          Для повного прогнозу уточни залишки або незавершений графік боргу. Дати відомих платежів
          доступні нижче.
        </p>
      )}
      <div className="renewal-inset mt-4">
        <p>
          Заплановано: <b>{moneyLabel(plan.total)}</b>
        </p>
        <p className="mt-2">
          Після цих платежів: <b>{plan.remaining === null ? '—' : moneyLabel(plan.remaining)}</b>
        </p>
      </div>
      <div className="flex flex-col gap-4 mt-5">
        {plan.dates.map((d) => (
          <section key={d.date} className="renewal-inset">
            <h3 className="font-semibold">
              {new Date(d.date + 'T12:00:00Z').toLocaleDateString('uk-UA', {
                day: 'numeric',
                month: 'long',
              })}
              {d.overdue ? ' · строк минув' : ''}
            </h3>
            {d.payments.map((p) => (
              <button
                key={`${p.id}:${p.date}`}
                className="flex justify-between w-full gap-3 text-left mt-3"
                onClick={() => onPayment(p.id)}
              >
                <span>{p.name} ↗</span>
                <b className="shrink-0">{moneyLabel(p.payment)}</b>
              </button>
            ))}
            <p className="renewal-chart-note mt-3">
              Залишок за планом:{' '}
              <b className={d.remaining !== null && d.remaining < 0 ? 'text-neg' : ''}>
                {d.remaining === null ? '—' : moneyLabel(d.remaining)}
              </b>
            </p>
          </section>
        ))}
      </div>
      {!plan.dates.length && <p className="renewal-muted mt-5">На цей період платежів немає.</p>}
    </Sheet>
  );
}
