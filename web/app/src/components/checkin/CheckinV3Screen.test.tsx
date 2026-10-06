import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AdaptiveFlow } from './CheckinV3Screen.tsx';
import { adaptivePreferences, clearHiddenV3 } from '../../../../core/checkin/adaptive.mjs';
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, haptic: vi.fn() }));
afterEach(cleanup);
function Flow({
  initial = {},
  previousEvening = {},
  pending = false,
}: {
  initial?: Record<string, unknown>;
  previousEvening?: Record<string, unknown>;
  pending?: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({
    questionVersion: 3,
    ...initial,
  });
  const context = { morning: {}, previous: {}, previousEvening, activities: [] };
  return (
    <>
      <AdaptiveFlow
        slot="morning"
        date="2026-10-06"
        answers={answers}
        morning={{}}
        p={adaptivePreferences(null)}
        context={context}
        onChange={(k, v) => setAnswers((a) => clearHiddenV3('morning', { ...a, [k]: v }, context))}
        onConfirm={() => {}}
        pending={pending}
      />
      <output data-testid="answers">{JSON.stringify(answers)}</output>
    </>
  );
}
it('opens a relevant sleep explanation and removes it when quality changes', () => {
  render(<Flow />);
  fireEvent.click(screen.getByRole('button', { name: 'Основний сон' }));
  fireEvent.click(screen.getByRole('button', { name: '2 · Радше погано' }));
  expect(screen.getByRole('region', { name: 'Що завадило цьому сну?' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Пробудження' }));
  expect(screen.getByTestId('answers').textContent).toContain('awakenings');
  fireEvent.click(screen.getByRole('button', { name: '5 · Повністю влаштував' }));
  expect(screen.queryByRole('region', { name: 'Що завадило цьому сну?' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Що допомогло виспатися?' })).toBeInTheDocument();
  expect(screen.getByTestId('answers').textContent).not.toContain('awakenings');
});
it('allows a sleepless morning without inventing quality or duration', () => {
  render(<Flow />);
  fireEvent.click(screen.getByRole('button', { name: 'Не спав' }));
  expect(screen.queryByText('Як оцінюєш цей сон?')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  expect(screen.getByRole('heading', { name: 'Як ти зараз?' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Далі →' })).toBeDisabled();
});
it('keeps independent scale values and reveals the low-energy clarification', () => {
  render(<Flow initial={{ sleepModeV3: 'none' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  fireEvent.click(screen.getByRole('button', { name: '1 · Сил майже немає' }));
  expect(screen.getByRole('region', { name: 'Мало сил — який це стан?' })).toBeInTheDocument();
  expect(screen.getByTestId('answers').textContent).not.toContain('"mood"');
  fireEvent.click(screen.getByRole('button', { name: '3 · Нейтральний або змішаний' }));
  expect(screen.getByRole('button', { name: 'Далі →' })).toBeEnabled();
});
it('groups activities without a module picker and treats alone as exclusive', () => {
  render(<Flow initial={{ sleepModeV3: 'none', energy: 3, mood: 3 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  expect(screen.getByText('Справи й розвиток')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Справи й розвиток'));
  fireEvent.click(screen.getByRole('button', { name: 'Робота' }));
  fireEvent.click(screen.getByRole('button', { name: 'З коханою людиною' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сам' }));
  expect(screen.getByTestId('answers').textContent).toContain('"companyV3":["alone"]');
  expect(screen.queryByText('+ Додати деталі')).not.toBeInTheDocument();
});

it('keeps sleep clarifications in place when the lower clarification gets an answer', () => {
  render(<Flow previousEvening={{ bedtimePlanV3: '23:00' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Основний сон' }));
  fireEvent.click(screen.getByRole('button', { name: '2 · Радше погано' }));
  const bedtime = screen.getByRole('region', { name: 'Відхід до сну' });
  const sleep = screen.getByRole('region', { name: 'Що завадило цьому сну?' });
  expect(screen.getAllByRole('region')).toEqual([bedtime, sleep]);
  fireEvent.click(screen.getByRole('button', { name: 'Пробудження' }));
  expect(screen.getAllByRole('region')).toEqual([bedtime, sleep]);
});

it('keeps the current card, open groups and focus across saving and timer redraws', () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const initial = { sleepModeV3: 'none', energy: 3, mood: 3 };
  const view = render(<Flow initial={initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  const summary = screen.getByText('Справи й розвиток');
  fireEvent.click(summary);
  const group = summary.closest('details')!;
  const work = screen.getByRole('button', { name: 'Робота' });
  work.focus();
  fireEvent.click(work);
  const card = view.container.querySelector('.checkin-adaptive-card');
  view.rerender(<Flow initial={initial} pending />);
  view.rerender(<Flow initial={initial} />);
  expect(view.container.querySelector('.checkin-adaptive-card')).toBe(card);
  expect(group).toHaveAttribute('open');
  expect(work).toHaveFocus();
  expect(screen.getByRole('heading', { name: 'Твій контекст' })).toBeInTheDocument();
  expect(scroll).not.toHaveBeenCalled();
  scroll.mockRestore();
});
