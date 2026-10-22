import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RestaurantCatalog } from './RestaurantCatalog.tsx';
import { readLeisureDemo, resetLeisureDemo } from '../../api/leisure-demo.ts';
import type { LeisureItem } from '../../api/leisure.ts';
import type { LeisureLivePlace } from '../../api/leisure-enrichment.ts';
import type { LeisureFoodQuality } from '../../api/leisure-quality.ts';
const live = vi.hoisted(() => ({ data: null as LeisureFoodQuality | null, fetch: vi.fn() }));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
vi.mock('../../api/leisure-enrichment.ts', async (original) => ({
  ...(await original<typeof import('../../api/leisure-enrichment.ts')>()),
  leisureLiveAvailable: () => true,
}));
vi.mock('../../api/leisure-quality.ts', () => ({
  fetchLeisureFoodQuality: live.fetch,
  useLeisureFoodQuality: () => ({
    data: live.data,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
const place = (rating: number | null, count = 500): LeisureLivePlace => ({
  name: 'Заклад',
  address: null,
  maps_uri: null,
  site: null,
  phone: null,
  rating,
  userRatingCount: count,
  price_range: null,
  priceLevel: null,
  hours: [],
  businessStatus: 'OPERATIONAL',
  movedPlaceId: null,
  amenities: {},
  accessibility: {},
  payment: {},
  parking: {},
  photos: [],
  fetched_at: '2026-10-22T08:00Z',
  extended: false,
});
const response = (entries: LeisureFoodQuality['entries'], total: number): LeisureFoodQuality => ({
  entries,
  catalogTotal: total,
  partial: false,
  checkedAt: '2026-10-22T08:00Z',
  scope: 'verified-catalogue-pool',
});
function item(id: string): LeisureItem {
  const seed = readLeisureDemo().items.find((i) => i.category === 'food')!;
  return { ...seed, id, placeId: 'place-' + id, title: id };
}
beforeEach(() => {
  resetLeisureDemo();
  live.data = null;
  live.fetch.mockReset();
});
function setup(items: LeisureItem[]) {
  const data = readLeisureDemo();
  data.items = items;
  const callbacks = { onOpen: vi.fn(), onChoose: vi.fn(), onVisit: vi.fn(), onExplain: vi.fn() };
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <RestaurantCatalog data={data} items={items} busy={false} {...callbacks} />
    </QueryClientProvider>,
  );
  return { ...callbacks, ...view, data };
}
describe('restaurant catalogue', () => {
  it('shows qualifying venues without manual likes and ranks a robust rating above a tiny perfect score', () => {
    const items = [
      item('Маленька вибірка'),
      item('Достатньо оцінок'),
      item('Нижче порога'),
      item('Точно 4,4'),
    ];
    live.data = response(
      items.map((food, n) => ({
        itemId: food.id,
        place: place([5, 4.7, 4.3, 4.4][n]!, n === 0 ? 8 : 2000),
      })),
      4,
    );
    const { data, onChoose } = setup(items);
    const details = screen.getAllByRole('button', { name: /Деталі:/ });
    expect(details[0]).toHaveAccessibleName('Деталі: Достатньо оцінок');
    expect(screen.getByRole('button', { name: 'Деталі: Точно 4,4' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Деталі: Нижче порога' })).not.toBeInTheDocument();
    const first = within(details[0]!.closest('article')!);
    fireEvent.click(first.getByRole('button', { name: '☆ Насамперед' }));
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'Достатньо оцінок' }),
      'priority',
    );
    expect(data.records).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('keeps missing parking unknown and filters only explicitly confirmed options', () => {
    const foods = [item('Невідомо'), item('Частково'), item('Підтверджено')];
    const entries = foods.map((food) => ({ itemId: food.id, place: place(4.7) }));
    entries[1]!.place.parking = { freeParkingLot: false };
    entries[2]!.place.parking = { paidParkingLot: true };
    live.data = response(entries, 3);
    setup(foods);
    fireEvent.click(screen.getByLabelText('Лише з підтвердженими варіантами паркування'));
    expect(screen.getAllByRole('button', { name: /Деталі:/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Деталі: Підтверджено' })).toBeInTheDocument();
  });
  it('can complete an explicitly requested whole-list check in bounded batches', async () => {
    const foods = Array.from({ length: 6 }, (_, n) => item('Заклад-' + n));
    live.data = response([], 6);
    live.fetch.mockImplementation(async (payload: { ids: string[] }) =>
      response(
        payload.ids.map((id) => ({ itemId: id, place: place(4.8) })),
        6,
      ),
    );
    setup(foods);
    fireEvent.click(screen.getByText('Без перевіреної оцінки · 6'));
    fireEvent.click(screen.getByRole('button', { name: 'Уточнити рейтинг усіх решти · 6' }));
    await waitFor(() => expect(screen.getByText('Оцінки перевірено: 6 із 6')).toBeInTheDocument());
    expect(live.fetch).toHaveBeenCalledTimes(2);
    expect(
      live.fetch.mock.calls.map(([payload]) => (payload as { ids: string[] }).ids.length),
    ).toEqual([4, 2]);
  });
  it('stops further requests when the owner cancels a check', async () => {
    const foods = Array.from({ length: 6 }, (_, n) => item('Заклад-' + n));
    live.data = response([], 6);
    live.fetch.mockImplementation(
      (_payload: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          ),
        ),
    );
    setup(foods);
    fireEvent.click(screen.getByText('Без перевіреної оцінки · 6'));
    fireEvent.click(screen.getByRole('button', { name: 'Уточнити рейтинг усіх решти · 6' }));
    await waitFor(() => expect(live.fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Зупинити перевірку' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Зупинити перевірку' })).not.toBeInTheDocument(),
    );
    expect(live.fetch).toHaveBeenCalledTimes(1);
  });
});
