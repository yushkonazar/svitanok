import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/* Оптимістичні апдейти й відкати (C2).
 *
 * ⚠️ НАВІЩО ЦЕЙ ФАЙЛ. hooks.ts — найбагонебезпечніший код застосунку, і обидва
 * реальні баги тут знайшло ВИКОРИСТАННЯ, не тест:
 *
 *   1. snapshotSaved скасовує ОБИДВІ черги. Без cancelQueries по ['saved']
 *      запит, що вже в польоті, приземлявся ПІСЛЯ оптимістичного патча й
 *      ВОСКРЕШАВ видалений рядок.
 *   2. dropFromSaved повертає boolean. savedList — це лише прев'ю з восьми
 *      записів, тож «його там немає» НЕ означає «його немає взагалі»: брехня
 *      про видалення неправильно зменшувала лічильник.
 *
 * Обидва — не про рендер, а про порядок операцій над кешем, тож і перевіряються
 * через справжній QueryClient, а не через компоненти.
 */

const client = vi.hoisted(() => ({
  fetchStats: vi.fn(),
  fetchArchive: vi.fn(),
  fetchBriefing: vi.fn(),
  fetchLiveWeather: vi.fn(),
  fetchSettings: vi.fn(),
  fetchSaved: vi.fn(),
  fetchSettlements: vi.fn(),
  postEvent: vi.fn(),
  postSettings: vi.fn(),
  postVote: vi.fn(),
  setWeatherLocation: vi.fn(),
  setWeatherLocationExact: vi.fn(),
  clearWeatherLocation: vi.fn(),
  requestLocatePrompt: vi.fn(),
}));

const telegram = vi.hoisted(() => ({ inTelegram: vi.fn(() => true) }));

vi.mock('./client.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...client };
});
vi.mock('../telegram.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...telegram };
});

const { EMPTY_STATS } = await import('./sample.ts');
const {
  useMockAnswer,
  useVote,
  useToggleSaveItem,
  useToggleSaveNews,
  useJobStage,
  useJobDismiss,
  useSaveSettings,
  useSaveCheckin,
  useSetGoal,
  useSavedArchive,
} = await import('./hooks.ts');

type Stats = typeof EMPTY_STATS;

let qc: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

/** Кеш ['stats'] із наведеними полями поверх порожнього агрегату. */
function seedStats(patch: Partial<Stats> = {}) {
  qc.setQueryData(['stats'], { stats: { ...EMPTY_STATS, ...patch }, demo: false });
}

const statsNow = () => qc.getQueryData<{ stats: Stats }>(['stats'])!.stats;

/** Кеш ['saved'] у формі infinite-черги. */
function seedSaved(items: { kind: string; id: string; title: string; url: string | null }[]) {
  qc.setQueryData(['saved'], {
    pages: [{ items, total: items.length }],
    pageParams: [0],
  });
}

const savedNow = () =>
  qc.getQueryData<{ pages: ({ items: unknown[]; total: number } | undefined)[] }>(['saved']);

/** Усі записи архіву з усіх сторінок — саме на них дивляться тести видалення. */
const savedItems = () => savedNow()?.pages.flatMap((p) => p?.items ?? []) ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  telegram.inTelegram.mockReturnValue(true);
  client.postEvent.mockResolvedValue(undefined);
  client.postVote.mockResolvedValue(null);
  client.postSettings.mockResolvedValue(null);
  client.fetchStats.mockResolvedValue({ stats: EMPTY_STATS, demo: false });
  // ⚠️ gcTime: Infinity — не смак. Дані, покладені через setQueryData у чергу
  // БЕЗ спостерігачів, при нульовому gcTime зникають одразу, і тест міряв би
  // збирач сміття замість хука.
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
});

afterEach(() => qc.clear());

describe('useMockAnswer', () => {
  it('оптимістично позначає день оціненим і запамʼятовує оцінку', async () => {
    seedStats({ mockRatedToday: false, mockRated: {} });
    const { result } = renderHook(() => useMockAnswer(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ qId: 'q1', topic: 'HTTP', rating: 'hard' });
    });

    expect(statsNow().mockRatedToday).toBe(true);
    expect(statsNow().mockRated).toMatchObject({ q1: 'hard' });
  });

  it('відкочує кеш, коли запит упав', async () => {
    seedStats({ mockRatedToday: false, mockRated: {} });
    client.postEvent.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useMockAnswer(), { wrapper });

    await act(async () => {
      await result.current
        .mutateAsync({ qId: 'q1', topic: 'HTTP', rating: 'hard' })
        .catch(() => {});
    });

    expect(statsNow().mockRatedToday).toBe(false);
    expect(statsNow().mockRated).toEqual({});
  });
});

describe('useVote — тогл ❤️', () => {
  const vote = async (votes: Stats['votes']) => {
    seedStats({ votes });
    const { result } = renderHook(() => useVote(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ category: 'Технології', url: 'u1' });
    });
    return statsNow().votes;
  };

  it('не голосовано -> лайк', async () => {
    expect(await vote({})).toMatchObject({ u1: 'up' });
  });

  it('лайкнуте -> знімається', async () => {
    expect(await vote({ u1: 'up' })).not.toHaveProperty('u1');
  });

  it('легасі-"down" -> лайк, а не другий дизлайк', async () => {
    // Дизлайків більше немає, але старі записи в KV лишились. Гілка існує саме
    // для них: без неї тап по такій новині не робив би нічого видимого.
    expect(await vote({ u1: 'down' })).toMatchObject({ u1: 'up' });
  });

  it('у Telegram авторитетним є voted СЕРВЕРА, а не наш здогад', async () => {
    seedStats({ votes: {} });
    client.postVote.mockResolvedValueOnce({ voted: null });
    const { result } = renderHook(() => useVote(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ category: 'Технології', url: 'u1' });
    });

    // Оптимістично поставили 'up', сервер сказав «не голосовано» — виграє сервер.
    expect(statsNow().votes).not.toHaveProperty('u1');
  });

  it('у демо (postVote -> null) лишається оптимістичне значення', async () => {
    seedStats({ votes: {} });
    telegram.inTelegram.mockReturnValue(false);
    const { result } = renderHook(() => useVote(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ category: 'Технології', url: 'u1' });
    });

    expect(statsNow().votes).toMatchObject({ u1: 'up' });
  });
});

describe('useToggleSaveItem — лічильник і прев’ю', () => {
  const item = { kind: 'fact', id: 'f1', title: 'Факт' };

  it('збереження додає в прев’ю й піднімає лічильник', async () => {
    seedStats({ savedCount: 0, savedList: [] });
    const { result } = renderHook(() => useToggleSaveItem(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ save: true, ...item });
    });

    expect(statsNow().savedCount).toBe(1);
    expect(statsNow().savedList[0]).toMatchObject({ kind: 'fact', id: 'f1' });
  });

  it('повторне збереження того самого НЕ дублює й не накручує лічильник', async () => {
    seedStats({
      savedCount: 1,
      savedList: [{ kind: 'fact', id: 'f1', title: 'Факт', url: null, ts: '' }],
    });
    const { result } = renderHook(() => useToggleSaveItem(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ save: true, ...item });
    });

    expect(statsNow().savedCount).toBe(1);
    expect(statsNow().savedList).toHaveLength(1);
  });

  it('видалення з прев’ю прибирає рядок і зменшує лічильник', async () => {
    seedStats({
      savedCount: 3,
      savedList: [{ kind: 'fact', id: 'f1', title: 'Факт', url: null, ts: '' }],
    });
    const { result } = renderHook(() => useToggleSaveItem(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ save: false, ...item });
    });

    expect(statsNow().savedCount).toBe(2);
    expect(statsNow().savedList).toHaveLength(0);
  });

  /* ⚠️ Регресія, заради якої dropFromSaved повертає boolean. savedList — це
   * top-8 прев'ю: запис із дев'ятої позиції в ньому НЕ лежить, але існує. Якби
   * лічильник дивився лише на прев'ю, видалення з екрана «Збережене» його б не
   * зменшувало взагалі. */
  it('видалення запису, якого НЕМА в прев’ю, але є в архіві — лічильник спадає', async () => {
    seedStats({ savedCount: 9, savedList: [] });
    seedSaved([{ kind: 'fact', id: 'f1', title: 'Факт', url: null }]);
    const { result } = renderHook(() => useToggleSaveItem(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ save: false, ...item });
    });

    expect(statsNow().savedCount).toBe(8);
    expect(savedNow()!.pages[0]!.items).toHaveLength(0);
    expect(savedNow()!.pages[0]!.total).toBe(0);
  });

  /* Дзеркальна половина того самого правила: якщо запису немає НІДЕ, лічильник
   * чіпати не можна. Інакше повторний тап по вже видаленому «з'їдав» би
   * чужі записи. */
  it('видалення того, чого немає ні в прев’ю, ні в архіві — лічильник не рухається', async () => {
    seedStats({ savedCount: 9, savedList: [] });
    seedSaved([{ kind: 'fact', id: 'other', title: 'Інший', url: null }]);
    const { result } = renderHook(() => useToggleSaveItem(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ save: false, ...item });
    });

    expect(statsNow().savedCount).toBe(9);
  });

  it('збій запиту відкочує ОБИДВІ черги — і агрегат, і архів', async () => {
    seedStats({
      savedCount: 3,
      savedList: [{ kind: 'fact', id: 'f1', title: 'Факт', url: null, ts: '' }],
    });
    seedSaved([{ kind: 'fact', id: 'f1', title: 'Факт', url: null }]);
    client.postEvent.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useToggleSaveItem(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ save: false, ...item }).catch(() => {});
    });

    expect(statsNow().savedCount).toBe(3);
    expect(statsNow().savedList).toHaveLength(1);
    expect(savedNow()!.pages[0]!.items).toHaveLength(1);
  });
});

/* ⚠️ ГОЛОВНИЙ тест файлу: запит ['saved'], що вже в польоті, не має воскресити
 * щойно видалений рядок. Саме це закриває cancelQueries у snapshotSaved.
 *
 * Сценарій відтворює реальний: рядок уже на екрані, фоновий рефетч архіву в
 * дорозі, власник тисне ✕ — і застаріла відповідь приземляється ПІСЛЯ патча.
 *
 * Демо-режим тут НАВМИСНО: у Telegram onSettled інвалідує ['saved'], і чистий
 * рефетч прибрав би рядок сам — тест проходив би навіть із прибраним
 * cancelQueries, тобто доводив би не те. */
describe('snapshotSaved — запит у польоті не воскрешає видалений рядок', () => {
  it('відповідь, що приземлилась ПІСЛЯ видалення, ігнорується', async () => {
    telegram.inTelegram.mockReturnValue(false);
    const row = { kind: 'news', id: 'u1', title: 'Новина', url: 'u1' };
    seedStats({ savedCount: 1, savedList: [] });
    seedSaved([row]);

    // Фоновий рефетч, що зависне до кінця тесту й «оживе» вже після видалення.
    let landStale: (v: { items: unknown[]; total: number }) => void = () => {};
    client.fetchSaved.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landStale = resolve;
        }),
    );

    const { result } = renderHook(
      () => ({ archive: useSavedArchive(), toggle: useToggleSaveNews() }),
      { wrapper },
    );
    await waitFor(() => expect(client.fetchSaved).toHaveBeenCalled());

    await act(async () => {
      await result.current.toggle.mutateAsync({
        save: false,
        url: 'u1',
        title: 'Новина',
        category: 'Технології',
      });
    });
    expect(savedItems()).toHaveLength(0); // оптимістично прибрано

    await act(async () => {
      landStale({ items: [row], total: 1 }); // застаріла відповідь із тим самим рядком
      await Promise.resolve();
    });

    expect(savedItems()).toHaveLength(0);
  });
});

describe('useJobStage', () => {
  const job = { url: 'j1', title: 'Dev' };

  it('нова стадія додає запис і перераховує воронку', async () => {
    seedStats({ funnelList: [], funnel: EMPTY_STATS.funnel });
    const { result } = renderHook(() => useJobStage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ ...job, stage: 'saved' });
    });

    expect(statsNow().funnelList).toHaveLength(1);
    expect(statsNow().funnel.saved).toBe(1);
  });

  it('зберігає ts/title наявного запису — сервер їх не перезаписує', async () => {
    seedStats({
      funnelList: [
        { url: 'j1', stage: 'saved', title: 'Стара назва', ts: '2026-01-02', history: [] },
      ],
      funnel: { ...EMPTY_STATS.funnel, saved: 1 },
    });
    const { result } = renderHook(() => useJobStage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ url: 'j1', title: '', stage: 'applied' });
    });

    const row = statsNow().funnelList[0]!;
    expect(row.ts).toBe('2026-01-02');
    expect(row.title).toBe('Стара назва');
    expect(row.stage).toBe('applied');
  });

  it('журнал росте на РЕАЛЬНІЙ зміні стадії й не росте на повторі', async () => {
    seedStats({
      funnelList: [{ url: 'j1', stage: 'saved', title: 'Dev', ts: '2026-01-02', history: [] }],
      funnel: { ...EMPTY_STATS.funnel, saved: 1 },
    });
    const { result } = renderHook(() => useJobStage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ ...job, stage: 'applied' });
    });
    expect(statsNow().funnelList[0]!.history).toHaveLength(1);

    await act(async () => {
      await result.current.mutateAsync({ ...job, stage: 'applied' });
    });
    expect(statsNow().funnelList[0]!.history).toHaveLength(1);
  });

  it('stage=null прибирає з воронки', async () => {
    seedStats({
      funnelList: [{ url: 'j1', stage: 'saved', title: 'Dev', ts: '', history: [] }],
      funnel: { ...EMPTY_STATS.funnel, saved: 1 },
    });
    const { result } = renderHook(() => useJobStage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ ...job, stage: null });
    });

    expect(statsNow().funnelList).toHaveLength(0);
    expect(statsNow().funnel.saved).toBe(0);
  });
});

describe('useJobDismiss', () => {
  it('додає url один раз, повтор не дублює', async () => {
    seedStats({ dismissedUrls: [] });
    const { result } = renderHook(() => useJobDismiss(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ url: 'j1', title: 'Dev' });
      await result.current.mutateAsync({ url: 'j1', title: 'Dev' });
    });

    expect(statsNow().dismissedUrls).toEqual(['j1']);
  });
});

describe('useSaveSettings', () => {
  const seedSettings = () =>
    qc.setQueryData(['settings'], {
      settings: {
        quiet: { enabled: false, from: '22:00', to: '08:00' },
        modules: {},
        mutedTopics: ['Спорт'],
      },
      connectors: {},
    });

  it('на сервер іде ПОВНИЙ блоб із кешу, а не патч із аргументів', async () => {
    seedSettings();
    const { result } = renderHook(() => useSaveSettings(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ modules: { news: false } });
    });

    // Патч ніс лише modules — у запиті мусить бути весь блоб.
    expect(client.postSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        quiet: expect.objectContaining({ from: '22:00' }),
        modules: { news: false },
        mutedTopics: ['Спорт'],
      }),
    );
  });

  /* ⚠️ Саме через це mutationFn читає КЕШ, а не аргументи: два тапи в одному
   * тіку інакше прочитали б той самий, ще не оновлений стан, і другий запит
   * загубив би перший тумблер. */
  it('два швидкі тапи не губляться — другий запит несе обидва', async () => {
    seedSettings();
    const { result } = renderHook(() => useSaveSettings(), { wrapper });

    await act(async () => {
      await Promise.all([
        result.current.mutateAsync({ modules: { news: false } }),
        result.current.mutateAsync({ modules: { jobs: false } }),
      ]);
    });

    const last = client.postSettings.mock.calls.at(-1)![0] as { modules: Record<string, boolean> };
    expect(last.modules).toEqual({ news: false, jobs: false });
  });

  it('mutedTopics ЗАМІНЮЄТЬСЯ повністю — інакше зняти приглушення неможливо', async () => {
    seedSettings();
    const { result } = renderHook(() => useSaveSettings(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ mutedTopics: [] });
    });

    expect(client.postSettings).toHaveBeenCalledWith(expect.objectContaining({ mutedTopics: [] }));
  });

  it('збій відкочує тумблер', async () => {
    seedSettings();
    client.postSettings.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useSaveSettings(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ modules: { news: false } }).catch(() => {});
    });

    const cur = qc.getQueryData<{ settings: { modules: Record<string, boolean> } }>(['settings'])!;
    expect(cur.settings.modules).toEqual({});
  });
});

describe('useSaveCheckin', () => {
  it('домерджує відповіді в потрібний блок, не затираючи сусідні', async () => {
    seedStats({ checkinToday: { morning: { sleepH: 7 } } as Stats['checkinToday'] });
    const { result } = renderHook(() => useSaveCheckin(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ slot: 'morning', answers: { mood: 4 } });
    });

    expect(statsNow().checkinToday!.morning).toMatchObject({ sleepH: 7, mood: 4 });
  });
});

describe('useSetGoal', () => {
  it('оптимістично оновлює тижневу ціль', async () => {
    seedStats({ goal: { ...EMPTY_STATS.goal, weeklyTarget: 3 } });
    const { result } = renderHook(() => useSetGoal(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ value: 7 });
    });

    expect(statsNow().goal.weeklyTarget).toBe(7);
  });
});

/* Демо-режим: postEvent — no-op, тож інвалідація лише стерла б оптимістичну
 * зміну назад у SAMPLE. Тест пильнує саме те, що ми її НЕ робимо. */
describe('демо-режим (поза Telegram)', () => {
  it('не інвалідує ["stats"] — оптимістична зміна лишається', async () => {
    telegram.inTelegram.mockReturnValue(false);
    seedStats({ dismissedUrls: [] });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useJobDismiss(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ url: 'j1', title: 'Dev' });
    });

    expect(spy).not.toHaveBeenCalled();
    expect(statsNow().dismissedUrls).toEqual(['j1']);
  });
});
