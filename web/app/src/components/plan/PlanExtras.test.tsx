import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskAssist, CalendarPanel, DayExtensionPanel } from './PlanExtras.tsx';
import { planWorkspaceSchema } from '../../api/plan.ts';
import { emptyPlan, planView } from '../../../../core/motivation/model.mjs';
const requests = vi.hoisted(() => ({ suggest: vi.fn(), calendar: vi.fn() }));
vi.mock('../../api/plan.ts', async (original) => ({
  ...(await original<object>()),
  suggestPlanTask: requests.suggest,
  fetchPlanCalendar: requests.calendar,
}));
beforeEach(() => {
  requests.suggest.mockReset();
  requests.calendar.mockReset();
});
afterEach(() => cleanup());
it('uses the owner description to prefill a reviewable form without creating or accepting a task', async () => {
  const draft = {
    title: 'SQL',
    criterion: '5 задач',
    target: 5,
    unit: 'задач',
    area: 'learning',
    effort: 1,
    contribution: 1,
    challenge: 1,
    routine: false,
    estimateMinutes: 60,
    firstStep: 'Відкрити курс',
    dueTime: null,
    startTime: null,
    timeSensitive: false,
    source: null,
    questions: ['Який курс?'],
    xp: 50,
    scoreReasons: [],
  };
  requests.suggest.mockResolvedValue(draft);
  const onApply = vi.fn();
  render(<TaskAssist date="2026-10-17" onApply={onApply} />);
  fireEvent.click(screen.getByText('Допомогти заповнити з мого опису ✧'));
  fireEvent.change(screen.getByLabelText('Опиши одну задачу'), {
    target: { value: 'Хочу практикувати SQL' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Заповнити форму' }));
  await waitFor(() => expect(onApply).toHaveBeenCalledWith(draft));
  expect(requests.suggest).toHaveBeenCalledWith('Хочу практикувати SQL', '2026-10-17');
  expect(screen.getByText('Який курс?')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Перевір');
});
it('imports an explicitly chosen calendar event into a draft without creating a duplicate external event', async () => {
  requests.calendar.mockResolvedValue([
    {
      id: 'google-event',
      title: 'Зустріч',
      time: '14:00',
      date: '2026-10-17',
      startMs: Date.parse('2026-10-17T11:00:00Z'),
      endMs: Date.parse('2026-10-17T12:00:00Z'),
      transparent: false,
    },
  ]);
  const run = vi.fn().mockResolvedValue(true),
    data = planWorkspaceSchema.parse(planView(emptyPlan(), Date.parse('2026-10-17T07:00:00Z')));
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CalendarPanel date="2026-10-17" data={data} run={run} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Підготувати чернетку' }));
  expect(run).toHaveBeenCalledWith(
    'task-save',
    expect.objectContaining({
      calendar: false,
      calendarOriginId: 'google-event',
      deadlineKind: 'time',
    }),
  );
  expect(run).toHaveBeenCalledTimes(1);
});
it('explains an invalid DST overtime clock without an unhandled submit error', () => {
  const run = vi.fn();
  render(<DayExtensionPanel date="2026-10-24" boundary="03:00" run={run} />);
  fireEvent.change(screen.getByLabelText('Нова межа наступного ранку · Київ'), {
    target: { value: '03:30' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Погодити нову межу' }));
  expect(screen.getByRole('alert')).toHaveTextContent('повторюється');
  expect(run).not.toHaveBeenCalled();
});
