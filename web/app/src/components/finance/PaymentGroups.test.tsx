import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PaymentGroups } from './PaymentGroups.tsx';
import { readFinanceDemo } from '../../api/finance-demo.ts';
import type { Finance } from '../../api/finance-schema.ts';
afterEach(cleanup);
const base = readFinanceDemo().payments[0];
function payment(
  id: string,
  kind: Finance['payments'][number]['kind'],
  nextDate: string,
  status = 'active',
) {
  return { ...base, id, name: id, kind, nextDate, status };
}
it('groups active payment types, sorts each rail by due date and keeps payment actions bound to the correct record', () => {
  const onAction = vi.fn(),
    onOpen = vi.fn();
  render(
    <PaymentGroups
      payments={[
        payment('Later', 'installment', '2026-10-20'),
        payment('Soon', 'installment', '2026-10-11'),
        payment('Card', 'card-installment', '2026-10-10'),
        payment('Music', 'subscription', '2026-10-12'),
        payment('Closed', 'loan', '2026-10-10', 'done'),
        payment('Paused', 'subscription', '2026-10-10', 'paused'),
      ]}
      onAction={onAction}
      onOpen={onOpen}
    />,
  );
  const installments = screen.getByRole('region', { name: 'Платежі · Оплата частинами' });
  expect(
    within(installments)
      .getAllByRole('article')
      .map((node) => node.getAttribute('aria-label')),
  ).toEqual(['Soon', 'Later']);
  expect(
    within(screen.getByRole('region', { name: 'Платежі · Розстрочки на картку' }))
      .getAllByRole('article')
      .map((node) => node.getAttribute('aria-label')),
  ).toEqual(['Card']);
  expect(
    within(screen.getByRole('region', { name: 'Платежі · Підписки' })).getAllByRole('article'),
  ).toHaveLength(1);
  expect(screen.queryByText('Closed')).not.toBeInTheDocument();
  expect(screen.queryByText('Paused')).not.toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole('article', { name: 'Soon' })).getByRole('button', {
      name: 'Підтвердити оплату',
    }),
  );
  expect(onAction).toHaveBeenCalledWith({ kind: 'payment-paid', id: 'Soon' });
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(onOpen).toHaveBeenCalledWith('Later');
  expect(
    screen.getByRole('button', { name: 'Попередній платіж · Оплата частинами' }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Наступний платіж · Оплата частинами' })).toBeEnabled();
});
it('moves only the horizontal rail and updates the position after scrolling', () => {
  render(
    <PaymentGroups
      payments={[
        payment('First', 'installment', '2026-10-11'),
        payment('Second', 'installment', '2026-10-12'),
      ]}
      onAction={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  const rail = screen.getByRole('region', { name: 'Платежі · Оплата частинами' });
  Object.defineProperty(rail, 'clientWidth', { value: 312 });
  Object.defineProperty(rail.children[0], 'offsetLeft', { value: 0 });
  Object.defineProperty(rail.children[1], 'offsetLeft', { value: 324 });
  for (const card of rail.children) Object.defineProperty(card, 'offsetWidth', { value: 312 });
  const scrollTo = vi.fn();
  rail.scrollTo = scrollTo;
  fireEvent.click(screen.getByRole('button', { name: 'Наступний платіж · Оплата частинами' }));
  expect(scrollTo).toHaveBeenCalledWith({ left: 324, behavior: expect.any(String) });
  rail.scrollLeft = 324;
  fireEvent.scroll(rail);
  expect(screen.getByText('2 / 2')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Наступний платіж · Оплата частинами' }),
  ).toBeDisabled();
  fireEvent.keyDown(rail, { key: 'Home' });
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: expect.any(String) });
});

it('reorders a paid record by its new due date, removes a closed debt and preserves reading position on unchanged polling', () => {
  const first = payment('First', 'installment', '2026-10-11');
  const second = payment('Second', 'installment', '2026-10-12');
  const callbacks = { onAction: vi.fn(), onOpen: vi.fn() };
  const { rerender } = render(<PaymentGroups payments={[first, second]} {...callbacks} />);
  const rail = screen.getByRole('region', { name: 'Платежі · Оплата частинами' });
  const scrollTo = vi.fn();
  rail.scrollTo = scrollTo;
  rerender(<PaymentGroups payments={[{ ...first }, { ...second }]} {...callbacks} />);
  expect(scrollTo).not.toHaveBeenCalled();
  rerender(
    <PaymentGroups payments={[{ ...first, nextDate: '2026-11-11' }, second]} {...callbacks} />,
  );
  expect(
    within(rail)
      .getAllByRole('article')
      .map((node) => node.getAttribute('aria-label')),
  ).toEqual(['Second', 'First']);
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'instant' });
  rerender(<PaymentGroups payments={[{ ...first, status: 'done' }, second]} {...callbacks} />);
  expect(
    within(rail)
      .getAllByRole('article')
      .map((node) => node.getAttribute('aria-label')),
  ).toEqual(['Second']);
  expect(
    screen.queryByRole('button', { name: 'Наступний платіж · Оплата частинами' }),
  ).not.toBeInTheDocument();
});
