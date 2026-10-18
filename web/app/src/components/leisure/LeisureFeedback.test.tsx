import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LeisureFeedback } from './LeisureFeedback.tsx';
import type { LeisureItem, LeisureReceipt } from '../../api/leisure.ts';
const item = { id: 'concert', title: 'Клубний концерт', category: 'concert' } as LeisureItem;
describe('explicit feedback and acknowledgement state', () => {
  it('shows saving immediately, blocks a second submit and closes only after acknowledgement', async () => {
    let resolve!: (r: LeisureReceipt) => void;
    const send = vi.fn(
        () =>
          new Promise<LeisureReceipt>((r) => {
            resolve = r;
          }),
      ),
      done = vi.fn();
    render(<LeisureFeedback item={item} busy={false} send={send} done={done} back={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Не хочу саме цей варіант' }));
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й прибрати' }));
    const button = screen.getByRole('button', { name: 'Зберігаю…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'reaction',
      { verdict: 'uninterested', reasonCode: 'this-option', reason: '' },
      'concert',
    );
    await act(async () => resolve({ message: 'Збережено.' }));
    expect(done).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['Не на цей тиждень', 'time'],
    ['Зараз немає бажання', 'not-now'],
    ['Не для нашого спільного виходу', 'company'],
  ])('keeps %s temporary', async (label, reasonCode) => {
    const send = vi.fn().mockResolvedValue({ message: 'Збережено.' }),
      done = vi.fn();
    render(<LeisureFeedback item={item} busy={false} send={send} done={done} back={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й прибрати' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(
      'reaction',
      { verdict: 'later', reasonCode, reason: '' },
      'concert',
    );
  });
});
