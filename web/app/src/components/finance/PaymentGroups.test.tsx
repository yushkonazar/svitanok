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
        payment('Soon', 'card-installment', '2026-10-11'),
        payment('Music', 'subscription', '2026-10-12'),
        payment('Closed', 'loan', '2026-10-10', 'done'),
        payment('Paused', 'subscription', '2026-10-10', 'paused'),
      ]}
      onAction={onAction}
      onOpen={onOpen}
    />,
  );
  const installments = screen.getByRole('region', { name: 'Платежі · Розстрочки' });
  expect(
    within(installments)
      .getAllByRole('article')
      .map((node) => node.getAttribute('aria-label')),
  ).toEqual(['Soon', 'Later']);
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
  expect(screen.getByRole('button', { name: 'Попередній платіж · Розстрочки' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Наступний платіж · Розстрочки' })).toBeEnabled();
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
  const rail = screen.getByRole('region', { name: 'Платежі · Розстрочки' });
  Object.defineProperty(rail, 'offsetLeft', { value: 10 });
  Object.defineProperty(rail.children[0], 'offsetLeft', { value: 10 });
  Object.defineProperty(rail.children[1], 'offsetLeft', { value: 302 });
  const scrollTo = vi.fn();
  rail.scrollTo = scrollTo;
  fireEvent.click(screen.getByRole('button', { name: 'Наступний платіж · Розстрочки' }));
  expect(scrollTo).toHaveBeenCalledWith({ left: 292, behavior: expect.any(String) });
  rail.scrollLeft = 292;
  fireEvent.scroll(rail);
  expect(screen.getByText('2 / 2')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Наступний платіж · Розстрочки' })).toBeDisabled();
});
