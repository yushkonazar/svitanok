import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { financeDisplay } from '../../../../core/finance/display.mjs';
import { moneyLabel } from '../../lib/financeView.ts';
import { amountBand } from '../../lib/expensePalette.ts';
import { useReducedMotion } from '../../lib/useReducedMotion.ts';
export function TransactionAmount({
  transaction: t,
  display: settings,
  animate = true,
}: {
  transaction: Finance['transactions'][number];
  display?: Finance['display'];
  animate?: boolean;
}) {
  const display = financeDisplay(settings),
    ref = useRef<HTMLSpanElement>(null),
    paused = useRef(false),
    [uah, setUah] = useState(false);
  const foreign = t.currency !== 'UAH' && t.amountUah != null;
  const reduced = useReducedMotion(),
    cycling = animate && foreign && display.currencyCycle && display.animations && !reduced;
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
      if (
        visible &&
        !paused.current &&
        !ref.current?.closest('button,a')?.matches(':focus-visible') &&
        document.visibilityState !== 'hidden'
      )
        setUah((v) => !v);
    }, 1500);
    return () => {
      window.clearInterval(timer);
      observer?.disconnect();
    };
  }, [cycling]);
  const amountUah = t.amountUah ?? (t.currency === 'UAH' ? t.amountMinor : null);
  const incoming = t.amountMinor > 0;
  const band = amountUah
    ? amountBand(
        amountUah,
        incoming ? display.inflowThresholds : display.expenseThresholds,
        incoming ? 'in' : 'out',
      )
    : null;
  const signedMoney = (amount: number, currency?: string) =>
    `${amount > 0 ? '+' : ''}${moneyLabel(amount, currency)}`;
  const original = signedMoney(t.amountMinor, t.currency);
  const hryvnias = foreign ? signedMoney(t.amountUah!) : null;
  const both = hryvnias ? `${original} · ${hryvnias}` : original;
  return (
    <span
      ref={ref}
      onMouseEnter={() => {
        paused.current = true;
      }}
      onMouseLeave={() => {
        paused.current = false;
      }}
      className={`finance-transaction-amount${band ? (incoming ? ' finance-inflow-tone' : ' finance-expense-tone') : ''}`}
      data-amount-band={band?.rank}
      style={
        band
          ? ({ '--amount-dark': band.dark, '--amount-light': band.light } as CSSProperties)
          : undefined
      }
      title={band ? `${both} · ${band.label}` : both}
    >
      <span className="sr-only">{both}</span>
      {cycling ? (
        <span className="finance-currency-stack" aria-hidden="true">
          <span className="finance-currency-value" data-visible={!uah}>
            {original}
          </span>
          <span className="finance-currency-value" data-visible={uah}>
            {hryvnias}
          </span>
        </span>
      ) : (
        <span className="finance-currency-static" aria-hidden="true">
          <span className="finance-currency-value">{original}</span>
          {hryvnias && <span className="finance-currency-value">{hryvnias}</span>}
        </span>
      )}
    </span>
  );
}
