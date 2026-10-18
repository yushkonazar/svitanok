import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { OperationsPanel, CredentialEditor } from './OperationsPanel.tsx';
import type { Credentials } from '../../api/credentials-schema.ts';
const mocks = vi.hoisted(() => ({ private: true, fetch: vi.fn(), save: vi.fn() }));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => mocks.private }));
vi.mock('../../api/client.ts', () => ({
  fetchCredentials: mocks.fetch,
  saveCredentialMetadata: mocks.save,
}));
const value = (): Credentials => ({
  available: true,
  entries: [
    {
      id: 'OPENAI_API_KEY:vps',
      name: 'OPENAI_API_KEY',
      label: 'OpenAI',
      location: 'vps',
      legacy: false,
      configured: null,
      recommendedRotationDays: 365,
      version: 0,
      rotatedAt: null,
      expiresAt: null,
      rotateAfterDays: null,
      legacyRotationAt: null,
      expiryDaysLeft: null,
      rotationDaysLeft: null,
    },
  ],
  google: {
    configured: true,
    known: true,
    verified: true,
    ok: true,
    checkedAt: '2026-10-11T07:00:00Z',
    missing: [],
    extra: [],
    redundant: [],
    features: { calendar_read: true, calendar: false },
  },
});
let qc: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.private = true;
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.fetch.mockResolvedValue(value());
});
afterEach(() => {
  cleanup();
  qc.clear();
});
const open = () =>
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings?panel=access']}>
        <OperationsPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
it('never reads private metadata or pretends to save in public demo', () => {
  mocks.private = false;
  open();
  expect(screen.getByText(/не в демо/)).toBeInTheDocument();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it('shows read/write permissions separately and unknown dates without an expiry alarm', async () => {
  open();
  expect(await screen.findByText('Читати календар: є дозвіл')).toBeInTheDocument();
  expect(screen.getByText('Змінювати події: немає дозволу')).toBeInTheDocument();
  expect(screen.getByText('Строк дії не вказано — це не помилка.')).toBeInTheDocument();
  expect(screen.queryByText(/прострочен|ключ закінчується/i)).not.toBeInTheDocument();
});
it('does not silently enable a 365-day policy; saves only explicit metadata with a pending state', async () => {
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Вказати дати' }));
  expect(screen.getByRole('combobox', { name: 'Нагадування про ротацію' })).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Строк дії у провайдера'), {
    target: { value: '2026-11-20' },
  });
  let resolve!: (data: Credentials) => void;
  mocks.save.mockImplementation(
    () =>
      new Promise<Credentials>((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти дати' }));
  expect(await screen.findByRole('button', { name: 'Зберігаю…' })).toBeDisabled();
  expect(mocks.save).toHaveBeenCalledWith(
    {
      id: 'OPENAI_API_KEY:vps',
      version: 0,
      rotatedAt: null,
      expiresAt: '2026-11-20',
      expiryKind: 'date',
      rotateAfterDays: null,
    },
    expect.anything(),
  );
  const data = value();
  data.entries[0]!.expiresAt = '2026-11-20';
  data.entries[0]!.version = 1;
  await act(async () => resolve(data));
  expect(await screen.findByText('Дати збережено. Сам ключ не змінено.')).toBeInTheDocument();
  expect(screen.getByText('Строк дії: 2026-11-20')).toBeInTheDocument();
});
it('retains edited dates after a failed save and never shows a success receipt', async () => {
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Вказати дати' }));
  fireEvent.change(screen.getByLabelText('Останнє оновлення'), { target: { value: '2026-10-01' } });
  mocks.save.mockRejectedValue(new Error('Дані змінилися. Онови реєстр.'));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти дати' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Дані змінилися');
  expect(screen.getByLabelText('Останнє оновлення')).toHaveValue('2026-10-01');
  expect(screen.queryByText('Дати збережено. Сам ключ не змінено.')).not.toBeInTheDocument();
});
it('requires review after another editor changes the version, without clearing the local draft', () => {
  const row = value().entries[0]!;
  const save = vi.fn();
  const view = render(
    <CredentialEditor entry={row} pending={false} onSave={save} onCancel={() => {}} />,
  );
  fireEvent.change(screen.getByLabelText('Строк дії у провайдера'), {
    target: { value: '2026-11-20' },
  });
  view.rerender(
    <CredentialEditor
      entry={{ ...row, version: 1, expiresAt: '2026-12-20' }}
      pending={false}
      onSave={save}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Дані змінилися');
  expect(screen.getByLabelText('Строк дії у провайдера')).toHaveValue('2026-11-20');
  expect(screen.getByRole('button', { name: 'Зберегти дати' })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
});
it('records non-expiry only after the owner explicitly selects it, independently of rotation', () => {
  const entry = { ...value().entries[0]!, expiresAt: '2026-11-20' };
  const save = vi.fn();
  render(<CredentialEditor entry={entry} pending={false} onSave={save} onCancel={() => {}} />);
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Провайдер підтвердив, що строк дії не обмежений' }),
  );
  expect(screen.getByLabelText('Строк дії у провайдера')).toBeDisabled();
  expect(screen.getByLabelText('Строк дії у провайдера')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти дати' }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ expiresAt: null, expiryKind: 'non-expiring', rotateAfterDays: null }),
  );
});
it('shows an honest read failure and retry instead of an empty healthy inventory', async () => {
  mocks.fetch.mockRejectedValue(new Error('Не вдалося завантажити реєстр доступів.'));
  open();
  expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося завантажити');
  mocks.fetch.mockResolvedValue(value());
  fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
  await waitFor(() => expect(screen.getByText('OpenAI · VPS')).toBeInTheDocument());
});
