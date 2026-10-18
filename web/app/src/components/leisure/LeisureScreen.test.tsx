import type { LeisureWorkspace } from '../../api/leisure.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resetLeisureDemo } from '../../api/leisure-demo.ts';
import * as demoApi from '../../api/leisure-demo.ts';
import { LeisureScreen } from './LeisureScreen.tsx';
import {
  fetchLeisure,
  fromKyivInput,
  leisureWorkspaceSchema,
  toKyivInput,
  LeisureSaveUncertainError,
} from '../../api/leisure.ts';

vi.mock('../../telegram.ts', () => ({
  inTelegram: () => false,
  tg: null,
  openLink: vi.fn(),
  haptic: vi.fn(),
  setVerticalSwipes: vi.fn(),
}));
beforeEach(() => {
  resetLeisureDemo();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());
async function setup(initialEntry = '/') {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const data = await fetchLeisure();
  cache.setQueryData(['leisure'], data);
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LeisureScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { cache, data };
}
function openFirst() {
  fireEvent.click(screen.getAllByRole('button', { name: /Деталі/ })[0]!);
  fireEvent.click(screen.getByText('Мій досвід і вибір'));
}
describe('leisure mobile interactions', () => {
  it('opens the whole description and available facts by tapping the discovery card', async () => {
    const { cache, data } = await setup();
    const item = data.items[0]!;
    await act(async () =>
      cache.setQueryData(['leisure'], {
        ...data,
        items: data.items.map((i) =>
          i.id === item.id
            ? {
                ...i,
                summary: 'Повний опис виставки, який доступний у джерелі для обдуманого вибору.',
                genre: 'Сучасне мистецтво',
                age: '16+',
                endAt: '2026-10-25T18:00:00.000Z',
                price: { ...i.price, min: 100, max: 300, basis: 'person' },
              }
            : i,
        ),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Картка дозвілля' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('heading', { name: item.title })).toBeInTheDocument();
    expect(
      dialog.getByText('Повний опис виставки, який доступний у джерелі для обдуманого вибору.'),
    ).toBeInTheDocument();
    expect(dialog.getByText('Жанр: Сучасне мистецтво')).toBeInTheDocument();
    expect(dialog.getByText('Вікова категорія: 16+')).toBeInTheDocument();
    expect(dialog.getByText(/Діапазон ціни за двох: 200 ₴ — 600 ₴/)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: /Джерело:/ })).toBeInTheDocument();
    expect((cache.getQueryData(['leisure']) as LeisureWorkspace).records).toHaveLength(0);
  });
  it('opens a saved card from its main area while the bookmark button remains a separate action', async () => {
    const { cache, data } = await setup();
    await act(async () => cache.setQueryData(['leisure'], { ...data, saved: [data.items[0]!.id] }));
    fireEvent.click(screen.getByRole('button', { name: 'Цікаве' }));
    fireEvent.click(screen.getByRole('button', { name: `Деталі: ${data.items[0]!.title}` }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Закрити вікно дозвілля' }));
    fireEvent.click(
      screen.getByRole('button', { name: `Прибрати ${data.items[0]!.title} зі збереженого` }),
    );
    await waitFor(() =>
      expect((cache.getQueryData(['leisure']) as LeisureWorkspace).saved).toEqual([]),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('moves a right choice into Interesting and keeps it separate from bookmarks and plans', async () => {
    const { cache, data } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Цікаво' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: data.items[0]!.title })).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Цікаве' }));
    expect(screen.getByRole('heading', { name: data.items[0]!.title })).toBeInTheDocument();
    expect((cache.getQueryData(['leisure']) as LeisureWorkspace).saved).toEqual([]);
    fireEvent.click(screen.getByLabelText('Лише закладки'));
    expect(screen.queryByRole('heading', { name: data.items[0]!.title })).not.toBeInTheDocument();
  });
  it('shows old movie impressions in searchable history and edits the saved review instead of duplicating it', async () => {
    const seed = await fetchLeisure(),
      movie = seed.items.find((i) => i.category === 'cinema')!;
    const date = toKyivInput(new Date().toISOString()).slice(0, 10);
    await demoApi.changeLeisureDemo({
      op: 'visit',
      id: movie.id,
      commandId: 'existing-review',
      payload: { visitedOn: date, rating: 'liked', reason: 'Обожнюю Marvel' },
    });
    const { cache } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Історія' }));
    expect(screen.getByText('Обожнюю Marvel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Пошук і фільтри' }));
    fireEvent.change(screen.getByLabelText('Пошук'), { target: { value: 'Marvel' } });
    expect(screen.getByRole('heading', { name: movie.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити місце' }));
    fireEvent.click(screen.getByText('Мій досвід і вибір'));
    fireEvent.click(screen.getByRole('button', { name: 'Записати перегляд' }));
    expect(screen.getByRole('button', { name: 'Зберегти відвідування' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Доповнити збережений відгук' }));
    expect(screen.getByLabelText('Що варто врахувати наступного разу? Необов’язково')).toHaveValue(
      'Обожнюю Marvel',
    );
    fireEvent.change(screen.getByLabelText('Що варто врахувати наступного разу? Необов’язково'), {
      target: { value: 'Обожнюю Marvel. Чудова історія.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Оновити враження' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const records = (cache.getQueryData(['leisure']) as LeisureWorkspace).records.filter(
      (r) => r.kind === 'visit',
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe('Обожнюю Marvel. Чудова історія.');
  });
  it('recovers the same uncertain command after a reload before allowing another choice', async () => {
    const original = demoApi.changeLeisureDemo;
    const spy = vi
      .spyOn(demoApi, 'changeLeisureDemo')
      .mockRejectedValueOnce(new LeisureSaveUncertainError())
      .mockImplementation(original);
    const first = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Цікаво' }));
    await screen.findByRole('button', { name: 'Перевірити збереження' });
    expect(screen.getByRole('button', { name: 'Цікаво' })).toBeDisabled();
    const command = spy.mock.calls[0]![0];
    first.cache.clear();
    // Simulate reopening the screen while session storage retains the pending action.
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити збереження' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Перевірити збереження' }),
      ).not.toBeInTheDocument(),
    );
    expect(spy.mock.calls[1]![0]).toEqual(command);
    expect(sessionStorage.getItem('svitanok-leisure-pending-v1')).toBeNull();
  });
  it('asks why first, hides only after confirmation and closes the detail sheet', async () => {
    const { cache } = await setup();
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Нецікаво' }));
    expect(screen.getByRole('heading', { name: 'Чому нецікаво?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Підтвердити й прибрати' })).toBeDisabled();
    expect((cache.getQueryData(['leisure']) as LeisureWorkspace).records).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Жанр' }));
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й прибрати' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((cache.getQueryData(['leisure']) as LeisureWorkspace).records[0]).toMatchObject({
      verdict: 'uninterested',
      reasonCode: 'genre',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати вибір' }));
    await waitFor(() =>
      expect(
        (cache.getQueryData(['leisure']) as LeisureWorkspace).records.find(
          (r) => r.kind === 'reaction',
        )?.verdict,
      ).toBe('clear'),
    );
  });
  it('closes and hides a not-this-week choice without recording a dislike', async () => {
    const { cache } = await setup();
    openFirst();
    const title = screen.getByRole('dialog').querySelector('h2')?.textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Нецікаво' }));
    fireEvent.click(screen.getByRole('button', { name: 'Не на цей тиждень' }));
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й прибрати' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((cache.getQueryData(['leisure']) as LeisureWorkspace).records[0]).toMatchObject({
      verdict: 'later',
    });
    if (title) expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
  });
  it('uses Interesting as its own learning signal without implicitly saving or planning', async () => {
    const { cache } = await setup();
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Цікаво' }));
    await screen.findByRole('button', { name: 'Цікаво ✓' });
    const data = cache.getQueryData(['leisure']) as LeisureWorkspace;
    expect(data.saved).toEqual([]);
    expect(data.records[0]).toMatchObject({ verdict: 'interested' });
    expect(data.records.some((r) => r.kind === 'plan')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Цікаво ✓' }));
    await screen.findByRole('button', { name: 'Цікаво' });
  });
  it('records a frequent earlier-place baseline without inventing individual visits', async () => {
    const { cache } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Заклади' }));
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Були тут раніше' }));
    fireEvent.click(screen.getByRole('button', { name: 'Були багато разів' }));
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти попередній досвід' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const data = cache.getQueryData(['leisure']) as LeisureWorkspace;
    expect(data.records.some((r) => r.kind === 'visit')).toBe(false);
    expect(data.records[0]).toMatchObject({
      kind: 'familiarity',
      mode: 'many',
      previousCount: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Історія' }));
    expect(screen.getByText(/Бували багато разів/)).toBeInTheDocument();
  });
  it('uses reservation confirmation for a restaurant without asking about tickets', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Заклади' }));
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Додати до плану вечора' }));
    fireEvent.click(screen.getByRole('button', { name: 'Далі: час і бронювання' }));
    expect(screen.getByLabelText('Бронювання підтверджено')).toBeInTheDocument();
    expect(screen.queryByLabelText('Квитки / реєстрацію підтверджено')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Початок')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Завершення')).toHaveAttribute('type', 'datetime-local');
  });
  it('requires fresh calendar approval after changing the composition of a plan', async () => {
    const { data } = await setup();
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Додати до плану вечора' }));
    if (screen.queryByRole('button', { name: 'Далі: час і бронювання' }))
      fireEvent.click(screen.getByRole('button', { name: 'Далі: час і бронювання' }));
    if (screen.queryByRole('button', { name: 'Далі: перевірка' }))
      fireEvent.click(screen.getByRole('button', { name: 'Далі: перевірка' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити календар' }));
    const approval = await screen.findByLabelText(/Погоджую збереження без перевірки накладок/);
    fireEvent.click(approval);
    expect(approval).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '1. Вибір' }));
    fireEvent.change(screen.getByLabelText('Додати місце або подію'), {
      target: { value: data.items.find((i) => i.category === 'food')!.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Додати пункт' }));
    if (screen.queryByRole('button', { name: 'Далі: час і бронювання' }))
      fireEvent.click(screen.getByRole('button', { name: 'Далі: час і бронювання' }));
    if (screen.queryByRole('button', { name: 'Далі: перевірка' }))
      fireEvent.click(screen.getByRole('button', { name: 'Далі: перевірка' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити календар' }));
    expect(
      await screen.findByLabelText(/Погоджую збереження без перевірки накладок/),
    ).not.toBeChecked();
  });
  it('discards a calendar response for an older time when inputs change during the request', async () => {
    await setup();
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Додати до плану вечора' }));
    if (screen.queryByRole('button', { name: 'Далі: час і бронювання' }))
      fireEvent.click(screen.getByRole('button', { name: 'Далі: час і бронювання' }));
    if (screen.queryByRole('button', { name: 'Далі: перевірка' }))
      fireEvent.click(screen.getByRole('button', { name: 'Далі: перевірка' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перевірити календар' }));
    fireEvent.change(screen.getByLabelText('Початок'), { target: { value: '2026-10-15T19:00' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      screen.queryByLabelText(/Погоджую збереження без перевірки накладок/),
    ).not.toBeInTheDocument();
  });
  it('keeps unsaved form edits when the shared workspace refetches', async () => {
    const { cache, data } = await setup();
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Додати до плану вечора' }));
    const input = screen.getByLabelText('Назва');
    fireEvent.change(input, { target: { value: 'Наше побачення' } });
    await act(async () => {
      cache.setQueryData(['leisure'], { ...data, generatedAt: new Date().toISOString() });
    });
    expect(screen.getByLabelText('Назва')).toHaveValue('Наше побачення');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('does not publish an invented cinema session in demo mode', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Кіно' }));
    openFirst();
    expect(
      within(screen.getByRole('dialog')).queryByRole('button', { name: 'Запланувати' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/На цей вибір сеансів не підтверджено/)).toBeInTheDocument();
  });
  it('records an unknown-date visit and permits another visit to the same venue', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Заклади' }));
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Записати відвідування' }));
    fireEvent.change(screen.getByLabelText('Коли були? Необов’язково'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти відвідування' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Історія' }));
    expect(screen.getByText('Дата невідома · Без оцінки')).toBeInTheDocument();
  });
  it('handles dates in Kyiv and rejects nonexistent daylight-saving times', () => {
    expect(fromKyivInput('2026-10-12T18:00')).toBe('2026-10-12T15:00:00.000Z');
    expect(toKyivInput('2026-10-11T22:30:00Z')).toBe('2026-10-12T01:30');
    expect(() => fromKyivInput('2026-03-29T03:30')).toThrow('не існує');
  });
  it('validates the actual demo payload against the same schema as production', async () => {
    expect(leisureWorkspaceSchema.safeParse(await fetchLeisure()).success).toBe(true);
  });
});

it('opens settings from the central settings link and removes the action when closed', async () => {
  await setup('/leisure?action=settings');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Зберегти налаштування' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Закрити вікно дозвілля' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
