import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchLeisure, type LeisureWorkspace } from '../../api/leisure.ts';
import { resetLeisureDemo } from '../../api/leisure-demo.ts';
import { LeisureCollection } from './LeisureCollection.tsx';
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
let data: LeisureWorkspace;
beforeEach(async () => {
  resetLeisureDemo();
  data = await fetchLeisure();
  data.items = data.items.slice(0, 2);
  data.records = data.items.map((i) => ({
    id: 'reaction-' + i.id,
    kind: 'reaction',
    itemId: i.id,
    venueId: i.venueId,
    verdict: 'interested',
    reasonCode: null,
    reason: 'Збережене уточнення',
    revision: 1,
    at: data.generatedAt,
  }));
});
describe('personal leisure collection', () => {
  it('keeps legacy likes and their notes when a partial bulk priority update is retried', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ message: 'Збережено' })
      .mockRejectedValueOnce(new Error('Немає зв’язку'))
      .mockResolvedValue({ message: 'Збережено' });
    render(
      <LeisureCollection
        data={data}
        items={data.items}
        busy={false}
        send={send}
        onOpen={() => {}}
        onFeedback={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Обрати кілька' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Усі ·/ }));
    fireEvent.click(screen.getByRole('button', { name: '☆ До пріоритету' }));
    await screen.findByRole('alert');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]).toMatchObject({
      interestLevel: 'priority',
      reason: 'Збережене уточнення',
      revision: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: '☆ До пріоритету' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]![2]).toBe(data.items[1]!.id);
  });
  it('restores a manually postponed card without treating it as a positive rating', async () => {
    data.records = data.records.map((r) =>
      r.kind === 'reaction' ? { ...r, verdict: 'later' } : r,
    );
    const send = vi.fn().mockResolvedValue({ message: 'Повернуто' });
    render(
      <LeisureCollection
        data={data}
        items={data.items}
        busy={false}
        send={send}
        onOpen={() => {}}
        onFeedback={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('Показати у колекції'), { target: { value: 'later' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Повернути до нового' })[0]!);
    expect(send).toHaveBeenCalledWith('reaction', { verdict: 'clear' }, data.items[0]!.id);
  });
});
