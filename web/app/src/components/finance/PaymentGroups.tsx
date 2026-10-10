import { useLayoutEffect, useRef, useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { PaymentCard } from './PaymentCard.tsx';
import type { FinanceFormRequest } from './FinanceForm.tsx';

type Payment = Finance['payments'][number];
const GROUPS = [
  { key: 'installments', label: 'Оплата частинами', kinds: ['installment'] },
  { key: 'card-installments', label: 'Розстрочки на картку', kinds: ['card-installment'] },
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
  const order = JSON.stringify(payments.map((p) => [p.id, p.nextDate]));
  const [focus, setFocus] = useState({ order, index: 0 });
  const index = focus.order === order ? Math.min(focus.index, payments.length - 1) : 0;
  // A changed due-date/order starts with the nearest unpaid obligation. Polling
  // unchanged data must not move the card the user is currently reading.
  useLayoutEffect(() => {
    rail.current?.scrollTo?.({ left: 0, behavior: 'instant' });
  }, [order]);
  const cardLeft = (element: HTMLDivElement, card: HTMLElement) =>
    card.offsetLeft - (element.clientWidth - card.offsetWidth) / 2;
  const nearestCard = (element: HTMLDivElement) => {
    const cards = [...element.children] as HTMLElement[];
    return cards.reduce(
      (best, card, i) =>
        Math.abs(cardLeft(element, card) - element.scrollLeft) <
        Math.abs(cardLeft(element, cards[best]) - element.scrollLeft)
          ? i
          : best,
      0,
    );
  };
  const goTo = (target: number) => {
    const element = rail.current;
    if (!element) return;
    const cards = [...element.children] as HTMLElement[];
    const next = Math.max(0, Math.min(cards.length - 1, target));
    element.scrollTo({
      left: cardLeft(element, cards[next]),
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  };
  const move = (direction: number) => {
    if (rail.current) goTo(nearestCard(rail.current) + direction);
  };
  return (
    <section className="renewal-payment-group" aria-label={group.label}>
      <div className="renewal-payment-group-head">
        <h3>
          {group.label} <span className="renewal-payment-count">{payments.length}</span>
        </h3>
      </div>
      <div
        ref={rail}
        id={`payment-rail-${group.key}`}
        className="renewal-payment-rail"
        role="region"
        aria-label={`Платежі · ${group.label}`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'Home') goTo(0);
          else if (event.key === 'End') goTo(payments.length - 1);
          else move(event.key === 'ArrowRight' ? 1 : -1);
        }}
        onScroll={(event) => {
          const next = nearestCard(event.currentTarget);
          setFocus((old) =>
            old.order === order && old.index === next ? old : { order, index: next },
          );
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
      {payments.length > 1 && (
        <div className="renewal-payment-navigation">
          <button
            type="button"
            aria-label={`Попередній платіж · ${group.label}`}
            aria-controls={`payment-rail-${group.key}`}
            disabled={index === 0}
            onClick={() => move(-1)}
          >
            ‹
          </button>
          <div className="renewal-payment-position">
            <span aria-live="polite">
              {index + 1} / {payments.length}
            </span>
            <div className="renewal-payment-position-track" aria-hidden="true">
              <span
                style={{
                  width: `${100 / payments.length}%`,
                  transform: `translateX(${index * 100}%)`,
                }}
              />
            </div>
          </div>
          <button
            type="button"
            aria-label={`Наступний платіж · ${group.label}`}
            aria-controls={`payment-rail-${group.key}`}
            disabled={index === payments.length - 1}
            onClick={() => move(1)}
          >
            ›
          </button>
        </div>
      )}
    </section>
  );
}
