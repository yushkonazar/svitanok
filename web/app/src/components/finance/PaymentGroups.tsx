import { useRef, useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { PaymentCard } from './PaymentCard.tsx';
import type { FinanceFormRequest } from './FinanceForm.tsx';

type Payment = Finance['payments'][number];
const GROUPS = [
  { key: 'installments', label: 'Розстрочки', kinds: ['installment', 'card-installment'] },
  { key: 'subscriptions', label: 'Підписки', kinds: ['subscription'] },
  { key: 'loans', label: 'Кредити', kinds: ['loan'] },
  { key: 'bills', label: 'Інші платежі', kinds: ['bill'] },
];

export function PaymentGroups({
  payments,
  onOpen,
  onAction,
}: {
  payments: Payment[];
  onOpen: (id: string) => void;
  onAction: (request: FinanceFormRequest) => void;
}) {
  const active = payments.filter((p) => p.status === 'active');
  if (!active.length)
    return (
      <p className="renewal-muted mt-3">
        Активних платежів немає. Додай підписку, кредит або інший платіж.
      </p>
    );
  return (
    <div className="renewal-payment-groups">
      {GROUPS.map((group) => {
        const items = active
          .filter((p) => group.kinds.includes(p.kind))
          .sort(
            (a, b) => a.nextDate.localeCompare(b.nextDate) || a.name.localeCompare(b.name, 'uk'),
          );
        return items.length ? (
          <PaymentRail
            key={group.key}
            group={group}
            payments={items}
            onOpen={onOpen}
            onAction={onAction}
          />
        ) : null;
      })}
    </div>
  );
}

function PaymentRail({
  group,
  payments,
  onOpen,
  onAction,
}: {
  group: (typeof GROUPS)[number];
  payments: Payment[];
  onOpen: (id: string) => void;
  onAction: (request: FinanceFormRequest) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(0);
  const index = Math.min(position, payments.length - 1);
  const move = (direction: number) => {
    const element = rail.current;
    if (!element) return;
    const cards = [...element.children] as HTMLElement[];
    const nearest = cards.reduce(
      (best, card, i) =>
        Math.abs(card.offsetLeft - element.offsetLeft - element.scrollLeft) <
        Math.abs(cards[best].offsetLeft - element.offsetLeft - element.scrollLeft)
          ? i
          : best,
      0,
    );
    const next = Math.max(0, Math.min(cards.length - 1, nearest + direction));
    element.scrollTo({
      left: cards[next].offsetLeft - element.offsetLeft,
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  };
  return (
    <section className="renewal-payment-group" aria-label={group.label}>
      <div className="renewal-payment-group-head">
        <h3>
          {group.label} <span className="renewal-payment-count">{payments.length}</span>
        </h3>
        {payments.length > 1 && (
          <div className="renewal-payment-navigation">
            <span aria-live="polite">
              {index + 1} / {payments.length}
            </span>
            <button
              type="button"
              aria-label={`Попередній платіж · ${group.label}`}
              disabled={index === 0}
              onClick={() => move(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label={`Наступний платіж · ${group.label}`}
              disabled={index === payments.length - 1}
              onClick={() => move(1)}
            >
              ›
            </button>
          </div>
        )}
      </div>
      <div
        ref={rail}
        id={`payment-rail-${group.key}`}
        className="renewal-payment-rail"
        role="region"
        aria-label={`Платежі · ${group.label}`}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          const cards = [...element.children] as HTMLElement[];
          const nearest = cards.reduce(
            (best, card, i) =>
              Math.abs(card.offsetLeft - element.offsetLeft - element.scrollLeft) <
              Math.abs(cards[best].offsetLeft - element.offsetLeft - element.scrollLeft)
                ? i
                : best,
            0,
          );
          setPosition(nearest);
        }}
      >
        {payments.map((p) => (
          <PaymentCard
            key={p.id}
            payment={p}
            compact
            onOpen={() => onOpen(p.id)}
            onPay={() => onAction({ kind: 'payment-paid', id: p.id })}
            onEdit={() => onAction({ kind: 'payment', id: p.id })}
            onCloseDebt={() => onAction({ kind: 'payment-close', id: p.id })}
            onCancel={() => onAction({ kind: 'payment-cancel', id: p.id })}
          />
        ))}
      </div>
    </section>
  );
}
