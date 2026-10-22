import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TripsScreen } from './TripsScreen.tsx';
import * as api from '../../api/trips.ts';
import type { TravelSnapshot, TravelCurrent } from '../../api/trips.ts';

vi.mock('../../api/trips.ts', async (original) => ({
  ...(await original<typeof api>()),
  changeTrip: vi.fn(),
  downloadTrip: vi.fn(),
}));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
type Guide = NonNullable<TravelCurrent['planning']>;
let state: TravelSnapshot;
const countQuestion: NonNullable<Guide['question']> = {
  field: 'destination_count',
  section: 'Учасники',
  question: 'А скільки вас буде загалом на місці?',
  type: 'number',
  custom: true,
  choices: [
    { value: 2, label: 'Стільки ж — 2' },
    { value: 4, label: 'Четверо' },
  ],
  optional: false,
  hint: 'Для дороги й житла зберігаю окремий склад групи.',
};
const option = (kind: string, id = 'offer-one') => ({
  id,
  kind,
  title:
    kind === 'transport'
      ? 'Вечірній автобус'
      : kind === 'stay'
        ? 'Апартаменти на чотирьох'
        : id === 'offer-one'
          ? 'Музей'
          : 'Кав’ярня',
  source_url: `https://example.com/${id}`,
  checked_at: '2026-10-22T10:00:00Z',
  stale: false,
  availability: 'unverified',
  price: null,
});
function guide(over: Partial<Guide> = {}): Guide {
  return {
    revision: 2,
    brief_revision: 7,
    remaining: 1,
    confirmed: false,
    step: 'questions',
    question: countQuestion,
    fields: [countQuestion],
    providers: [],
    stages: ['transport', 'stay', 'activity'].map((kind) => ({
      kind,
      status: 'idle',
      summary: '',
      started_at: null,
      options: [],
      decision: null,
      resolved: false,
      needs_review: false,
    })),
    ...over,
  };
}
function draft(planning = guide()) {
  state = {
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
      revision: 7,
      answers: {
        to: 'Прага',
        from_city: 'Львів',
        mode: 'bus',
        date_from: '2026-11-12',
        date_to: '2026-11-16',
        transport_count: 2,
        support_level: 'plan',
      },
      planning,
    },
  };
}
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={['/trips']}>
      <QueryClientProvider client={cache}>
        <TripsScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
beforeEach(async () => {
  vi.restoreAllMocks();
  state = await api.fetchTrips();
  vi.spyOn(api, 'fetchTrips').mockImplementation(async () => structuredClone(state));
  vi.mocked(api.changeTrip)
    .mockReset()
    .mockImplementation(async () => structuredClone(state));
});

describe('guided travel journey', () => {
  it('starts with destination only, then keeps transport and destination parties separate using buttons', async () => {
    const user = userEvent.setup();
    state = { ok: true, items: [], current: null };
    vi.mocked(api.changeTrip).mockImplementation(async (command) => {
      draft();
      if (command.data?.destination_count) {
        state.current!.answers.destination_count = command.data.destination_count;
        state.current!.planning = guide({ question: null, remaining: 0, step: 'review' });
      }
      return structuredClone(state);
    });
    mount();
    await user.type(await screen.findByLabelText('Місто або місце'), 'Прага');
    await user.click(screen.getByRole('button', { name: 'Почати планування →' }));
    expect(api.changeTrip).toHaveBeenNthCalledWith(1, { op: 'brief', data: { to: 'Прага' } });
    await user.click(await screen.findByRole('button', { name: 'Четверо' }));
    expect(api.changeTrip).toHaveBeenNthCalledWith(2, {
      op: 'brief',
      id: 'draft-prague',
      revision: 7,
      data: { destination_count: 4 },
    });
    expect(await screen.findByRole('heading', { name: 'Перевіримо задум' })).toBeVisible();
    expect(screen.getByText('2 у дорозі')).toBeVisible();
    expect(screen.getByText('4 на місці')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Автобус →' })).not.toBeInTheDocument();
  });
  it('supports a custom answer and keeps it after an uncertain write until refresh', async () => {
    const user = userEvent.setup();
    draft();
    vi.mocked(api.changeTrip).mockRejectedValueOnce(
      new api.TravelChangeError('Не отримав підтвердження зміни.', true),
    );
    mount();
    await user.click(await screen.findByRole('button', { name: 'Вписати свій варіант' }));
    await user.type(screen.getByLabelText('Свій варіант'), '7');
    await user.click(screen.getByRole('button', { name: 'Далі →' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не отримав підтвердження');
    expect(screen.getByLabelText('Свій варіант')).toHaveValue(7);
    expect(screen.getByRole('button', { name: 'Далі →' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Оновити й перевірити результат' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Далі →' })).toBeEnabled());
    expect(api.changeTrip).toHaveBeenCalledTimes(1);
  });
  it('lets optional details be deferred and explicitly starts research after reviewing the brief', async () => {
    const user = userEvent.setup();
    draft(
      guide({ question: { ...countQuestion, field: 'interests', type: 'text', optional: true } }),
    );
    vi.mocked(api.changeTrip).mockImplementation(async (command) => {
      state.current!.planning =
        command.op === 'brief'
          ? guide({ question: null, remaining: 0, step: 'review' })
          : guide({
              confirmed: true,
              question: null,
              remaining: 0,
              step: 'transport',
              stages: guide().stages.map((s) => ({
                ...s,
                status: s.kind === 'transport' ? 'running' : 'idle',
              })),
            });
      return structuredClone(state);
    });
    mount();
    await user.click(await screen.findByRole('button', { name: 'Додам пізніше' }));
    expect(api.changeTrip).toHaveBeenLastCalledWith({
      op: 'brief',
      id: 'draft-prague',
      revision: 7,
      skip_field: 'interests',
      data: {},
    });
    await user.click(
      await screen.findByRole('button', { name: 'Підтвердити й знайти транспорт →' }),
    );
    expect(api.changeTrip).toHaveBeenLastCalledWith({
      op: 'planning',
      id: 'draft-prague',
      revision: 2,
      data: { action: 'confirm', start_search: true },
    });
    expect(await screen.findByText('Підбираю варіанти й перевіряю джерела')).toBeVisible();
    expect(
      within(screen.getByRole('navigation', { name: 'Кроки планування' })).getByRole('button', {
        name: /Житло/,
      }),
    ).toBeDisabled();
  });
  it('shows sourced offers with unknown prices and advances to lodging after an owner choice', async () => {
    const user = userEvent.setup();
    const stages = guide().stages;
    stages[0] = { ...stages[0], status: 'completed', options: [option('transport')] };
    draft(guide({ confirmed: true, question: null, remaining: 0, step: 'transport', stages }));
    vi.mocked(api.changeTrip).mockImplementation(async () => {
      state.current!.planning!.step = 'stay';
      state.current!.planning!.stages[0].resolved = true;
      return structuredClone(state);
    });
    mount();
    expect(await screen.findByText('Ціну не підтверджено')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Переглянути джерело ↗' })).toHaveAttribute(
      'href',
      'https://example.com/offer-one',
    );
    await user.click(screen.getByRole('button', { name: 'Обрати й далі →' }));
    expect(api.changeTrip).toHaveBeenCalledWith({
      op: 'planning',
      id: 'draft-prague',
      revision: 2,
      data: {
        action: 'decision',
        kind: 'transport',
        mode: 'selected',
        ids: ['offer-one'],
        note: '',
      },
    });
    expect(await screen.findByRole('heading', { name: 'Тепер — де зупинитися' })).toBeVisible();
  });
  it('collects several activities before committing a single owner selection', async () => {
    const user = userEvent.setup();
    const stages = guide().stages.map((s, i) => ({ ...s, resolved: i < 2 }));
    stages[2] = {
      ...stages[2],
      status: 'completed',
      options: [option('activity'), option('activity', 'offer-two')],
    };
    draft(guide({ confirmed: true, remaining: 0, question: null, step: 'activity', stages }));
    mount();
    const buttons = await screen.findAllByRole('button', { name: '＋ До плану' });
    await user.click(buttons[0]);
    await user.click(buttons[1]);
    expect(api.changeTrip).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Зберегти 2 місць і продовжити →' }));
    expect(api.changeTrip).toHaveBeenCalledWith({
      op: 'planning',
      id: 'draft-prague',
      revision: 2,
      data: {
        action: 'decision',
        kind: 'activity',
        mode: 'selected',
        ids: ['offer-one', 'offer-two'],
        note: '',
      },
    });
  });
  it('shows a retryable timeout and lets an existing stay be recorded without an unnecessary search', async () => {
    const user = userEvent.setup();
    const stages = guide().stages;
    stages[0].resolved = true;
    stages[1].status = 'timed_out';
    draft(guide({ confirmed: true, question: null, remaining: 0, step: 'stay', stages }));
    state.current!.answers.lodging_needed = 'no';
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('не встиг завершитися');
    await user.click(screen.getByRole('button', { name: 'Житло вже є / не потрібне — далі →' }));
    expect(api.changeTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'planning',
        data: expect.objectContaining({ kind: 'stay', mode: 'manual' }),
      }),
    );
  });
  it('browses lifecycle stages without claiming arrival, and confirms departure explicitly', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('heading', { name: 'Усе важливе — під рукою' });
    await user.click(
      within(screen.getByRole('navigation', { name: 'Етапи подорожі' })).getByRole('button', {
        name: /На місці/,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Подорож у твоєму темпі' })).toBeVisible();
    expect(api.changeTrip).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('navigation', { name: 'Етапи подорожі' })).getByRole('button', {
        name: /Підготовка/,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Ми вирушили →' }));
    expect(api.changeTrip).toHaveBeenCalledWith({
      op: 'workspace',
      id: 'demo-prague',
      revision: 1,
      data: { op: 'progress', value: { stage: 'departed' } },
    });
  });
  it('adds and checks packing items with stable record identity and workspace revision', async () => {
    const user = userEvent.setup();
    state.current!.workspace!.tasks = [
      { id: 'pack-phone', title: 'Павербанк', status: 'open', group: 'packing' },
    ];
    mount();
    await user.click(await screen.findByRole('button', { name: /Речі/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Павербанк' }));
    expect(api.changeTrip).toHaveBeenLastCalledWith({
      op: 'workspace',
      id: 'demo-prague',
      revision: 1,
      data: { op: 'task', value: { id: 'pack-phone', status: 'done' } },
    });
    await user.type(screen.getByLabelText('Додати свою річ'), 'Навушники');
    await user.click(screen.getByRole('button', { name: '＋ Додати' }));
    expect(api.changeTrip).toHaveBeenLastCalledWith({
      op: 'workspace',
      id: 'demo-prague',
      revision: 1,
      data: {
        op: 'task',
        value: { id: expect.any(String), title: 'Навушники', group: 'packing', status: 'open' },
      },
    });
  });
  it('opens preparation only after the explicit start action and uses the chosen support level', async () => {
    const user = userEvent.setup();
    const stages = guide().stages.map((s) => ({
      ...s,
      resolved: true,
      decision: { mode: 'later', note: '', options: [] },
    }));
    draft(guide({ confirmed: true, question: null, remaining: 0, step: 'ready', stages }));
    mount();
    await user.click(await screen.findByRole('button', { name: 'Перейти до підготовки →' }));
    expect(api.changeTrip).toHaveBeenCalledWith({
      op: 'start',
      id: 'draft-prague',
      revision: 7,
      data: { consent: true, support_level: 'plan' },
    });
  });
  it('keeps the old workspace accessible as a secondary view', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'Усі деталі подорожі ↗' }));
    expect(
      await screen.findByRole('button', { name: '← До подорожі крок за кроком' }),
    ).toBeVisible();
    expect(
      within(screen.getByRole('navigation', { name: 'Розділи поїздки' })).getByRole('button', {
        name: 'Витрати',
      }),
    ).toBeVisible();
  });
});
