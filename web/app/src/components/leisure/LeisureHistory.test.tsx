import { it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { fetchLeisure, type LeisureVisit } from '../../api/leisure.ts';
import { LeisureHistory } from './LeisureHistory.tsx';
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
it('groups visits and exposes a revisit preference without creating another visit', async () => {
  const data = await fetchLeisure(),
    item = data.items[0]!,
    onReturn = vi.fn(),
    onEdit = vi.fn();
  const first: LeisureVisit = {
    id: 'one',
    kind: 'visit',
    revision: 1,
    itemId: item.id,
    venueId: item.venueId,
    title: item.title,
    category: item.category,
    visitedOn: '2026-10-18',
    rating: 'liked',
    reason: 'Свіже враження',
    planId: null,
    legacy: false,
  };
  const second = { ...first, id: 'two', visitedOn: '2026-10-17', reason: 'Попереднє враження' };
  render(
    <LeisureHistory
      data={data}
      items={[item]}
      visits={[first, second]}
      onOpen={() => {}}
      onEdit={onEdit}
      onReturn={onReturn}
    />,
  );
  expect(screen.getAllByRole('heading', { name: item.title })).toHaveLength(1);
  fireEvent.click(screen.getByText('Попередні враження · 1'));
  expect(screen.getByText('Попереднє враження')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Хочу повернутися' }));
  expect(onReturn).toHaveBeenCalledWith(item.id);
  expect(onEdit).not.toHaveBeenCalled();
});
