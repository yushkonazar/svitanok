import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FieldInput } from './CheckinV2Screen.tsx';
import {
  CHECKIN_CARDS,
  normalizeCheckinPreferences,
  type Field,
} from '../../../../core/checkin/catalog.mjs';

vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, haptic: vi.fn() }));
afterEach(cleanup);
function Answers({ fields }: { fields: Field[] }) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  return (
    <>
      {fields.map((f) => (
        <FieldInput
          key={f.id}
          field={f}
          answers={answers}
          p={normalizeCheckinPreferences(null)}
          date="2026-10-04"
          onChange={(key, value) => setAnswers((a) => ({ ...a, [key]: value }))}
        />
      ))}
      <output data-testid="answers">{JSON.stringify(answers)}</output>
    </>
  );
}
it('selecting energy leaves mood unanswered until explicitly chosen', () => {
  render(<Answers fields={CHECKIN_CARDS.afternoon![0]!.fields} />);
  fireEvent.click(screen.getByRole('button', { name: '4 · Достатньо сил' }));
  expect(screen.getByTestId('answers').textContent).toBe('{"energy":4}');
  fireEvent.click(screen.getByRole('button', { name: '3 · Нейтральний' }));
  expect(screen.getByTestId('answers').textContent).toBe('{"energy":4,"mood":3}');
});
it('limit keeps chosen factors and explains the limit; none is exclusive', () => {
  const field = CHECKIN_CARDS.evening!.find((c) => c.id === 'factors')!.fields[0]!;
  render(<Answers fields={[field]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Брак сил' }));
  fireEvent.click(screen.getByRole('button', { name: 'Відволікання' }));
  fireEvent.click(screen.getByRole('button', { name: 'Забагато справ' }));
  expect(screen.getByText(/Можна обрати до 2/)).toBeInTheDocument();
  expect(screen.getByTestId('answers').textContent).toBe(
    '{"blockersV2":["fatigue","distraction"]}',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Нічого' }));
  expect(screen.getByTestId('answers').textContent).toBe('{"blockersV2":["none"]}');
  fireEvent.click(screen.getByRole('button', { name: 'Брак сил' }));
  expect(screen.getByTestId('answers').textContent).toBe('{"blockersV2":["fatigue"]}');
});
it('duration is explicit minutes; no field is silently populated on mount', () => {
  render(
    <Answers
      fields={[{ id: 'learningMinutesV2', label: 'Навчання', type: 'duration', min: 0, max: 1440 }]}
    />,
  );
  expect(screen.getByTestId('answers').textContent).toBe('{}');
  fireEvent.change(screen.getByLabelText('Години'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Хвилини'), { target: { value: '35' } });
  expect(screen.getByTestId('answers').textContent).toBe('{"learningMinutesV2":95}');
  fireEvent.click(screen.getByRole('button', { name: '0 хв' }));
  expect(screen.getByTestId('answers').textContent).toBe('{"learningMinutesV2":0}');
});
