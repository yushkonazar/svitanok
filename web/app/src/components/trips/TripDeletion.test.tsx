import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TripsScreen } from './TripsScreen.tsx';
import * as api from '../../api/trips.ts';
import type { TravelSnapshot } from '../../api/trips.ts';

vi.mock('../../api/trips.ts', async (original) => ({
  ...(await original<typeof api>()),
  changeTrip: vi.fn(),
}));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
let state: TravelSnapshot;
const empty = (): TravelSnapshot => ({ ok: true, items: [], current: null });
beforeEach(async () => {
  vi.restoreAllMocks();
  state = await api.fetchTrips();
  vi.spyOn(api, 'fetchTrips').mockImplementation(async () => structuredClone(state));
  vi.mocked(api.changeTrip)
    .mockReset()
    .mockImplementation(async () => {
      state = empty();
      return structuredClone(state);
    });
});
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}
function mount(params = '?id=demo-prague') {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  render(
    <MemoryRouter initialEntries={[`/trips${params}`]}>
      <QueryClientProvider client={cache}>
        <TripsScreen />
        <Location />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return cache;
}

describe('deleting a trip from Mini App', () => {
  it('requires confirmation, leaves a draft when dismissed and deletes it when confirmed', async () => {
    const user = userEvent.setup();
    state = {
      ok: true,
      items: [
        {
          id: 'draft-prague',
          kind: 'draft',
          title: 'Прага',
          date_from: null,
          date_to: null,
          status: 'draft',
        },
      ],
      current: {
        id: 'draft-prague',
        kind: 'draft',
        status: 'draft',
        revision: 7,
        answers: { to: 'Прага' },
      },
    };
    mount('?id=draft-prague');
    await user.click(await screen.findByRole('button', { name: 'Видалити поїздку' }));
    expect(screen.getByRole('dialog', { name: 'Видалення поїздки' })).toHaveTextContent(
      'Видалити «Прага»?',
    );
    expect(api.changeTrip).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Залишити' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Видалити поїздку' }));
    await user.click(screen.getByRole('button', { name: 'Так, видалити' }));
    expect(api.changeTrip).toHaveBeenCalledExactlyOnceWith({
      op: 'delete',
      id: 'draft-prague',
      revision: 7,
      data: { confirm: true, kind: 'draft' },
    });
    expect(await screen.findByText('Поїздку видалено.')).toBeVisible();
    expect(screen.getByLabelText('Місто або місце')).toBeVisible();
    expect(screen.queryByRole('option', { name: /Прага/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location')).toBeEmptyDOMElement());
  });
  it.each(['', '&view=details'])(
    'allows deletion of a cancelled trip in either view (%s)',
    async (view) => {
      const user = userEvent.setup();
      state.current!.status = 'cancelled';
      mount(`?id=demo-prague${view}`);
      await user.click(await screen.findByRole('button', { name: 'Видалити поїздку' }));
      expect(screen.getByRole('dialog')).toHaveTextContent('Супровід припиниться');
      await user.click(screen.getByRole('button', { name: 'Так, видалити' }));
      expect(api.changeTrip).toHaveBeenCalledExactlyOnceWith({
        op: 'delete',
        id: 'demo-prague',
        revision: 1,
        data: { confirm: true, kind: 'trip' },
      });
      expect(await screen.findByText('Поїздку видалено.')).toBeVisible();
      expect(screen.queryByRole('option', { name: /Прага/ })).not.toBeInTheDocument();
    },
  );
  it('blocks repeated taps while deletion is in flight', async () => {
    const user = userEvent.setup();
    let finish!: (value: TravelSnapshot) => void;
    vi.mocked(api.changeTrip).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    await user.click(await screen.findByRole('button', { name: 'Видалити поїздку' }));
    await user.dblClick(screen.getByRole('button', { name: 'Так, видалити' }));
    expect(api.changeTrip).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Видаляю…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Залишити' })).toBeDisabled();
    state = empty();
    finish(state);
    expect(await screen.findByText('Поїздку видалено.')).toBeVisible();
  });
  it('refreshes the list after an uncertain response without repeating deletion', async () => {
    const user = userEvent.setup();
    vi.mocked(api.changeTrip).mockRejectedValueOnce(
      new api.TravelChangeError('Не отримав підтвердження.', true),
    );
    mount();
    await user.click(await screen.findByRole('button', { name: 'Видалити поїздку' }));
    await user.click(screen.getByRole('button', { name: 'Так, видалити' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Не отримав підтвердження');
    expect(within(dialog).queryByRole('button', { name: 'Так, видалити' })).not.toBeInTheDocument();
    state = empty();
    await user.click(within(dialog).getByRole('button', { name: 'Оновити список' }));
    expect(await screen.findByLabelText('Місто або місце')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.changeTrip).toHaveBeenCalledTimes(1);
  });
  it('removes the deleted item from cached lists while retaining other trip details', async () => {
    const user = userEvent.setup();
    const other = { ...state.items[0]!, id: 'other-trip', title: 'Відень' };
    const third = { ...other, id: 'third-trip', title: 'Київ' };
    state.items.push(other, third);
    const cache = mount();
    cache.setQueryData(['trips', 'third-trip'], {
      ...state,
      current: { ...state.current!, id: third.id, answers: { to: third.title } },
    });
    vi.mocked(api.changeTrip).mockImplementationOnce(async () => {
      state = {
        ...state,
        items: [other, third],
        current: { ...state.current!, id: other.id, answers: { to: other.title } },
      };
      return structuredClone(state);
    });
    await user.click(await screen.findByRole('button', { name: 'Видалити поїздку' }));
    await user.click(screen.getByRole('button', { name: 'Так, видалити' }));
    expect(await screen.findByRole('heading', { name: 'Відень' })).toBeVisible();
    const cached = cache.getQueryData<TravelSnapshot>(['trips', 'third-trip']);
    expect(cached?.current?.answers.to).toBe('Київ');
    expect(cached?.items.map((item) => item.id)).toEqual(['other-trip', 'third-trip']);
    expect(screen.getByTestId('location')).toHaveTextContent('id=other-trip');
  });
  it('recovers a confirmed deletion even when the server cannot return a fresh snapshot', async () => {
    const user = userEvent.setup();
    vi.mocked(api.changeTrip).mockImplementationOnce(async () => {
      state = empty();
      return null;
    });
    mount();
    await user.click(await screen.findByRole('button', { name: 'Видалити поїздку' }));
    await user.click(screen.getByRole('button', { name: 'Так, видалити' }));
    await user.click(await screen.findByRole('button', { name: 'Оновити й перевірити результат' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Оновити й перевірити результат' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Місто або місце')).toBeVisible();
    expect(screen.queryByRole('option', { name: /Прага/ })).not.toBeInTheDocument();
    expect(api.changeTrip).toHaveBeenCalledTimes(1);
  });
});
