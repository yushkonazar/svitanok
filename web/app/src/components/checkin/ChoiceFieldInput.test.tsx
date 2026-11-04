import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChoiceFieldInput } from './ChoiceFieldInput.tsx';
import { useSettings } from '../../api/hooks.ts';
import * as client from '../../api/client.ts';
import {
  FOLLOWUP_CARDS_V4,
  adaptivePreferences,
  contextualCardV4,
  clearHiddenV4,
} from '../../../../core/checkin/adaptive-v4.mjs';
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, haptic: vi.fn(), tg: undefined }));
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Harness({ mood = 5 }: { mood?: number }) {
  const settings = useSettings(),
    [answers, setAnswers] = useState<Record<string, unknown>>({ questionVersion: 4 });
  const a = { ...answers, mood },
    choices = settings.data?.settings.checkinChoices;
  if (!settings.data) return <p>Завантаження</p>;
  const field = contextualCardV4(
    FOLLOWUP_CARDS_V4.find((c) => c.id === 'mood-context')!,
    a,
    { choices },
  ).fields[0]!;
  return (
    <>
      <ChoiceFieldInput
        field={field}
        answers={a}
        choices={choices}
        p={adaptivePreferences(null)}
        date="2026-11-04"
        onChange={(k, v) =>
          setAnswers((prev) => clearHiddenV4('morning', { ...prev, mood, [k]: v }, { choices }))
        }
      />
      <output data-testid="answers">{JSON.stringify(answers)}</output>
    </>
  );
}
function open(mood = 5) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Harness mood={mood} />
    </QueryClientProvider>,
  );
}
async function manage() {
  fireEvent.click(await screen.findByText('Керувати варіантами'));
}
it('keeps both the full list and its editor within the current mood branch', async () => {
  open();
  await manage();
  expect(
    screen.queryByRole('button', { name: /Редагувати:.*[Кк]онфлікт/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Керувати варіантами'));
  fireEvent.click(screen.getByText('Ще причини'));
  expect(screen.queryByRole('button', { name: /[Кк]онфлікт/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Гарна погода' })).toBeInTheDocument();
});
it('keeps separate pins for positive and negative contexts, including migration of a full previous list', async () => {
  localStorage.setItem(
    'svitanok:checkin:mood-pins:v1',
    JSON.stringify(['weather_good', 'partner_good', 'slept_well', 'rest', 'success', 'calm_day']),
  );
  const view = open(1);
  fireEvent.click(await screen.findByText('Закріпити свої часті причини'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Конфлікт' }));
  expect(screen.getByRole('checkbox', { name: 'Конфлікт' })).toBeChecked();
  view.unmount();
  open(1);
  expect(await screen.findByRole('button', { name: 'Конфлікт' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Гарна погода' })).not.toBeInTheDocument();
});
it('creates a reusable categorized option, edits its name, deletes and restores it', async () => {
  const view = open();
  await manage();
  fireEvent.click(screen.getByRole('button', { name: '＋ Свій варіант' }));
  fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Кава на балконі' } });
  fireEvent.change(screen.getByLabelText('Категорія'), { target: { value: 'Маленькі радощі' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти варіант' }));
  await screen.findByRole('button', { name: 'Редагувати: Кава на балконі' });
  expect(screen.getByTestId('answers')).not.toHaveTextContent('user_');
  view.unmount();
  open();
  await manage();
  fireEvent.click(screen.getByRole('button', { name: 'Редагувати: Кава на балконі' }));
  fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Тиха кава на балконі' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти варіант' }));
  await screen.findByRole('button', { name: 'Видалити: Тиха кава на балконі' });
  fireEvent.click(screen.getByText('Керувати варіантами'));
  fireEvent.click(screen.getByText('Ще причини'));
  fireEvent.click(screen.getByRole('button', { name: 'Тиха кава на балконі' }));
  expect(screen.getByTestId('answers')).toHaveTextContent('user_');
  await manage();
  fireEvent.click(screen.getByRole('button', { name: 'Видалити: Тиха кава на балконі' }));
  await waitFor(() => expect(screen.getByTestId('answers')).not.toHaveTextContent('user_'));
  fireEvent.click(screen.getByRole('button', { name: /Видалені варіанти/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Відновити: Тиха кава на балконі' }));
  await screen.findByRole('button', { name: 'Редагувати: Тиха кава на балконі' });
});
it('can rename or remove built-in choices while keeping escape answers available', async () => {
  open();
  await manage();
  expect(screen.queryByRole('button', { name: 'Видалити: Інше' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Редагувати: Гарна погода' }));
  fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Сонце за вікном' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти варіант' }));
  await screen.findByRole('button', { name: 'Видалити: Сонце за вікном' });
  fireEvent.click(screen.getByRole('button', { name: 'Видалити: Сонце за вікном' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Сонце за вікном' })).not.toBeInTheDocument(),
  );
});
it('preserves the editor values after a server rejection and allows retry', async () => {
  open();
  await manage();
  fireEvent.click(screen.getByRole('button', { name: '＋ Свій варіант' }));
  fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Моя причина' } });
  const spy = vi
    .spyOn(client, 'postCheckinChoice')
    .mockRejectedValueOnce(new client.CheckinChoiceError('Список уже змінився', 409));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти варіант' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Список уже змінився');
  expect(screen.getByLabelText('Назва')).toHaveValue('Моя причина');
  spy.mockRestore();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти варіант' }));
  await screen.findByRole('button', { name: 'Редагувати: Моя причина' });
});
