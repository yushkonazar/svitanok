import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PlanScreen } from './PlanScreen.tsx';
import { resetPlanDemo } from '../../api/plan-demo.ts';
import { changePlan, fetchPlan, PlanCommandError, readPendingPlanCommand } from '../../api/plan.ts';
import { emptyPlan, applyPlanCommand, planView } from '../../../../core/motivation/model.mjs';
const telegram = vi.hoisted(() => ({ live: false }));
vi.mock('../../telegram.ts', () => ({
  inTelegram: () => telegram.live,
  tg: { initData: 'signed-local-test' },
  haptic: vi.fn(),
}));
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/plan']}>
        <PlanScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, user: userEvent.setup() };
}
beforeEach(() => {
  telegram.live = false;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  resetPlanDemo();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('manual plan owner journey', () => {
  it('shows an existing late time-sensitive fact as completed, keeps zero XP and preserves its exact time when reopened', async () => {
    const now = Date.now();
    const due = now - 3600000;
    const actualAt = new Date(due + 60000 + 12345).toISOString();
    let state = emptyPlan();
    state.balance = 100;
    const events: Record<string, unknown>[] = [];
    let serial = 0;
    const act = (
      op: string,
      payload: Record<string, unknown>,
      id: string | undefined,
      at: number,
    ) => {
      const next = applyPlanCommand(
        state,
        { op, payload, id, commandId: `late-fixture-${++serial}` },
        at,
      );
      state = next.state;
      events.unshift(...[...next.events].reverse());
      return next.receipt.id;
    };
    const date = planView(state, now).today;
    act('settings', { enabled: true }, undefined, due - 3600000);
    const id = act(
      'task-save',
      {
        date,
        title: 'Вчасно почати заняття',
        criterion: 'Почати до визначеного строку',
        target: 1,
        unit: 'дія',
        xp: 20,
        effort: 1,
        contribution: 0,
        timeSensitive: true,
        deadlineKind: 'time',
        dueAt: new Date(due).toISOString(),
      },
      undefined,
      due - 3500000,
    );
    act('accept', { date }, undefined, due - 3400000);
    act('forfeit', { reason: 'Не встиг' }, id, due + 1000);
    act('report', { units: 1, actualAt }, id, now - 1800000);
    localStorage.setItem('svitanok:plan-demo:v1', JSON.stringify({ state, events }));

    const { user } = setup();
    expect(await screen.findByText(/1 із 1 результатів/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показати виконані · 1' }));
    const review = screen.getByRole('button', { name: 'Переглянути Вчасно почати заняття' });
    const card = review.closest('article')!;
    expect(within(card).getByText('Виконано із запізненням')).toBeInTheDocument();
    expect(card.querySelector('.plan-task-xp')).toHaveTextContent('0 XP');
    expect(card.querySelector('.plan-task-xp')).not.toHaveTextContent('+20');
    await user.click(review);
    const detail = screen.getByRole('dialog');
    expect(within(detail).queryByText(/вводити 0 не потрібно/)).not.toBeInTheDocument();
    expect(within(detail).getByText(/Факт: 1 \/ 1 дія/)).toBeInTheDocument();
    expect(within(detail).getByText(/Час факту:/)).toBeInTheDocument();
    expect(within(detail).getByLabelText('Пояснення запізнення')).toBeInTheDocument();
    await user.click(within(detail).getByText('Виняткова обставина або перенесення'));
    expect(within(detail).getByLabelText('Причина зовнішнього винятку')).toBeInTheDocument();
    expect(
      within(detail).queryByRole('button', { name: 'Перенести з цією причиною' }),
    ).not.toBeInTheDocument();
    await user.click(within(detail).getByRole('button', { name: 'Уточнити результат' }));
    expect(screen.getByRole('button', { name: '✓ Виконав' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Цей результат був раніше, записую зараз')).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Зберегти результат' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const saved = (await fetchPlan()).tasks.find((t) => t.id === id)!;
    expect(saved).toMatchObject({
      lifecycle: 'completed-late',
      facts: { units: 1, eligibleUnits: 0, done: true, credited: 0 },
      lastReport: { actualAt },
    });
    expect((await fetchPlan()).wallet.balance).toBe(94);
  });
  it('changes to missed at the deadline on an already open page and uses a binary result instead of a zero input', async () => {
    let w = await fetchPlan();
    await changePlan({
      op: 'settings',
      payload: { enabled: true },
      commandId: crypto.randomUUID(),
      revision: w.revision,
    });
    w = await fetchPlan();
    const created = await changePlan({
      op: 'task-save',
      payload: {
        date: w.today,
        title: 'Виїхати вчасно',
        criterion: 'Виїхати до строку',
        target: 1,
        xp: 20,
        effort: 1,
        contribution: 0,
        deadlineKind: 'time',
        dueAt: new Date(Date.now() + 1800).toISOString(),
        timeSensitive: true,
      },
      commandId: crypto.randomUUID(),
      revision: w.revision,
    });
    w = await fetchPlan();
    await changePlan({
      op: 'accept',
      payload: { date: w.today },
      commandId: crypto.randomUUID(),
      revision: w.revision,
    });
    const { user } = setup();
    await screen.findByRole('button', { name: 'Виконати Виїхати вчасно' });
    await screen.findByText('Не виконано вчасно', {}, { timeout: 4000 });
    expect(
      (await fetchPlan()).tasks.find((t) => t.id === created.receipt.id)?.lastReport,
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Уточнити Виїхати вчасно' }));
    expect(screen.getByText(/вводити 0 не потрібно/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Уточнити результат' }));
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '× Не виконав' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.type(
      screen.getByLabelText('Що сталося? · необов’язково'),
      'Прокинувся, але заснув знову.',
    );
    await user.click(screen.getByRole('button', { name: 'Зберегти результат' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((await fetchPlan()).tasks.find((t) => t.id === created.receipt.id)).toMatchObject({
      status: 'accepted',
      outcomeNote: 'Прокинувся, але заснув знову.',
      facts: { done: false, units: 0 },
    });
  });
  it('dismisses initial setup after saving rules while disabled and keeps it dismissed after reopening', async () => {
    const first = setup();
    await first.user.click(
      await screen.findByRole('button', { name: 'Переглянути й увімкнути правила' }),
    );
    expect(screen.getByLabelText('Увімкнути ручний план і його нагадування')).not.toBeChecked();
    const penalty = screen.getByLabelText('Штраф за невиконаний обсяг, %');
    await first.user.clear(penalty);
    await first.user.type(penalty, '35');
    await first.user.click(screen.getByRole('button', { name: 'Зберегти правила' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Твої рішення. Відомі наслідки.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Правила плану' })).toBeInTheDocument();
    expect((await fetchPlan()).settings.enabled).toBe(false);
    first.unmount();
    first.client.clear();

    const reopened = setup();
    await screen.findByRole('heading', { name: 'Мій план' });
    expect(screen.queryByText('Твої рішення. Відомі наслідки.')).not.toBeInTheDocument();
    await reopened.user.click(screen.getByRole('button', { name: 'Правила плану' }));
    expect(screen.getByLabelText('Штраф за невиконаний обсяг, %')).toHaveValue(35);
    expect(screen.getByLabelText('Увімкнути ручний план і його нагадування')).not.toBeChecked();
  });
  it('keeps initial setup available when saving rules is not acknowledged', async () => {
    const workspace = await fetchPlan();
    telegram.live = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'POST'
            ? new Response(JSON.stringify({ ok: false, error: 'Не вдалося зберегти правила.' }), {
                status: 500,
              })
            : new Response(JSON.stringify({ ok: true, workspace }), { status: 200 }),
        ),
      ),
    );
    const { user } = setup();
    await user.click(
      await screen.findByRole('button', { name: 'Переглянути й увімкнути правила' }),
    );
    await user.click(screen.getByRole('button', { name: 'Зберегти правила' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося зберегти правила.');
    await user.click(screen.getByRole('button', { name: 'Закрити панель' }));
    expect(
      screen.getByRole('button', { name: 'Переглянути й увімкнути правила' }),
    ).toBeInTheDocument();
  });
  it('accepts an explicit plan, awards partial work without a loss and undoes an accidental report', async () => {
    const { user } = setup();
    await user.click(
      await screen.findByRole('button', { name: 'Переглянути й увімкнути правила' }),
    );
    await user.click(screen.getByLabelText('Увімкнути ручний план і його нагадування'));
    await user.click(screen.getByRole('button', { name: 'Зберегти правила' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Додати першу задачу' }));
    await user.type(screen.getByLabelText('Що хочу зробити'), 'Практика SQL');
    await user.type(
      screen.getByLabelText('Коли це означатиме «зроблено»'),
      'Розв’язати п’ять задач',
    );
    const volume = screen.getByLabelText('Обсяг');
    await user.clear(volume);
    await user.type(volume, '5');
    await user.click(screen.getByRole('button', { name: 'Зберегти в чернетку' }));
    await user.click(await screen.findByRole('button', { name: 'Прийняти план' }));
    expect(within(screen.getByRole('dialog')).getByText('−6 XP')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Приймаю цей план' }));
    await user.click(await screen.findByRole('button', { name: 'Виконати Практика SQL' }));
    const result = screen.getByLabelText(/Фактично зроблено загалом/);
    await user.clear(result);
    await user.type(result, '3');
    await user.click(screen.getByRole('button', { name: 'Зберегти факт' }));
    expect(await screen.findByText('+12 XP за результат.')).toBeInTheDocument();
    expect(screen.getByText('ризик −3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Скасувати позначку' }));
    expect(await screen.findByText('Позначку скасовано.')).toBeInTheDocument();
    expect(screen.getByText('ризик −6')).toBeInTheDocument();
  });
  it('adds a reward candidate without inventing purchase readiness and keeps the real-budget gate visible', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Винагороди' }));
    await user.click(screen.getByRole('button', { name: /Apple Watch.*2500 XP/ }));
    expect(screen.getByLabelText('Я особисто перевірив і підтверджую ці умови')).not.toBeChecked();
    await user.type(
      screen.getByLabelText('Реальний бюджет і умови покупки'),
      'Ціна і спосіб оплати ще не визначені.',
    );
    await user.click(screen.getByLabelText('Показувати як обрану ціль у «Дні»'));
    await user.click(screen.getByRole('button', { name: 'Зберегти винагороду' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /ОБРАНА ЦІЛЬ.*Apple Watch/ }));
    expect(screen.getByRole('button', { name: 'Ще рухаюся до відкриття' })).toBeDisabled();
    expect(screen.getByText('◇ Потрібен реальний етап готовності')).toBeInTheDocument();
  });
  it('does not switch an expired authenticated session into a demo and exposes conflict status for safe retry', async () => {
    telegram.live = true;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(fetchPlan()).rejects.toMatchObject({ status: 401 });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false, error: 'План уже змінився' }), { status: 409 }),
        ),
    );
    await expect(
      changePlan({
        op: 'start',
        id: 'task-example',
        payload: {},
        revision: 1,
        commandId: 'stable-command',
      }),
    ).rejects.toBeInstanceOf(PlanCommandError);
  });
  it('keeps the exact command after a lost response and clears it only after acknowledgement', async () => {
    telegram.live = true;
    const command = {
      op: 'start',
      id: 'task-example',
      payload: {},
      revision: 1,
      commandId: 'stable-network-retry',
    };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection lost')));
    await expect(changePlan(command)).rejects.toMatchObject({ status: 503 });
    expect(readPendingPlanCommand()).toEqual(command);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            receipt: { message: 'Збережено.', id: command.id, reportId: '' },
          }),
          { status: 200 },
        ),
      ),
    );
    await changePlan(readPendingPlanCommand()!);
    expect(readPendingPlanCommand()).toBeNull();
  });
});
