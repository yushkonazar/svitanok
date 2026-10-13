import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MemoryPanel, MemoryFactEditor, MemoryPreferencesForm } from './MemoryPanel.tsx';
import {
  MemoryChangeError,
  type MemoryWorkspace,
  type MemoryMutationReceipt,
} from '../../api/memory-schema.ts';

const mocks = vi.hoisted(() => ({ private: true, fetch: vi.fn(), change: vi.fn() }));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => mocks.private }));
vi.mock('../../api/client.ts', () => ({ fetchMemory: mocks.fetch, changeMemory: mocks.change }));
const workspace = (): MemoryWorkspace => ({
  preferences: { version: 1, mode: 'confirm', categories: [] },
  preferencesToken: '',
  preferencesValid: true,
  offset: 0,
  nextOffset: null,
  candidates: [],
  entries: [
    {
      id: 'habit:day_start',
      label: 'Початок дня',
      value: '08:00',
      text: '08:00',
      editable: true,
      source: 'owner_assertion',
      token: 'event-1',
      updatedAt: '2026-10-11T10:00:00Z',
      stale: false,
      reviewDue: false,
      expiresAt: null,
      reviewAt: null,
    },
  ],
});
let qc: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.private = true;
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.fetch.mockResolvedValue(workspace());
});
afterEach(() => {
  cleanup();
  qc.clear();
});
const open = () =>
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings?panel=memory']}>
        <MemoryPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );

it('does not read or write private memory in public demo', () => {
  mocks.private = false;
  open();
  expect(screen.getByText(/У демо персональна пам’ять не/)).toBeInTheDocument();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.change).not.toHaveBeenCalled();
});
it('opt-in requires a selected category and explicit save, with no mutation on switching', async () => {
  open();
  fireEvent.change(await screen.findByLabelText('Режим пам’яті'), {
    target: { value: 'explicit' },
  });
  expect(screen.getByRole('button', { name: 'Зберегти режим' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Вподобання'));
  expect(mocks.change).not.toHaveBeenCalled();
  mocks.change.mockResolvedValue({ message: 'Режим пам’яті збережено.', snapshot: workspace() });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти режим' }));
  await waitFor(() =>
    expect(mocks.change).toHaveBeenCalledWith(
      {
        type: 'preferences',
        token: '',
        preferences: { version: 1, mode: 'explicit', categories: ['preferences'] },
      },
      expect.anything(),
    ),
  );
});
it('preserves preference drafts when another editor changes consent', () => {
  const data = workspace(),
    save = vi.fn();
  const view = render(
    <MemoryPreferencesForm workspace={data} disabled={false} save={save} reset={() => {}} />,
  );
  fireEvent.change(screen.getByLabelText('Режим пам’яті'), { target: { value: 'explicit' } });
  fireEvent.click(screen.getByLabelText('Вподобання'));
  view.rerender(
    <MemoryPreferencesForm
      workspace={{ ...data, preferencesToken: 'new' }}
      disabled={false}
      save={save}
      reset={() => {}}
    />,
  );
  expect(screen.getByLabelText('Режим пам’яті')).toHaveValue('explicit');
  expect(screen.getByLabelText('Вподобання')).toBeChecked();
  expect(screen.getByRole('alert')).toHaveTextContent('Режим уже змінився');
  expect(screen.getByRole('button', { name: 'Зберегти режим' })).toBeDisabled();
});
it('freezes the fact and its token while editing, preserving the draft after a refresh', () => {
  const entry = workspace().entries[0]!,
    save = vi.fn();
  const view = render(
    <MemoryFactEditor
      entry={entry}
      latestToken={entry.token}
      disabled={false}
      save={save}
      cancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText('Значення факту'), { target: { value: '09:00' } });
  view.rerender(
    <MemoryFactEditor
      entry={entry}
      latestToken="event-2"
      disabled={false}
      save={save}
      cancel={() => {}}
    />,
  );
  expect(screen.getByLabelText('Значення факту')).toHaveValue('09:00');
  expect(screen.getByRole('alert')).toHaveTextContent('Факт уже змінився');
  expect(screen.getByRole('button', { name: 'Зберегти факт' })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
});
it('requires a second explicit choice to remove a fact and explains retained history', async () => {
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Прибрати' }));
  expect(screen.getByText(/не стирає історію/)).toBeInTheDocument();
  expect(mocks.change).not.toHaveBeenCalled();
  mocks.change.mockResolvedValue({
    message: 'Прибрано.',
    snapshot: { ...workspace(), entries: [] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Так, прибрати' }));
  await waitFor(() =>
    expect(mocks.change).toHaveBeenCalledWith(
      { type: 'remove', id: 'habit:day_start', token: 'event-1', confirm: true },
      expect.anything(),
    ),
  );
  expect(await screen.findByText('Прибрано.')).toBeInTheDocument();
});
it('explains why a stale removal confirmation cannot be used', async () => {
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Прибрати' }));
  const data = workspace();
  data.entries[0]!.token = 'event-2';
  act(() => qc.setQueryData(['memory', 0, 'all', ''], data));
  expect(await screen.findByRole('alert')).toHaveTextContent('Факт уже змінився');
  expect(screen.getByRole('button', { name: 'Так, прибрати' })).toBeDisabled();
});
it('blocks repeated writes after an uncertain network failure, until an explicit successful refresh', async () => {
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Змінити' }));
  fireEvent.change(screen.getByLabelText('Значення факту'), { target: { value: '09:00' } });
  mocks.change.mockRejectedValue(new MemoryChangeError('Не отримав підтвердження зміни.', true));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти факт' }));
  expect(await screen.findByText(/Перед наступною зміною онови пам’ять/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Зберегти факт' })).toBeDisabled();
  expect(screen.getByLabelText('Значення факту')).toHaveValue('09:00');
  fireEvent.click(screen.getByRole('button', { name: 'Оновити пам’ять' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Зберегти факт' })).not.toBeDisabled(),
  );
  expect(mocks.change).toHaveBeenCalledTimes(1);
});
it('acknowledges committed changes separately from a failed snapshot', async () => {
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Змінити' }));
  mocks.change.mockResolvedValue({ message: 'Факт оновлено.', snapshot: null });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти факт' }));
  expect(await screen.findByText(/Факт оновлено. Показ не оновився/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Зберегти режим' })).toBeDisabled();
  expect(screen.queryByLabelText('Значення факту')).not.toBeInTheDocument();
});
it('disables all actions while a decision is pending', async () => {
  let resolve!: (value: MemoryMutationReceipt) => void;
  mocks.change.mockImplementation(
    () =>
      new Promise<MemoryMutationReceipt>((done) => {
        resolve = done;
      }),
  );
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Зберегти режим' }));
  expect(await screen.findByText('Зберігаю рішення…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Змінити' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Зберегти режим' })).toBeDisabled();
  await act(async () => resolve({ message: 'Збережено.', snapshot: workspace() }));
  expect(await screen.findByText('Збережено.')).toBeInTheDocument();
});
it('shows read failures instead of pretending that memory is empty', async () => {
  mocks.fetch.mockRejectedValue(new Error('Не вдалося завантажити пам’ять.'));
  open();
  expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося завантажити');
  expect(screen.queryByText('На цій сторінці немає персональних фактів.')).not.toBeInTheDocument();
});

it('edits a semantic record in a stable modal without writing until save', async () => {
  const data = workspace();
  data.entries[0] = {
    ...data.entries[0]!,
    id: 'vehicle:example',
    label: 'Ціль',
    value: {
      schemaVersion: 2,
      type: 'aspiration',
      domain: 'transport',
      subject: 'Приклад авто',
      relation: 'wants',
    },
    text: 'Хочу: Приклад авто',
  };
  mocks.fetch.mockResolvedValue(data);
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Змінити' }));
  expect(screen.getByRole('dialog', { name: 'Редагування пам’яті' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Тип запису'), { target: { value: 'preference' } });
  expect(screen.getByLabelText('Зв’язок із записом')).toHaveValue('likes');
  expect(mocks.change).not.toHaveBeenCalled();
  mocks.change.mockResolvedValue({ message: 'Збережено.', snapshot: data });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти факт' }));
  await waitFor(() =>
    expect(mocks.change).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          type: 'preference',
          relation: 'likes',
          subject: 'Приклад авто',
        }),
      }),
      expect.anything(),
    ),
  );
});
