import type { Finance } from '../../api/finance-schema.ts';
import { moneyLabel } from '../../lib/financeView.ts';
import { useFinanceAction } from './useFinanceAction.ts';
import { useEffect, useState } from 'react';
export function FinanceMilestone({ finance }: { finance: Finance }) {
  const event = finance.events?.find((e) => e.kind === 'payment-completed' && !e.seenAt);
  if (!event) return null;
  return <Milestone key={event.id} finance={finance} event={event} />;
}
function Milestone({
  finance,
  event,
}: {
  finance: Finance;
  event: NonNullable<Finance['events']>[number];
}) {
  const action = useFinanceAction(finance);
  const storageKey = `svitanok.finance.celebration.${event.id}`;
  const [animate] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) !== 'shown';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, 'shown');
    } catch {
      /* visual preference only */
    }
  }, [storageKey]);
  const d = event.data,
    relief = Number(d.monthlyReliefMinor ?? 0),
    before = Number(d.debtBeforeMinor ?? 0),
    reduced = Number(d.debtReducedMinor ?? 0);
  return (
    <section className="renewal-card finance-milestone" data-animate={animate} role="status">
      <span className="finance-milestone-check" aria-hidden="true">
        ✓
      </span>
      <p className="renewal-eyebrow">ЗАВЕРШЕНО</p>
      <h2 className="text-xl font-bold mt-2">{String(d.name)} закрито</h2>
      <p className="renewal-muted mt-2">
        Фінальна оплата підтверджена: {moneyLabel(Number(d.paidMinor ?? 0))}.
      </p>
      {reduced > 0 && (
        <p className="mt-3">
          Записаний залишок боргів: {moneyLabel(before)} →{' '}
          <b>{moneyLabel(Math.max(0, before - reduced))}</b>
        </p>
      )}
      {relief > 0 && (
        <p className="text-pos mt-2">
          Майбутнє регулярне навантаження менше на {moneyLabel(relief)} на місяць.
        </p>
      )}
      <p className="renewal-chart-note mt-2">
        Це зменшення майбутніх оплат; поточний баланс не збільшується.
      </p>
      <button
        className="renewal-secondary mt-3"
        disabled={action.pending}
        onClick={() => void action.run('event-seen', { eventId: event.id })}
      >
        Чудово
      </button>
      {action.error && (
        <p role="alert" className="text-neg">
          {action.error}
        </p>
      )}
    </section>
  );
}
