import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TripsWorkspace as TripsScreen } from './TripsWorkspace.tsx';
import * as api from '../../api/trips.ts';
import type { TravelSnapshot } from '../../api/trips.ts';

vi.mock('../../api/trips.ts', async (original) => ({
  ...(await original<typeof api>()),
  changeTrip: vi.fn(),
  downloadTrip: vi.fn(),
}));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
let snapshot: TravelSnapshot;
beforeEach(async () => {
  vi.restoreAllMocks();
  snapshot = await api.fetchTrips();
  vi.spyOn(api, 'fetchTrips').mockResolvedValue(snapshot);
  vi.mocked(api.changeTrip).mockReset().mockResolvedValue(snapshot);
});
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={['/trips']}>
      <QueryClientProvider client={cache}>
        <TripsScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('travel companion screen', () => {
  it('shows a changed-price warning without marking the new offer as the previous owner choice', async () => {
    snapshot.current!.research = {
      stale: false,
      revision: 3,
      selections: {},
      selection_warnings: [
        'Житло: попередній вибір збережено, але його умови потребують перевірки.',
      ],
      options: [
        {
          id: 'offer-stay',
          kind: 'stay',
          title: 'Апартаменти',
          source_url: 'https://example.com/stay',
          checked_at: '2026-10-21T13:00:00Z',
          availability: 'page_observed',
          stale: false,
          price: { amount: 600, currency: 'EUR', unit: 'stay', quantity: 1 },
        },
      ],
    };
    vi.mocked(api.fetchTrips).mockResolvedValue(snapshot);
    const user = userEvent.setup();
    mount();
    await screen.findByRole('heading', { name: 'Прага' });
    await user.click(screen.getByRole('button', { name: 'Варіанти' }));
    expect(screen.getByText(/попередній вибір збережено/)).toBeVisible();
    expect(screen.getByText('600 EUR')).toBeVisible();
    expect(screen.queryByText('Обрано', { exact: true })).not.toBeInTheDocument();
  });
  it('keeps weather sharing off until the owner explicitly enables its disclosed switch', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('heading', { name: 'Прага' });
    const toggle = screen.getByRole('checkbox', { name: 'Додавати прогноз погоди' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/OpenWeather отримуватиме координати міста/)).toBeVisible();
    await user.click(toggle);
    expect(api.changeTrip).toHaveBeenCalledWith({
      op: 'weather-consent',
      id: 'demo-prague',
      revision: 1,
      data: { enabled: true },
    });
  });
  it('shows separate transport and lodging parties and changes the actual stage with the current revision', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('heading', { name: 'Прага' });
    expect(screen.getByText('у дорозі')).toHaveTextContent('2');
    expect(screen.getByText('для житла')).toHaveTextContent('4');
    expect(screen.getByText('Europe/Prague')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'На місці' }));
    expect(api.changeTrip).toHaveBeenCalledWith({
      op: 'workspace',
      id: 'demo-prague',
      revision: 1,
      data: { op: 'progress', value: { stage: 'arrived' } },
    });
  });
  it('submits explicit support as one action without a separate partial brief save', async () => {
    const user = userEvent.setup();
    const answers = snapshot.current!.answers;
    snapshot = {
      ok: true,
      items: [
        {
          id: 'draft-prague',
          kind: 'draft',
          title: 'Прага',
          date_from: '2026-11-12',
          date_to: '2026-11-16',
          status: 'draft',
        },
      ],
      current: {
        id: 'draft-prague',
        kind: 'draft',
        revision: 4,
        answers,
        ask: [],
        ready_for_research: true,
      },
    };
    vi.mocked(api.fetchTrips).mockResolvedValue(snapshot);
    vi.mocked(api.changeTrip).mockResolvedValue(snapshot);
    mount();
    await screen.findByRole('heading', { name: 'Прага' });
    await user.click(screen.getByRole('button', { name: 'Увімкнути супровід' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(api.changeTrip).toHaveBeenCalledTimes(1));
    expect(api.changeTrip).toHaveBeenCalledWith({
      op: 'start',
      id: 'draft-prague',
      revision: 4,
      data: { consent: true, support_level: 'companion' },
    });
  });
  it('preserves the open form and blocks repeated writes after an uncertain save until data is refreshed', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('heading', { name: 'Прага' });
    await user.click(screen.getByRole('button', { name: 'Підготовка' }));
    await user.click(screen.getByRole('button', { name: '＋ Справа' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Що зробити'), 'Зберегти маршрут');
    vi.mocked(api.changeTrip).mockRejectedValueOnce(
      new api.TravelChangeError('Не отримав підтвердження зміни.', true),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Зберегти' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Не отримав підтвердження');
    expect(within(dialog).getByLabelText('Що зробити')).toHaveValue('Зберегти маршрут');
    expect(within(dialog).getByRole('button', { name: 'Зберегти' })).toBeDisabled();
    await user.click(
      within(dialog).getByRole('button', { name: 'Оновити й перевірити результат' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.changeTrip).toHaveBeenCalledTimes(1);
  });
});
