import type { Finance } from '../../api/finance-schema.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { PAYMENT_KIND_LABELS, isDebtKind } from '../../../../core/finance/payments.mjs';

export function PaymentCard({
  payment: p,
  onOpen,
  onPay,
  onEdit,
  onCloseDebt,
  onCancel,
}: {
  payment: Finance['payments'][number];
  onOpen: () => void;
  onPay: () => void;
  onEdit: () => void;
  onCloseDebt: () => void;
  onCancel: () => void;
}) {
  const date = new Date(p.nextDate + 'T12:00:00Z');
  return (
    <article className="renewal-payment-card" aria-label={p.name}>
      <time className="renewal-datebox" dateTime={p.nextDate}>
        <span>{p.nextDate.slice(8)}</span>
        <small>{date.toLocaleDateString('uk-UA', { month: 'short' })}</small>
      </time>
      <div className="renewal-payment-info">
        <button className="renewal-payment-name" onClick={onOpen}>
          {p.name} ↗
        </button>
        <p className="renewal-payment-meta">{PAYMENT_KIND_LABELS[p.kind]}</p>
      </div>
      <strong className="renewal-payment-amount">{moneyLabel(p.amountMinor)}</strong>
      <div className="renewal-payment-summary">
        <p className="renewal-muted">
          {date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
        {p.remainingMinor != null && (
          <p className="renewal-muted">
            Залишок {moneyLabel(p.remainingMinor)}
            {p.installmentsLeft != null ? ` · ${p.installmentsLeft} платежів` : ''}
          </p>
        )}
      </div>
      <div className="renewal-payment-actions">
        <button className="renewal-button" onClick={onPay}>
          Підтвердити оплату
        </button>
        <button className="renewal-secondary" onClick={onEdit}>
          Налаштувати
        </button>
        {isDebtKind(p.kind) && (
          <button
            className="renewal-link"
            onClick={onCloseDebt}
            disabled={p.remainingMinor == null || p.remainingMinor === 0}
          >
            Достроково погасити
          </button>
        )}
        {p.kind === 'subscription' && (
          <button className="renewal-link" onClick={onCancel}>
            Скасувати підписку
          </button>
        )}
      </div>
    </article>
  );
}
