import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createKvStateStore,
  readKvEnv,
  overlayChanged,
  readKvJson,
  writeKvJson,
} from '../src/core/state-kv.js';

const OPTS = {
  accountId: 'acc',
  apiToken: 'tok',
  namespaceId: 'ns',
  // Читання тепер ретраїться; у тестах спимо нуль, щоб не платити 600 мс за
  // кожен сценарій відмови.
  retryDelayMs: 0,
};

const okResp = (body: string, status = 200) =>
  new Response(body, { status }) as unknown as Response;

describe('state-kv — createKvStateStore', () => {
  it('завантажує наявний блоб; get повертає значення', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResp(JSON.stringify({ lastSentDate: '2026-07-01' })),
    );
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(s.get('lastSentDate')).toBe('2026-07-01');
    // GET на правильний URL із Bearer.
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('/accounts/acc/storage/kv/namespaces/ns/values/state');
    expect((init ?? {}).headers).toMatchObject({ authorization: 'Bearer tok' });
  });

  it('404 (ключа ще нема) -> порожній стан без ворнінгу', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => okResp('{"errors":[]}', 404));
    const s = await createKvStateStore({
      ...OPTS,
      log: { debug() {}, info() {}, warn, error() {} },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(s.get('lastSentDate')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('мережева помилка завантаження -> порожній стан (at-least-once)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network');
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(s.get('x')).toBeUndefined();
  });

  it('flush робить re-read GET + PUT; чистий стан -> без запиту', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResp('{}'); // load + re-read -> порожній стан
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // load = 1 виклик
    await s.flush(); // нічого не змінено -> без re-read/PUT
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    s.set('lastSentDate', '2026-07-02');
    await s.flush(); // re-read GET (2) + PUT (3)
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const put = calls[2]!;
    expect(put.init.method).toBe('PUT');
    expect(JSON.parse(String(put.init.body))).toEqual({ lastSentDate: '2026-07-02' });
  });

  it('merge-before-flush: НЕ затирає ключі, дописані Worker під час рану (H2)', async () => {
    let put: RequestInit | null = null;
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      n += 1;
      if (n === 1) return okResp(JSON.stringify({ lastSentDate: '2026-07-01' })); // load
      if (n === 2) {
        // re-read: Worker за час рану дописав нагадування + голос.
        return okResp(
          JSON.stringify({
            lastSentDate: '2026-07-01',
            reminders: [{ id: 'r1' }],
            preferenceWeights: { Спорт: 1.3 },
          }),
        );
      }
      put = init ?? {}; // PUT
      return okResp('{}');
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // Оркестратор змінює лише свій ключ.
    s.set('lastSentDate', '2026-07-02');
    await s.flush();
    const body = JSON.parse(String(put!.body));
    expect(body.lastSentDate).toBe('2026-07-02'); // своя зміна перемагає
    expect(body.reminders).toEqual([{ id: 'r1' }]); // Worker-запис збережено
    expect(body.preferenceWeights).toEqual({ Спорт: 1.3 }); // не чіпав -> зі свіжого
  });

  /* ── Читання, яке не вдалось, БІЛЬШЕ НЕ ДОРІВНЮЄ «ключа немає» ────────────
     Доти обидва випадки давали null, і flush писав повний блоб — тобто одне
     мережеве блимання під час нічного рану затирало все, що Worker дописав за
     хвилини: чек-іни, нагадування, голоси, roadmap. Тепер 404 і відмова —
     різні стани, і відмова зупиняє запис. */

  it('re-read впав УСІ спроби -> throw, і НІЧОГО не записано', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(String(init?.method ?? 'GET'));
      if (methods.length === 1) return okResp('{"reminders":[{"id":"r1"}]}'); // load
      throw new Error('network'); // re-read падає щоразу
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    s.set('lastSentDate', '2026-07-02');
    await expect(s.flush()).rejects.toThrow(/flush скасовано/);
    // ГОЛОВНА АСЕРЦІЯ: жодного PUT. Краще впасти видимо, ніж стерти чуже.
    expect(methods.filter((m) => m === 'PUT')).toEqual([]);
  });

  it('re-read впав і піднявся з другої спроби -> merge, без throw', async () => {
    let put: RequestInit | null = null;
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      n += 1;
      if (n === 1) return okResp('{}'); // load
      if (n === 2) throw new Error('network'); // перша спроба re-read
      if (n === 3) return okResp('{"reminders":[{"id":"r1"}]}'); // друга — вдала
      put = init ?? {};
      return okResp('{}'); // PUT
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    s.set('lastSentDate', '2026-07-02');
    await s.flush();
    const body = JSON.parse(String(put!.body));
    expect(body.lastSentDate).toBe('2026-07-02');
    // Ретрай урятував саме те, заради чого merge-before-flush і робився.
    expect(body.reminders).toEqual([{ id: 'r1' }]);
  });

  it('битий JSON у блобі -> throw, а не перезапис пошкодженого', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(String(init?.method ?? 'GET'));
      return methods.length === 1 ? okResp('{}') : okResp('{ це не json');
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    s.set('lastSentDate', '2026-07-02');
    await expect(s.flush()).rejects.toThrow(/flush скасовано/);
    expect(methods.filter((m) => m === 'PUT')).toEqual([]);
  });

  it('ЧЕСНИЙ 404 на re-read (ключа справді нема) -> повний блоб, як і раніше', async () => {
    let put: RequestInit | null = null;
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      n += 1;
      if (n === 1) return okResp('', 404); // load: ключа нема
      if (n === 2) return okResp('', 404); // re-read: досі нема
      put = init ?? {};
      return okResp('{}');
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    s.set('lastSentDate', '2026-07-02');
    await s.flush();
    expect(JSON.parse(String(put!.body))).toEqual({ lastSentDate: '2026-07-02' });
  });

  /* ⚠️ Суперечність, якої аудит не назвав: завантаження впало (тобто ключ МІГ
     існувати), а re-read каже 404. Одна з двох відповідей CF API хибна, і
     писати повний блоб на такій підставі означає перезаписати стан, якого ми
     не бачили жодного разу. */
  it('завантаження впало + re-read 404 -> throw (стан не читався жодного разу)', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(String(init?.method ?? 'GET'));
      // Усі три спроби завантаження — 503; потім re-read віддає 404.
      return methods.length <= 3 ? okResp('boom', 503) : okResp('', 404);
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    s.set('lastSentDate', '2026-07-02');
    await expect(s.flush()).rejects.toThrow(/не читався жодного разу/);
    expect(methods.filter((m) => m === 'PUT')).toEqual([]);
  });

  it('помилка запису -> throw (видимий failed)', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      // load(1) ok, re-read(2) ok, PUT(3) 403.
      return n === 3 ? okResp('forbidden', 403) : okResp('{}');
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    s.set('k', 1);
    await expect(s.flush()).rejects.toThrow(/403/);
  });
});

describe('state-kv — overlayChanged (per-key merge, H2)', () => {
  it('накладає лише змінені ключі поверх свіжого блоба', () => {
    const fresh = { a: 1, b: 2, worker: 'kept' };
    const mine = { a: 99, b: 2, worker: 'stale', c: 3 };
    expect(overlayChanged(fresh, mine, ['a', 'c'])).toEqual({
      a: 99, // змінений -> мій
      b: 2, // не в changed -> свіжий
      worker: 'kept', // не в changed -> свіжий (не затерто моїм stale)
      c: 3, // новий змінений ключ
    });
  });

  it('порожній changed -> повертає свіжий блоб як є', () => {
    const fresh = { x: 1 };
    expect(overlayChanged(fresh, { x: 2 }, [])).toEqual({ x: 1 });
  });

  it('ключ із трансформацією рахується від СВІЖОГО значення, не від мого', () => {
    // Знімок (`mine`) навмисно неправдоподібний: якби його взяли, це видно одразу.
    const fresh = { w: 10 };
    const mine = { w: 999 };
    const transforms = new Map([['w', (cur: unknown) => (cur as number) * 2]]);
    expect(overlayChanged(fresh, mine, ['w'], transforms)).toEqual({ w: 20 });
  });
});

describe('state-kv — readKvEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('усі три змінні -> об’єкт', () => {
    process.env.CF_ACCOUNT_ID = ' acc ';
    process.env.CF_API_TOKEN = 'tok';
    process.env.KV_NAMESPACE_ID = 'ns';
    expect(readKvEnv()).toEqual({ accountId: 'acc', apiToken: 'tok', namespaceId: 'ns' });
  });

  it('бракує хоч однієї -> null', () => {
    delete process.env.CF_ACCOUNT_ID;
    process.env.CF_API_TOKEN = 'tok';
    process.env.KV_NAMESPACE_ID = 'ns';
    expect(readKvEnv()).toBeNull();
  });
});

describe('state-kv — readKvJson (F2, ключ `settings`)', () => {
  const quiet = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

  it('читає JSON-обʼєкт за довільним ключем', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResp('{"modules":{"news":false}}'));
    const out = await readKvJson({ ...OPTS, fetchImpl }, 'settings');
    expect(out).toEqual({ modules: { news: false } });
    // Ключ реально йде в URL — інакше мовчки читали б 'state'.
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/values/settings');
  });

  it('404 (ключа ще нема) -> null, тихо, без warn', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResp('', 404));
    expect(await readKvJson({ ...OPTS, fetchImpl, log: quiet }, 'settings')).toBeNull();
    expect(quiet.warn).not.toHaveBeenCalled();
  });

  it('HTTP-помилка / мережа / биття JSON -> null, а не throw (ран не падає)', async () => {
    const cases = [
      vi.fn().mockResolvedValue(okResp('boom', 500)),
      vi.fn().mockRejectedValue(new Error('network down')),
      vi.fn().mockResolvedValue(okResp('{не json')),
    ];
    for (const fetchImpl of cases) {
      await expect(readKvJson({ ...OPTS, fetchImpl, log: quiet }, 'settings')).resolves.toBeNull();
    }
  });

  it('не-обʼєкт у значенні (включно з масивом) -> null', async () => {
    for (const body of ['"рядок"', '42', 'null', '[1,2]', 'true']) {
      const fetchImpl = vi.fn().mockResolvedValue(okResp(body));
      await expect(readKvJson({ ...OPTS, fetchImpl }, 'settings')).resolves.toBeNull();
    }
  });
});

describe('state-kv — writeKvJson (assistantPending: власний ключ, не блоб state)', () => {
  const quiet = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

  it('PUT на правильний URL/ключ, Bearer + JSON-тіло, повертає true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResp('{}'));
    const ok = await writeKvJson({ ...OPTS, fetchImpl }, 'assistantPending', { id: 'x' });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('/accounts/acc/storage/kv/namespaces/ns/values/assistantPending');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({ id: 'x' });
  });

  it('HTTP-помилка / мережа -> false, а не throw (ран не падає, best-effort)', async () => {
    const cases = [
      vi.fn().mockResolvedValue(okResp('boom', 500)),
      vi.fn().mockRejectedValue(new Error('network down')),
    ];
    for (const fetchImpl of cases) {
      await expect(
        writeKvJson({ ...OPTS, fetchImpl, log: quiet }, 'assistantPending', { id: 'x' }),
      ).resolves.toBe(false);
    }
  });
});

describe('state-kv — update проти set на ключі, який пише ще й Worker', () => {
  /* Закриття знахідки рев'ю PR #334.
   *
   * `preferenceWeights` — не ексклюзивне поле оркестратора: у той самий блоб їх
   * пише Worker, коли власник тапає ❤️ у Mini App. Недільний ран триває хвилини,
   * і `set` клав на flush ваги, пораховані на його ПОЧАТКУ — тобто скасовував
   * голос, поданий за цей час. Гірше: `votedUrls` ран не чіпає, тож url лишався
   * позначеним як проголосований, а вага — відкоченою, і повторне ❤️ голос
   * ЗНІМАЛО б замість поставити.
   *
   * Тест ставить писаря рівно у вікно між завантаженням і flush.
   */
  function storeWithRacer(initial: unknown, fresh: unknown) {
    const puts: unknown[] = [];
    let reads = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        puts.push(JSON.parse(String(init?.body ?? 'null')));
        return okResp('{}');
      }
      // Перше читання — завантаження на старті рану; друге — re-read на flush,
      // і саме там уже видно чужий запис.
      return okResp(JSON.stringify(++reads === 1 ? initial : fresh));
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, puts };
  }

  const INITIAL = { preferenceWeights: { tech: 1.0 }, votedUrls: {} };
  // Поки ран працював, власник тапнув ❤️: вага зросла, url записаний.
  const FRESH = {
    preferenceWeights: { tech: 1.1 },
    votedUrls: { 'https://ex/1': { dir: 'up', category: 'tech' } },
  };

  it('update: голос, поданий під час рану, ВИЖИВАЄ (decay лягає на свіжу вагу)', async () => {
    const { fetchImpl, puts } = storeWithRacer(INITIAL, FRESH);
    const s = await createKvStateStore({ ...OPTS, fetchImpl });

    // Той самий decay, що в src/modules/news.ts: до 1.0 на 10% шляху.
    s.update<Record<string, number>>('preferenceWeights', (cur) =>
      Object.fromEntries(Object.entries(cur ?? {}).map(([k, v]) => [k, 1 + (v - 1) * 0.9])),
    );
    s.set('lastDecayDate', '2026-08-23');
    await s.flush();

    const body = puts[0] as { preferenceWeights: Record<string, number>; votedUrls: unknown };
    // 1.1 -> 1.09: decay порахований від СВІЖОЇ ваги, тобто голос не зник.
    expect(body.preferenceWeights.tech).toBeCloseTo(1.09, 5);
    expect(body.votedUrls).toEqual(FRESH.votedUrls); // і дедуп-запис на місці
  });

  it('set на тому самому місці голос ЗАТЕР би — ось із чим порівнюємо', async () => {
    const { fetchImpl, puts } = storeWithRacer(INITIAL, FRESH);
    const s = await createKvStateStore({ ...OPTS, fetchImpl });

    const stale = s.get<Record<string, number>>('preferenceWeights') ?? {};
    s.set(
      'preferenceWeights',
      Object.fromEntries(Object.entries(stale).map(([k, v]) => [k, 1 + (v - 1) * 0.9])),
    );
    await s.flush();

    const body = puts[0] as { preferenceWeights: Record<string, number>; votedUrls: unknown };
    expect(body.preferenceWeights.tech).toBe(1.0); // ❤️ зникло
    expect(body.votedUrls).toEqual(FRESH.votedUrls); // а дедуп лишився -> неконсистентно
  });

  it('set ПІСЛЯ update на тому ж ключі перемагає: знімок явніший за намір', async () => {
    const { fetchImpl, puts } = storeWithRacer(INITIAL, FRESH);
    const s = await createKvStateStore({ ...OPTS, fetchImpl });

    s.update<Record<string, number>>('preferenceWeights', () => ({ tech: 5 }));
    s.set('preferenceWeights', { tech: 7 });
    await s.flush();

    expect((puts[0] as { preferenceWeights: unknown }).preferenceWeights).toEqual({ tech: 7 });
  });
});
