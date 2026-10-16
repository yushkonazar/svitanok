import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PlanScreen } from './PlanScreen.tsx';
import { resetPlanDemo } from '../../api/plan-demo.ts';
import { changePlan, fetchPlan, PlanCommandError, readPendingPlanCommand } from '../../api/plan.ts';
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
