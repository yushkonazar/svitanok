import { describe, it, expect, vi, afterEach } from 'vitest';
import { createKvStateStore, readKvEnv, overlayChanged, readKvJson } from '../src/core/state-kv.js';

const OPTS = {
  accountId: 'acc',
  apiToken: 'tok',
  namespaceId: 'ns',
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

  it('re-read впав -> фолбек на повний блоб (свій стан не втрачається)', async () => {
    let put: RequestInit | null = null;
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      n += 1;
      if (n === 1) return okResp('{}'); // load
      if (n === 2) throw new Error('network'); // re-read впав
      put = init ?? {};
      return okResp('{}'); // PUT
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    s.set('lastSentDate', '2026-07-02');
    await s.flush();
    expect(JSON.parse(String(put!.body))).toEqual({ lastSentDate: '2026-07-02' });
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
