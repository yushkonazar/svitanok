import { useLayoutEffect, useRef, useState } from 'react';
import {
  TODAY_BLOCKS,
  DEFAULT_TODAY_ORDER,
  saveTodayOrder,
  useTodayOrder,
} from '../../lib/todayLayout.ts';
import { haptic } from '../../telegram.ts';

export function TodayOrder() {
  const order = useTodayOrder();
  const [announcement, announce] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const pendingFocus = useRef<{ id: string; direction: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const row = list.current?.querySelector('[data-order-id="' + pending.id + '"]');
    const requested = row?.querySelector<HTMLButtonElement>(
      '[data-direction="' + pending.direction + '"]:not(:disabled)',
    );
    (requested ?? row?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  }, [order]);
  function move(index: number, direction: number) {
    const next = [...order];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    pendingFocus.current = { id: next[target], direction };
    saveTodayOrder(next);
    haptic('light');
    announce(
      TODAY_BLOCKS.find((block) => block.id === next[target])!.label + ': позиція ' + (target + 1),
    );
  }
  return (
    <details className="today-order-settings mt-5">
      <summary className="renewal-link">Порядок блоків на «Сьогодні»</summary>
      <p className="renewal-chart-note mt-2">
        Щоденні дії залишаються першими, фокус-таймер — унизу. Порядок зберігається на цьому
        пристрої.
      </p>
      <ol ref={list} className="today-order-list">
        {order.map((id, index) => {
          const label = TODAY_BLOCKS.find((block) => block.id === id)!.label;
          return (
            <li key={id} data-order-id={id}>
              <span className="today-order-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="today-order-label">{label}</span>
              <button
                type="button"
                className="renewal-secondary"
                aria-label={label + ': вище'}
                data-direction="-1"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="renewal-secondary"
                aria-label={label + ': нижче'}
                data-direction="1"
                disabled={index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="renewal-link"
        disabled={order.join() === DEFAULT_TODAY_ORDER.join()}
        onClick={() => {
          saveTodayOrder(DEFAULT_TODAY_ORDER);
          announce('Початковий порядок відновлено');
        }}
      >
        Відновити початковий порядок
      </button>
      {announcement && (
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      )}
    </details>
  );
}
