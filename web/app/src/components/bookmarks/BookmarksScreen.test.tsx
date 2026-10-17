import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BookmarksScreen } from './BookmarksScreen.tsx';
import {
  changeBookmark,
  fetchBookmark,
  fetchBookmarks,
  readPendingBookmark,
  type BookmarkCommand,
  type BookmarkDetail,
} from '../../api/bookmarks.ts';
import { resetBookmarkDemo } from '../../api/bookmarks-demo.ts';

const telegram = vi.hoisted(() => ({ live: false }));
vi.mock('../../telegram.ts', () => ({
  inTelegram: () => telegram.live,
  tg: { initData: 'local-signed-session' },
  haptic: vi.fn(),
}));
const clients: QueryClient[] = [];
function setup(path = '/bookmarks') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <BookmarksScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, user: userEvent.setup() };
}
const c = (op: string, payload: Record<string, unknown> = {}, extra = {}): BookmarkCommand => ({
  op,
  commandId: crypto.randomUUID(),
  payload,
  ...extra,
});
function fixture(): BookmarkDetail {
  const item = {
    id: 'idea-local',
    number: 7,
    title: 'Майбутні платежі у винагородах',
    body: 'Хочу бачити умови покупки.',
    area: 'plan',
    kind: 'improvement',
    status: 'план готовий',
    priority: 2,
    version: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64),
    createdAt: '2026-10-17T10:00:00Z',
    updatedAt: '2026-10-17T10:00:00Z',
    analysis: 'Аналіз',
    plan: 'План',
  };
  return {
    item,
    historyCursor: null,
    formulations: [
      {
        id: 'formulation-local',
        ideaId: item.id,
        sourceHash: item.sourceHash,
        status: 'ready',
        contextVersion: '0.14.0',
        createdAt: item.createdAt,
        finishedAt: item.updatedAt,
        error: null,
        revision: 1,
        published: true,
        source: { title: item.title, body: item.body },
        prompt: 'Початковий запис. Конкретні критерії готовності.',
        customPrompt: false,
        result: {
          title: 'Умови покупки поруч із винагородою',
          problem: 'Платежі складно врахувати.',
          outcome: 'Видно доступність покупки.',
          userFlow: ['Відкрити винагороду'],
          minimumScope: ['Використати спільне джерело фінансів'],
          futureScope: [],
          integrations: ['План і фінанси'],
          implementation: ['Перевірити актуальний код'],
          acceptance: ['Невідомі дані не показані як достатні'],
          risks: [],
          questions: ['Який запас залишати?'],
        },
      },
    ],
  };
}
function live(
  detail = fixture(),
  post?: (command: BookmarkCommand) => Response | Promise<Response>,
) {
  telegram.live = true;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST')
      return post ? post(JSON.parse(String(init.body))) : new Response('{}', { status: 500 });
    const params = new URL(String(input), 'https://local.test').searchParams;
    return new Response(
      JSON.stringify(
        params.has('id')
          ? { ok: true, ...detail }
          : { ok: true, items: [detail.item], cursor: null, context: '0.14.0' },
      ),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => {
  telegram.live = false;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  resetBookmarkDemo();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('personal bookmark journey', () => {
  it('retains an unfinished quick note after closing and saves/edits it without mandatory metadata', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: '＋ Додати закладку' }));
    await user.type(
      screen.getByLabelText('Суть ідеї або проблеми'),
      'Додати зрозумілий прогноз доходу',
    );
    await user.click(screen.getByRole('button', { name: 'Закрити закладку ×' }));
    await user.click(screen.getByRole('button', { name: '＋ Додати закладку' }));
    expect(screen.getByLabelText('Суть ідеї або проблеми')).toHaveValue(
      'Додати зрозумілий прогноз доходу',
    );
    await user.click(screen.getByRole('button', { name: 'Зберегти закладку' }));
    await screen.findByRole('heading', { name: 'Додати зрозумілий прогноз доходу', level: 2 });
    expect((await fetchBookmarks()).items).toHaveLength(1);
    await user.click(await screen.findByRole('button', { name: 'Уточнити запис' }));
    await user.type(screen.getByLabelText('Суть ідеї або проблеми'), ' до перезмінки');
    await user.click(screen.getByRole('button', { name: 'Зберегти закладку' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('Суть ідеї або проблеми')).not.toBeInTheDocument(),
    );
    expect((await fetchBookmarks()).items[0]!.body).toContain('до перезмінки');
    expect(screen.getByRole('link', { name: 'Збережені матеріали ↗' })).toHaveAttribute(
      'href',
      '/saved',
    );
    await user.click(screen.getByRole('button', { name: '✧ Сформувати з помічником' }));
    expect(
      (await screen.findAllByRole('alert')).some((el) =>
        el.textContent?.includes('Telegram-сесії'),
      ),
    ).toBe(true);
  });
  it('filters completed notes and reports a clipboard failure without claiming success', async () => {
    const write = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    const { user } = setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: write },
    });
    await user.click(screen.getByRole('button', { name: '＋ Додати закладку' }));
    await user.type(screen.getByLabelText('Суть ідеї або проблеми'), 'Поліпшити пошук');
    await user.click(screen.getByRole('button', { name: 'Зберегти закладку' }));
    await user.click(await screen.findByRole('button', { name: 'Копіювати запис' }));
    expect(await screen.findByText(/Автокопіювання недоступне/)).toBeInTheDocument();
    expect(screen.queryByText('Початковий запис скопійовано.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Початковий текст для копіювання')).toHaveValue(
      'Поліпшити пошук\n\nПоліпшити пошук',
    );
    await user.selectOptions(screen.getByLabelText('Статус запису'), 'зроблено');
    await user.click(screen.getByRole('button', { name: 'Закрити закладку ×' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /#1 ·/ })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Усі' }));
    expect(await screen.findByRole('button', { name: /#1 ·/ })).toBeInTheDocument();
  });
  it('copies a formed GPT prompt, preserves local refinements after reopening and shows the source version', async () => {
    const detail = fixture();
    detail.formulations[0]!.sourceHash = 'old-source';
    live(detail);
    const view = setup('/bookmarks?idea=idea-local');
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: write },
    });
    await view.user.click(await screen.findByRole('button', { name: 'Копіювати для GPT' }));
    expect(write).toHaveBeenCalledWith(detail.formulations[0]!.prompt);
    expect(screen.getByText(/Цю версію сформовано з попереднього тексту/)).toBeInTheDocument();
    await view.user.click(
      screen.getByRole('button', { name: 'Переглянути й відредагувати запит' }),
    );
    await view.user.type(screen.getByLabelText('Текст для GPT'), ' Моє уточнення.');
    view.unmount();
    setup('/bookmarks?idea=idea-local');
    await screen.findByRole('button', { name: 'Переглянути й відредагувати запит' });
    await view.user.click(
      screen.getByRole('button', { name: 'Переглянути й відредагувати запит' }),
    );
    expect(screen.getByLabelText('Текст для GPT')).toHaveValue(
      detail.formulations[0]!.prompt + ' Моє уточнення.',
    );
    expect(screen.getByText('Початковий запис цієї версії')).toBeInTheDocument();
  });
  it('retains the exact failed request and offers recovery inside the open editor', async () => {
    let saved: BookmarkCommand | undefined;
    const detail = fixture();
    live(detail, (command) => {
      if (!saved) {
        saved = command;
        throw new TypeError('lost acknowledgement');
      }
      expect(command).toEqual(saved);
      return new Response(
        JSON.stringify({
          ok: true,
          receipt: { id: detail.item.id, message: 'Закладку збережено.', formulationId: null },
          ...detail,
        }),
      );
    });
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: '＋ Додати закладку' }));
    await user.type(screen.getByLabelText('Суть ідеї або проблеми'), 'Мій новий запис');
    await user.click(screen.getByRole('button', { name: 'Зберегти закладку' }));
    const dialog = screen.getByRole('dialog');
    await user.click(
      await within(dialog).findByRole('button', { name: 'Перевірити останній запис' }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Суть ідеї або проблеми')).not.toBeInTheDocument(),
    );
    expect(readPendingBookmark()).toBeNull();
  });
  it('keeps owner edits when the assistant changed the shared source and requires an explicit new base', async () => {
    const detail = fixture();
    let attempts = 0;
    live(detail, (command) => {
      attempts++;
      if (attempts === 1) {
        detail.item = { ...detail.item, body: 'Новий текст асистента', version: 'c'.repeat(64) };
        return new Response(JSON.stringify({ error: 'Запис уже змінився.' }), { status: 409 });
      }
      expect(command.version).toBe(detail.item.version);
      detail.item = { ...detail.item, body: String(command.payload.body) };
      return new Response(
        JSON.stringify({
          ok: true,
          receipt: { id: detail.item.id, message: 'Збережено', formulationId: null },
          ...detail,
        }),
      );
    });
    const { user } = setup('/bookmarks?idea=idea-local');
    await user.click(await screen.findByRole('button', { name: 'Уточнити запис' }));
    await user.type(screen.getByLabelText('Суть ідеї або проблеми'), ' Моє уточнення');
    await user.click(screen.getByRole('button', { name: 'Зберегти закладку' }));
    expect(
      await screen.findByText('Запис змінився в іншому місці. Твої уточнення залишилися у формі.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Суть ідеї або проблеми')).toHaveValue(
      'Хочу бачити умови покупки. Моє уточнення',
    );
    await waitFor(() =>
      expect(screen.getAllByText('Новий текст асистента').length).toBeGreaterThan(0),
    );
    await user.click(
      screen.getByRole('button', { name: 'Використати актуальну версію як основу' }),
    );
    await user.click(screen.getByRole('button', { name: 'Зберегти закладку' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(readPendingBookmark()).toBeNull();
  });
  it('shows background processing and loads older versions without a second formulation request', async () => {
    const detail = fixture();
    detail.formulations[0]!.status = 'running';
    detail.formulations[0]!.result = null;
    detail.historyCursor = 'older-cursor';
    const fetcher = live(detail);
    const { user } = setup('/bookmarks?idea=idea-local');
    expect(await screen.findByText('Формую пропозицію')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '✧ Сформувати з помічником' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Раніші версії' }));
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('before=older-cursor'))).toBe(
      true,
    );
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('opens manual selection when copying the generated prompt fails', async () => {
    live();
    const { user } = setup('/bookmarks?idea=idea-local');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    await user.click(await screen.findByRole('button', { name: 'Копіювати для GPT' }));
    expect(
      await screen.findByText('Текст відкрито нижче. Виділи його й скопіюй вручну.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Текст для GPT')).toHaveValue(fixture().formulations[0]!.prompt);
  });
});

describe('acknowledgement and session handling', () => {
  it.each(['network', 'invalid-json', 'invalid-success', 'missing-receipt', 'server'])(
    'retains the same command for an uncertain %s response',
    async (failure) => {
      telegram.live = true;
      const fetcher = vi.fn().mockImplementation(() => {
        if (failure === 'network') return Promise.reject(new Error('offline'));
        return Promise.resolve(
          new Response(
            failure === 'invalid-json'
              ? '<html>'
              : JSON.stringify(failure === 'invalid-success' ? { ok: false } : { ok: true }),
            { status: failure === 'server' ? 503 : 200 },
          ),
        );
      });
      vi.stubGlobal('fetch', fetcher);
      const command = c('create', { body: 'Особиста думка' });
      await expect(changeBookmark(command)).rejects.toMatchObject({ status: 503 });
      expect(readPendingBookmark()).toEqual(command);
      await expect(changeBookmark(c('create', { body: 'Інше' }))).rejects.toMatchObject({
        status: 409,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              ok: true,
              receipt: { id: 'confirmed', message: 'Збережено', formulationId: null },
              refreshRequired: true,
            }),
          ),
        ),
      );
      const result = await changeBookmark(command);
      expect(result).toMatchObject({ detail: null, receipt: { id: 'confirmed' } });
      expect(readPendingBookmark()).toBeNull();
    },
  );
  it('clears a known rejected command and never switches an expired owner session to demo', async () => {
    telegram.live = true;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: 'Конфлікт' }), { status: 409 })),
    );
    await expect(changeBookmark(c('create', { body: 'Текст' }))).rejects.toMatchObject({
      status: 409,
    });
    expect(readPendingBookmark()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(fetchBookmark('id')).rejects.toMatchObject({ status: 401 });
    setup();
    expect(await screen.findByRole('heading', { name: 'Сесію завершено' })).toBeInTheDocument();
    expect(screen.queryByText(/Демо на цьому пристрої/)).not.toBeInTheDocument();
  });
});
