import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { financeDisplay } from '../../../../core/finance/display.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { expenseBand } from '../../lib/expensePalette.ts';
import { useReducedMotion } from '../../lib/useReducedMotion.ts';
export function TransactionAmount({
  transaction: t,
  display: settings,
}: {
  transaction: Finance['transactions'][number];
  display?: Finance['display'];
}) {
  const display = financeDisplay(settings),
    ref = useRef<HTMLSpanElement>(null),
    [uah, setUah] = useState(false);
  const foreign = t.currency !== 'UAH' && t.amountUah != null;
  const reduced = useReducedMotion(),
    cycling = foreign && display.currencyCycle && display.animations && !reduced;
  useEffect(() => {
    if (!cycling) return;
    let visible = true;
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            visible = entries[0]?.isIntersecting ?? true;
          });
    if (ref.current) observer?.observe(ref.current);
    const timer = window.setInterval(() => {
      if (visible && document.visibilityState !== 'hidden') setUah((v) => !v);
    }, 1500);
    return () => {
      window.clearInterval(timer);
      observer?.disconnect();
    };
  }, [cycling]);
  const band =
    t.kind === 'expense' && t.amountUah != null && t.amountUah < 0
      ? expenseBand(t.amountUah, display.expenseThresholds)
      : null;
  const both = foreign
    ? `${moneyLabel(t.amountMinor, t.currency)} · ${moneyLabel(t.amountUah!)}`
    : moneyLabel(t.amountMinor, t.currency);
  return (
    <span
      ref={ref}
      className={`finance-transaction-amount ${band ? 'finance-expense-tone' : t.amountMinor > 0 ? 'text-pos' : ''}`}
      style={
        band
          ? ({ '--expense-dark': band.dark, '--expense-light': band.light } as CSSProperties)
          : undefined
      }
      title={band ? `${both} · ${band.label}` : both}
    >
      <span className="sr-only">{both}</span>
      {cycling ? (
        <span className="finance-currency-stack" aria-hidden="true">
          <span className="finance-currency-value" data-visible={!uah}>
            {moneyLabel(t.amountMinor, t.currency)}
          </span>
          <span className="finance-currency-value" data-visible={uah}>
            {moneyLabel(t.amountUah!)}
          </span>
        </span>
      ) : (
        <span aria-hidden="true" className="finance-currency-value">
          {both}
        </span>
      )}
    </span>
  );
}
