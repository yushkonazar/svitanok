import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AdaptiveFlow } from './AdaptiveFlow.tsx';
import { adaptivePreferences, clearHiddenV4 } from '../../../../core/checkin/adaptive-v4.mjs';
import { setVerticalSwipes } from '../../telegram.ts';
vi.mock('../../telegram.ts', () => ({
  inTelegram: () => false,
  haptic: vi.fn(),
  setVerticalSwipes: vi.fn(),
}));
afterEach(cleanup);
function Flow({
  initial = {},
  previousEvening = {},
  previous = {},
  pending = false,
  slot = 'morning',
}: {
  initial?: Record<string, unknown>;
  previousEvening?: Record<string, unknown>;
  previous?: Record<string, unknown>;
  pending?: boolean;
  slot?: 'morning' | 'afternoon' | 'evening';
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({
    questionVersion: 4,
    ...initial,
  });
  const context = { morning: {}, previous, previousEvening, activities: [] };
  return (
    <>
      <AdaptiveFlow
        slot={slot}
        nowMs={Date.parse('2026-11-04T20:00:00Z')}
        date="2026-11-04"
        answers={answers}
        p={adaptivePreferences(null)}
        context={context}
        onChange={(k, v) => setAnswers((a) => clearHiddenV4(slot, { ...a, [k]: v }, context))}
        onConfirm={() => {}}
        pending={pending}
      />
      <output data-testid="answers">{JSON.stringify(answers)}</output>
    </>
  );
}
it('allows sleepless morning without inventing quality or duration', () => {
  render(<Flow />);
  fireEvent.click(screen.getByRole('button', { name: 'Не спав' }));
  expect(screen.queryByText('Наскільки відпочив після цього сну?')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  expect(screen.getByRole('heading', { name: 'Як ти зараз?' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Далі →' })).toBeDisabled();
});
it('offers sleep details, clears inapplicable branches and keeps navigation above them', () => {
  const view = render(<Flow />);
  fireEvent.click(screen.getByRole('button', { name: 'Основний сон' }));
  fireEvent.click(screen.getByRole('button', { name: '2 · Радше не відпочив' }));
  const sleep = screen.getByText('Що завадило цьому сну?').closest('details')!;
  fireEvent.click(screen.getByText('Що завадило цьому сну?'));
  fireEvent.click(screen.getByRole('button', { name: 'Прокидався' }));
  expect(screen.getByTestId('answers').textContent).toContain('awakenings');
  expect(
    view.container.querySelector('.checkin-flow-actions')!.compareDocumentPosition(sleep) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '5 · Повністю відпочив' }));
  expect(screen.queryByText('Що завадило цьому сну?')).not.toBeInTheDocument();
  expect(screen.getByTestId('answers').textContent).not.toContain('awakenings');
});
it('resumes at the first unanswered required step, or review for a completed draft', () => {
  const view = render(<Flow initial={{ sleepModeV4: 'none', energy: 3, mood: 3 }} />);
  expect(screen.getByRole('heading', { name: 'Напрямок цього дня' })).toBeInTheDocument();
  view.unmount();
  render(
    <Flow
      slot="afternoon"
      initial={{ energy: 3, mood: 3, priorityPaceV4: 'later', visitedStepsV4: ['context'] }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Підтвердити чек-ін' })).toBeEnabled();
  expect(screen.queryByText('Обставини плану')).not.toBeInTheDocument();
});
it('exposes neutral mood details manually and retains positive and negative reasons together', () => {
  render(<Flow slot="afternoon" initial={{ energy: 3 }} />);
  fireEvent.click(screen.getByRole('button', { name: '3 · Нейтральний або змішаний' }));
  fireEvent.click(screen.getByRole('button', { name: '＋ Додати деталі' }));
  fireEvent.click(screen.getByRole('button', { name: 'Хочеш додати, що вплинуло на настрій?' }));
  fireEvent.click(screen.getByRole('button', { name: 'Гарна погода' }));
  fireEvent.click(screen.getByText('Ще причини'));
  fireEvent.click(screen.getByRole('button', { name: 'Складна розмова з коханою' }));
  expect(screen.getByTestId('answers').textContent).toContain('weather_good');
  expect(screen.getByTestId('answers').textContent).toContain('partner_hard');
  fireEvent.click(screen.getByRole('button', { name: '5 · Дуже хороший' }));
  expect(screen.getByTestId('answers').textContent).toContain('partner_hard');
});
it('keeps independent energy and mood and supports mental fatigue', () => {
  render(<Flow slot="afternoon" />);
  fireEvent.click(screen.getByRole('button', { name: '1 · Сил майже немає' }));
  expect(screen.getByTestId('answers').textContent).not.toContain('"mood"');
  fireEvent.click(screen.getByText('Що пов’язуєш зі своїми силами?'));
  fireEvent.click(screen.getByRole('button', { name: 'Розумова втома' }));
  fireEvent.click(screen.getByRole('button', { name: 'Фізична втома' }));
  expect(screen.getByTestId('answers').textContent).toContain(
    '"energyKindV4":["mental","physical"]',
  );
});
it('supports three independent activities and keeps alone exclusive', () => {
  render(<Flow slot="afternoon" initial={{ energy: 3, mood: 3 }} />);
  fireEvent.click(screen.getByText('Справи й розвиток'));
  for (const name of ['Навчання', 'Курс', 'Читання для себе'])
    fireEvent.click(screen.getByRole('button', { name }));
  expect(screen.getByTestId('answers').textContent).toContain(
    '"activitiesV4":["study","course","read"]',
  );
  fireEvent.click(screen.getByRole('button', { name: 'З коханою людиною' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сам' }));
  expect(screen.getByTestId('answers').textContent).toContain('"companyV4":["alone"]');
});
it('opens optional Other text only for its selected reason', () => {
  render(<Flow slot="afternoon" initial={{ energy: 1 }} />);
  fireEvent.click(screen.getByText('Що пов’язуєш зі своїми силами?'));
  const buttons = screen.getAllByRole('button', { name: 'Інше' });
  fireEvent.click(buttons[0]);
  expect(screen.getByRole('textbox', { name: /Інше — своїми словами/ })).toBeInTheDocument();
  fireEvent.click(buttons[0]);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
it('shows previous subjective scores only after the user answers, with the actual timestamp', () => {
  render(
    <Flow
      slot="afternoon"
      previous={{ energy: 4, mood: 2, confirmedAtV3: '2026-11-04T08:20:00Z' }}
    />,
  );
  expect(screen.queryByLabelText('Порівняння з попереднім записом')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '2 · Мало сил, справи даються важко' }));
  const delta = screen.getByLabelText('Порівняння з попереднім записом');
  expect(delta).toHaveTextContent('10:20');
  expect(delta).toHaveTextContent('Енергія: 4 → 2');
  expect(delta).not.toHaveTextContent('Настрій');
});
it('keeps current card, expanded group and keyboard focus across saving redraws', () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {}),
    initial = { energy: 3, mood: 3 };
  const view = render(<Flow slot="afternoon" initial={initial} />);
  fireEvent.click(screen.getByText('Справи й розвиток'));
  const work = screen.getByRole('button', { name: 'Робота' }),
    group = work.closest('details')!;
  work.focus();
  fireEvent.click(work);
  const card = view.container.querySelector('.checkin-adaptive-card');
  view.rerender(<Flow slot="afternoon" initial={initial} pending />);
  view.rerender(<Flow slot="afternoon" initial={initial} />);
  expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
  expect(group).toHaveAttribute('open');
  expect(work).toHaveFocus();
  expect(scroll).not.toHaveBeenCalled();
  scroll.mockRestore();
});
it('releases pointer focus and scrolls only on explicit step navigation', () => {
  const previous = HTMLElement.prototype.scrollIntoView,
    scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const view = render(<Flow slot="afternoon" />);
    fireEvent.click(screen.getByRole('button', { name: '3 · Вистачає на звичні справи' }));
    fireEvent.click(screen.getByRole('button', { name: '3 · Нейтральний або змішаний' }));
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Справи й розвиток'));
    const work = screen.getByRole('button', { name: 'Робота' });
    work.focus();
    fireEvent.click(work, { detail: 1 });
    expect(work).not.toHaveFocus();
    view.rerender(<Flow slot="afternoon" pending />);
    expect(scroll).toHaveBeenCalledTimes(1);
  } finally {
    HTMLElement.prototype.scrollIntoView = previous;
  }
});
it('suspends native pull only while the flow is open', () => {
  vi.mocked(setVerticalSwipes).mockClear();
  const view = render(<Flow slot="afternoon" />);
  expect(setVerticalSwipes).toHaveBeenLastCalledWith(false);
  view.unmount();
  expect(setVerticalSwipes).toHaveBeenLastCalledWith(true);
});
