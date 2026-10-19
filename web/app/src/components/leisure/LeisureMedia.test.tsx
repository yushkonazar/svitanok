import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeisureMedia } from './LeisureMedia.tsx';
import { PlaceInfo, ContentInfo } from './PlaceInfo.tsx';
import { readLeisureDemo } from '../../api/leisure-demo.ts';
import type { LeisureItem } from '../../api/leisure.ts';
vi.mock('../../telegram.ts', () => ({
  tg: { initData: 'test-session' },
  inTelegram: () => true,
  openLink: vi.fn(),
}));
const place = {
  name: 'Кав’ярня',
  address: 'Львів',
  maps_uri: 'https://maps.google.com/?cid=1',
  site: 'https://cafe.example/menu',
  phone: '+38012345',
  rating: 4.7,
  userRatingCount: 28,
  price_range: {
    startPrice: { currencyCode: 'UAH', units: '300' },
    endPrice: { currencyCode: 'UAH', units: '600' },
  },
  priceLevel: null,
  hours: ['Четвер: 10:00–22:00'],
  businessStatus: 'OPERATIONAL',
  movedPlaceId: null,
  amenities: {},
  accessibility: {},
  payment: {},
  parking: {},
  photos: [
    {
      name: 'places/p/photos/one',
      authors: [{ name: 'Фотоавтор', url: 'https://maps.google.com/contrib/1' }],
    },
    { name: 'places/p/photos/two', authors: [] },
  ],
  fetched_at: '2026-10-19T08:00:00Z',
  extended: false,
};
const create = vi.fn(() => 'blob:private-photo'),
  revoke = vi.fn();
const originalCreate = URL.createObjectURL,
  originalRevoke = URL.revokeObjectURL;
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  create.mockClear();
  revoke.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke });
});
function setup() {
  const item = { ...readLeisureDemo().items.find((i) => i.category === 'food')!, placeId: 'p' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    if (body.op === 'image')
      return Promise.resolve(new Response('image', { headers: { 'content-type': 'image/jpeg' } }));
    const enriched = {
      ...place,
      ...(body.payload.extended
        ? {
            extended: true,
            amenities: { outdoorSeating: true, liveMusic: false },
            payment: { acceptsNfc: true },
          }
        : {}),
    };
    return Promise.resolve(
      new Response(JSON.stringify({ enrichment: { itemId: item.id, place: enriched } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return { item, client, calls, fetch };
}
describe('actual leisure images and facts', () => {
  it('shares the same photo between the active card and its open details, then collects it', async () => {
    const { item, client, calls } = setup();
    const view = render(
      <QueryClientProvider client={client}>
        <LeisureMedia item={item} active />
        <LeisureMedia item={item} variant="detail" />
      </QueryClientProvider>,
    );
    expect(screen.getAllByText('Завантажуємо фото…')).toHaveLength(2);
    await waitFor(() =>
      expect(screen.getAllByAltText(`Фото місця «${item.title}»`)).toHaveLength(2),
    );
    expect(calls.filter((call) => call.op === 'enrich')).toHaveLength(1);
    expect(calls.filter((call) => call.op === 'image')).toHaveLength(1);
    view.rerender(
      <QueryClientProvider client={client}>
        <LeisureMedia item={item} active />
      </QueryClientProvider>,
    );
    expect(calls.filter((call) => call.op === 'image')).toHaveLength(1);
    view.unmount();
    await waitFor(() =>
      expect(client.getQueryCache().findAll({ queryKey: ['leisure-image'] })).toHaveLength(0),
    );
    expect(revoke).toHaveBeenCalledTimes(2);
  });
  it('shows a failed photo and lets the user retry without reopening the card', async () => {
    const { item, client, fetch, calls } = setup();
    const original = fetch.getMockImplementation()!;
    let failed = false;
    fetch.mockImplementation((url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.op === 'image' && !failed) {
        failed = true;
        calls.push(body);
        return Promise.resolve(new Response('Unavailable', { status: 503 }));
      }
      return original(url, init);
    });
    render(
      <QueryClientProvider client={client}>
        <LeisureMedia item={item} variant="detail" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Фото зараз недоступне')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    const photo = await screen.findByAltText(`Фото місця «${item.title}»`);
    fireEvent.load(photo);
    expect(screen.queryByText('Фото зараз недоступне')).not.toBeInTheDocument();
    expect(calls.filter((call) => call.op === 'image')).toHaveLength(2);
  });
  it('shares a live details request, displays authors, loads one photo at a time and revokes object URLs', async () => {
    const { item, client, calls } = setup();
    const view = render(
      <QueryClientProvider client={client}>
        <LeisureMedia item={item} variant="detail" />
        <PlaceInfo item={item} now={place.fetched_at} />
      </QueryClientProvider>,
    );
    const photo = await screen.findByAltText(`Фото місця «${item.title}»`);
    fireEvent.load(photo);
    expect(await screen.findByRole('link', { name: 'Фотоавтор' })).toHaveAttribute(
      'href',
      'https://maps.google.com/contrib/1',
    );
    expect(calls.filter((c) => c.op === 'enrich')).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'image')).toHaveLength(1);
    expect(screen.getByText('★ 4.7')).toBeInTheDocument();
    expect(screen.getByText('28 оцінок')).toBeInTheDocument();
    expect(screen.getByText(/Приблизно на двох: 600/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Наступне фото' }));
    await waitFor(() => expect(calls.filter((c) => c.op === 'image')).toHaveLength(2));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(revoke).toHaveBeenCalledWith('blob:private-photo');
    view.unmount();
    expect(revoke).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(client.getQueryCache().findAll({ queryKey: ['leisure-live'] })).toHaveLength(0),
    );
  });
  it('requests extended amenities only after choosing them and never treats an absent field as false', async () => {
    const { item, client, calls } = setup();
    render(
      <QueryClientProvider client={client}>
        <PlaceInfo item={item} now={place.fetched_at} />
      </QueryClientProvider>,
    );
    const button = await screen.findByRole('button', {
      name: 'Уточнити зручності, оплату й паркування',
    });
    expect(calls).toHaveLength(1);
    expect(screen.queryByText('Тераса')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText('Тераса')).toBeInTheDocument();
    expect(screen.getByText('Безконтактна оплата')).toBeInTheDocument();
    expect(screen.queryByText('Жива музика')).not.toBeInTheDocument();
    expect(calls[1]?.payload.extended).toBe(true);
  });
  it('retains the honest illustration fallback when the photo endpoint fails', async () => {
    const { item, client, fetch } = setup();
    fetch.mockImplementation((_url: string, init: RequestInit) =>
      JSON.parse(String(init.body)).op === 'image'
        ? Promise.resolve(new Response('unavailable', { status: 503 }))
        : Promise.resolve(new Response(JSON.stringify({ enrichment: { itemId: item.id, place } }))),
    );
    render(
      <QueryClientProvider client={client}>
        <LeisureMedia item={item} variant="detail" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Фото зараз недоступне')).toBeInTheDocument();
    expect(screen.getByAltText('Ілюстрація категорії «Заклади»')).toBeInTheDocument();
    expect(screen.queryByText('Фотоавтор')).not.toBeInTheDocument();
  });
  it('shows recurrence, conditional prices and uncertainty without presenting a group workshop as a confirmed event', () => {
    const item = {
      ...readLeisureDemo().items[0]!,
      schedule: {
        kind: 'on-request',
        precision: 'date',
        weekdays: [],
        startTime: null,
        endTime: null,
        validFrom: null,
        validThrough: null,
        excludedDates: [],
        occurrences: [],
        confirmationRequired: true,
        minParticipants: 5,
      },
      qualityWarnings: ['Потрібно уточнити групу'],
      priceOffers: [
        {
          min: 150,
          max: 150,
          currency: 'UAH',
          eligibility: 'Лише для студентів',
          note: 'Потрібен студентський квиток',
        },
      ],
    } as LeisureItem;
    render(<ContentInfo item={item} />);
    expect(screen.getByText('Потрібне уточнення')).toBeInTheDocument();
    expect(screen.getByText(/Час для двох потрібно підтвердити/)).toBeInTheDocument();
    expect(screen.getByText('Лише для студентів')).toBeInTheDocument();
  });
});
