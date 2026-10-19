import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LeisureFeedback } from './LeisureFeedback.tsx';
import type { LeisureItem, LeisureReceipt } from '../../api/leisure.ts';
const item = { id: 'concert', title: 'Клубний концерт', category: 'concert' } as LeisureItem;
beforeEach(() => sessionStorage.clear());
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
    fireEvent.click(screen.getByRole('button', { name: 'Не хочу саме цей концерт' }));
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й прибрати' }));
    const button = screen.getByRole('button', { name: 'Зберігаю…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'reaction',
      expect.objectContaining({
        verdict: 'uninterested',
        reasonCodes: ['this-option'],
        reason: '',
      }),
      'concert',
    );
    await act(async () => resolve({ message: 'Збережено.' }));
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('keeps manual postponement neutral with no implicit expiry', async () => {
    const send = vi.fn().mockResolvedValue({ message: 'Збережено.' }),
      done = vi.fn();
    render(<LeisureFeedback item={item} busy={false} send={send} done={done} back={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Відкласти' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Відкласти' }).at(-1)!);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(
      'reaction',
      expect.objectContaining({
        verdict: 'later',
        reasonCodes: ['not-now'],
        snoozeUntil: null,
        reason: '',
      }),
      'concert',
    );
  });
  it('requires a level and retains positive reasons and note after a failed save', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Немає зв’язку')),
      done = vi.fn();
    const view = render(
      <LeisureFeedback positive item={item} busy={false} send={send} done={done} back={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Зберегти вибір' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Хочу насамперед/ }));
    for (const name of ['Виконавець', 'Живий звук', 'Програма'])
      fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByRole('button', { name: 'Атмосфера' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Що для тебе важливо?'), {
      target: { value: 'Хочу послухати наживо' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти вибір' }));
    await screen.findByRole('alert');
    expect(done).not.toHaveBeenCalled();
    view.unmount();
    render(
      <LeisureFeedback positive item={item} busy={false} send={send} done={done} back={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /Хочу насамперед/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Що для тебе важливо?')).toHaveValue('Хочу послухати наживо');
    expect(send).toHaveBeenCalledWith(
      'reaction',
      expect.objectContaining({
        interestLevel: 'priority',
        reasonCodes: ['artist', 'live', 'program'],
      }),
      'concert',
    );
  });
  it('offers category-specific reasons and sends already-seen choices to the review form', () => {
    const seen = vi.fn(),
      send = vi.fn();
    render(
      <LeisureFeedback
        item={{ ...item, category: 'trip' }}
        busy={false}
        send={send}
        done={() => {}}
        back={() => {}}
        onSeen={seen}
      />,
    );
    expect(screen.queryByRole('button', { name: /жанр/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Уже були' }));
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й прибрати' }));
    expect(seen).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
