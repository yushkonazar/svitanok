import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PlanScreen } from './PlanScreen.tsx';
import { changePlan, fetchPlan } from '../../api/plan.ts';
import { resetPlanDemo } from '../../api/plan-demo.ts';
import { normalizePlanClock } from './PlanLocalTime.tsx';

const calls = vi.hoisted(() => ({ suggest: vi.fn() }));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null, haptic: vi.fn() }));
vi.mock('../../api/plan.ts', async (original) => ({
  ...(await original<object>()),
  suggestPlanTask: calls.suggest,
}));
const NOW = Date.parse('2026-10-17T08:19:00Z');
const draft = {
  title: 'Прокинутися та виїхати на роботу',
  criterion: 'Прокинутися о 7:00 і виїхати між 7:20 та 7:30',
  target: 1,
  unit: 'ранок',
  area: 'work',
  effort: 0,
  contribution: 1,
  challenge: 1,
  routine: true,
  estimateMinutes: 30,
  firstStep: 'Поставити будильник на 7:00',
  dueTime: '07:30',
  startTime: '07:00',
  timeSensitive: true,
  source: null,
  questions: [],
  xp: 35,
};
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/plan']}>
        <PlanScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, user: userEvent.setup() };
}
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  resetPlanDemo();
  calls.suggest.mockReset().mockResolvedValue(draft);
  await changePlan({
    op: 'settings',
    payload: { enabled: true, penaltyPercent: 50 },
    commandId: crypto.randomUUID(),
    revision: 0,
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function openAndFill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Додати першу задачу' }));
  await user.click(screen.getByText('Допомогти заповнити з мого опису ✧'));
  await user.type(
    screen.getByLabelText('Опиши одну задачу'),
    'Прокинутись о 7:00, виїхати на роботу о 7:20–7:30',
  );
  await user.click(screen.getByRole('button', { name: 'Заповнити форму' }));
  await waitFor(() => expect(screen.getByLabelText('Що хочу зробити')).toHaveValue(draft.title));
}
function clock(label: string, value: string) {
  const input = screen.getByLabelText(label + ': час');
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('the reported morning-task failure', () => {
  it('clears a stale calendar endpoint, moves the morning to tomorrow, saves a template and accepts it', async () => {
    const { user } = setup();
    await openAndFill(user);
    expect(screen.getByLabelText('Крайній час · Київ: час')).toHaveValue('07:30');
    expect(screen.getByText(/Крайній час цього дня вже минув/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /На завтра/ }));
    expect(screen.getByLabelText('День задачі')).toHaveValue('2026-10-18');
    expect(screen.getByLabelText('Запланований початок · Київ: дата')).toHaveValue('2026-10-18');
    await user.click(screen.getByLabelText('Додати цей блок у Google Calendar після прийняття'));
    clock('Кінець блоку · Київ', '08:00');
    await user.click(screen.getByLabelText('Додати цей блок у Google Calendar після прийняття'));
    expect(screen.queryByLabelText('Кінець блоку · Київ: час')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Зберегти як шаблон'));
    await user.click(screen.getByRole('button', { name: 'Зберегти в чернетку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const saved = await fetchPlan();
    expect(localStorage.getItem('svitanok:plan:task-draft:v1:2026-10-17')).toBeNull();
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0]).toMatchObject({
      date: '2026-10-18',
      startAt: '2026-10-18T04:00:00.000Z',
      dueAt: '2026-10-18T04:30:00.000Z',
      endAt: null,
      calendar: false,
      xp: 35,
      estimateMinutes: 30,
    });
    expect(saved.templates).toHaveLength(1);
    expect(screen.getByRole('heading', { name: draft.title })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Прийняти план' }));
    await user.click(screen.getByRole('button', { name: 'Приймаю цей план' }));
    await waitFor(async () => expect((await fetchPlan()).tasks[0]!.status).toBe('accepted'));
  });
  it('explains the exact invalid endpoint beside the field, keeps all text and allows correcting it', async () => {
    const { user } = setup();
    await openAndFill(user);
    await user.click(screen.getByRole('button', { name: /На завтра/ }));
    await user.click(screen.getByLabelText('Додати цей блок у Google Calendar після прийняття'));
    clock('Кінець блоку · Київ', '08:00');
    await user.click(screen.getByRole('button', { name: 'Зберегти в чернетку' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Блок закінчується після крайнього строку',
    );
    expect(screen.getByLabelText('Кінець блоку · Київ: час')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('Що хочу зробити')).toHaveValue(draft.title);
    expect((await fetchPlan()).tasks).toHaveLength(0);
    clock('Кінець блоку · Київ', '0730');
    await user.click(screen.getByRole('button', { name: 'Зберегти в чернетку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((await fetchPlan()).tasks[0]).toMatchObject({
      calendar: true,
      endAt: '2026-10-18T04:30:00.000Z',
    });
  });
  it('drops the prior calendar settings on a second AI fill instead of carrying hidden state', async () => {
    const { user } = setup();
    await openAndFill(user);
    await user.click(screen.getByLabelText('Додати цей блок у Google Calendar після прийняття'));
    clock('Кінець блоку · Київ', '08:00');
    await user.click(screen.getByRole('button', { name: 'Заповнити форму' }));
    await waitFor(() => expect(calls.suggest).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByLabelText('Додати цей блок у Google Calendar після прийняття'),
      ).not.toBeChecked(),
    );
    expect(screen.queryByLabelText('Кінець блоку · Київ: час')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /На завтра/ }));
    await user.click(screen.getByRole('button', { name: 'Зберегти в чернетку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('distinguishes a personal 20 XP choice from the live 35 XP recommendation and restores automatic scoring', async () => {
    const { user } = setup();
    await openAndFill(user);
    expect(screen.getByText(/Рекомендація: 35 XP · Значущий результат/)).toBeInTheDocument();
    await user.click(screen.getByText('Уточнити оцінку'));
    await user.selectOptions(screen.getByLabelText('Обрана категорія XP'), '20');
    expect(screen.getByText(/Твій вибір: 20 XP/)).toBeInTheDocument();
    expect(screen.getByText('+20 XP')).toBeInTheDocument();
    expect(screen.getByText('−10 XP')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Зусилля'), '1');
    expect(screen.getByText('+20 XP')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Застосувати рекомендацію/ }));
    expect(screen.queryByText(/Твій вибір/)).not.toBeInTheDocument();
    expect(screen.getByText('+50 XP')).toBeInTheDocument();
  });
  it('restores the owner description, dates, times and XP choice after the editor closes', async () => {
    const view = setup();
    await openAndFill(view.user);
    await view.user.click(screen.getByText('Уточнити оцінку'));
    await view.user.selectOptions(screen.getByLabelText('Обрана категорія XP'), '20');
    await view.user.click(screen.getByRole('button', { name: /На завтра/ }));
    await view.user.click(screen.getByRole('button', { name: 'Закрити панель' }));
    view.unmount();
    const reopened = setup();
    await reopened.user.click(await screen.findByRole('button', { name: 'Додати першу задачу' }));
    expect(screen.getByLabelText('Що хочу зробити')).toHaveValue(draft.title);
    expect(screen.getByLabelText('Опиши одну задачу')).toHaveValue(
      'Прокинутись о 7:00, виїхати на роботу о 7:20–7:30',
    );
    expect(screen.getByLabelText('День задачі')).toHaveValue('2026-10-18');
    expect(screen.getByLabelText('Крайній час · Київ: час')).toHaveValue('07:30');
    expect(screen.getByText('+20 XP')).toBeInTheDocument();
  });
  it('rejects an ambiguous Kyiv clock at its own field without losing the described task', async () => {
    const { user } = setup();
    await openAndFill(user);
    fireEvent.change(screen.getByLabelText('День задачі'), { target: { value: '2026-10-25' } });
    clock('Запланований початок · Київ', '0330');
    await user.click(screen.getByRole('button', { name: 'Зберегти в чернетку' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('повторюється при зміні годинника');
    expect(screen.getByLabelText('Запланований початок · Київ: час')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect((await fetchPlan()).tasks).toHaveLength(0);
  });
  it('keeps a valid imported non-Google block visible while editing and preserves its end', async () => {
    const workspace = await fetchPlan();
    await changePlan({
      op: 'task-save',
      commandId: crypto.randomUUID(),
      revision: workspace.revision,
      payload: {
        date: '2026-10-17',
        title: 'Зустріч',
        criterion: 'Завершити зустріч',
        xp: 20,
        startAt: '2026-10-17T12:00:00Z',
        endAt: '2026-10-17T13:00:00Z',
        calendar: false,
        calendarOriginId: 'local-import-fixture',
      },
    });
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Редагувати Зустріч' }));
    expect(screen.getByLabelText('Кінець блоку · Київ: час')).toHaveValue('16:00');
    await user.click(screen.getByRole('button', { name: 'Зберегти в чернетку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((await fetchPlan()).tasks[0]!.endAt).toBe('2026-10-17T13:00:00.000Z');
  });
  it('requires comparing an assistant edit before overwriting it with a restored local draft', async () => {
    let workspace = await fetchPlan();
    const command = {
      date: '2026-10-17',
      title: 'Зустріч',
      criterion: 'Початковий критерій',
      xp: 20,
    };
    await changePlan({
      op: 'task-save',
      commandId: crypto.randomUUID(),
      revision: workspace.revision,
      payload: command,
    });
    const view = setup();
    await view.user.click(await screen.findByRole('button', { name: 'Редагувати Зустріч' }));
    await view.user.clear(screen.getByLabelText('Коли це означатиме «зроблено»'));
    await view.user.type(screen.getByLabelText('Коли це означатиме «зроблено»'), 'Моє уточнення');
    workspace = await fetchPlan();
    await changePlan({
      op: 'task-save',
      id: workspace.tasks[0]!.id,
      commandId: crypto.randomUUID(),
      revision: workspace.revision,
      payload: { ...command, criterion: 'Уточнення з асистента' },
    });
    await view.client.invalidateQueries({ queryKey: ['motivation-plan'] });
    expect(
      await screen.findByText(
        'Задача змінилася в іншому місці. Твої незбережені правки залишилися у формі.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Коли це означатиме «зроблено»')).toHaveValue('Моє уточнення');
    expect(screen.getByRole('button', { name: 'Зберегти в чернетку' })).toBeDisabled();
    await view.user.click(
      screen.getByRole('button', { name: 'Використати актуальну версію як основу' }),
    );
    await view.user.click(screen.getByRole('button', { name: 'Зберегти в чернетку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((await fetchPlan()).tasks[0]!.criterion).toBe('Моє уточнення');
  });
});

it.each([
  ['0730', '07:30'],
  ['730', '07:30'],
  ['7:30', '07:30'],
  ['7', '07:00'],
  ['7:3', '07:03'],
])('normalizes a numeric 24-hour clock %s', (raw, expected) =>
  expect(normalizePlanClock(raw)).toBe(expected),
);
