import { resetLeisureDemo } from '../../api/leisure-demo.ts';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PlanBuilder } from './PlanBuilder.tsx';
import { fetchLeisure, type LeisureReceipt } from '../../api/leisure.ts';
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, openLink: vi.fn(), tg: null }));
describe('planning with temporarily unavailable sources', () => {
  it('saves edited proposal times as a draft before any calendar approval', async () => {
    resetLeisureDemo();
    const data = await fetchLeisure(),
      item = data.items[0]!,
      send = vi.fn().mockResolvedValue({ message: 'Збережено', id: 'draft-one' }),
      done = vi.fn();
    render(
      <PlanBuilder
        data={data}
        seed={{
          title: 'Наш вихід',
          stops: [
            {
              itemId: item.id,
              title: 'Стара назва',
              startAt: '2026-10-22T15:00Z',
              endAt: '2026-10-22T17:00Z',
            },
          ],
        }}
        busy={false}
        send={send}
        done={done}
      />,
    );
    expect(screen.getByText('Каталог оновився')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти чернетку' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(
      'draft',
      expect.objectContaining({ calendar: false, title: 'Наш вихід' }),
      undefined,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('checks calendar and requires explicit manual verification before saving', async () => {
    resetLeisureDemo();
    const data = await fetchLeisure(),
      item = data.items.find((i) => i.category === 'exhibition')!;
    const send = vi.fn(async (op: string): Promise<LeisureReceipt> => {
      if (op === 'source-check') throw new Error('Unavailable');
      if (op === 'calendar-check') return { message: 'Checked', available: true, conflicts: [] };
      return { message: 'Saved', id: 'plan-1' };
    });
    render(<PlanBuilder data={data} initialItem={item} busy={false} send={send} done={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Далі: час і бронювання' }));
    fireEvent.click(screen.getByRole('button', { name: 'Далі: перевірка' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити календар' }));
    await screen.findByText('Умови потрібно звірити');
    expect(send.mock.calls.map((c) => c[0])).toEqual(['source-check', 'calendar-check']);
    const save = screen.getByRole('button', { name: 'Погодити й додати в календар' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Самостійно звірив дату, час і доступність'));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith('plan', expect.any(Object), undefined),
    );
  });
  it('keeps a confirmed server cancellation blocking the plan', async () => {
    resetLeisureDemo();
    const data = await fetchLeisure(),
      item = data.items.find((i) => i.category === 'exhibition')!;
    const send = vi.fn(async (op: string): Promise<LeisureReceipt> => {
      if (op === 'source-check') return { message: 'Cancelled' };
      throw new Error('Один із варіантів недоступний. Перевір склад плану.');
    });
    render(<PlanBuilder data={data} initialItem={item} busy={false} send={send} done={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Далі: час і бронювання' }));
    fireEvent.click(screen.getByRole('button', { name: 'Далі: перевірка' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити календар' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Погодити й додати в календар' })).toBeDisabled();
    expect(
      screen.queryByLabelText('Самостійно звірив дату, час і доступність'),
    ).not.toBeInTheDocument();
  });
});
