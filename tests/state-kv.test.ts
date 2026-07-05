import { describe, it, expect, vi, afterEach } from 'vitest';
import { createKvStateStore, readKvEnv } from '../src/core/state-kv.js';

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

  it('flush робить PUT з тілом; чистий стан -> без запиту', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResp('{}'); // load -> порожній стан
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // load = 1 виклик
    await s.flush(); // нічого не змінено -> без PUT
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    s.set('lastSentDate', '2026-07-02');
    await s.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const put = calls[1]!;
    expect(put.init.method).toBe('PUT');
    expect(JSON.parse(String(put.init.body))).toEqual({ lastSentDate: '2026-07-02' });
  });

  it('помилка запису -> throw (видимий failed)', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1 ? okResp('{}') : okResp('forbidden', 403);
    });
    const s = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    s.set('k', 1);
    await expect(s.flush()).rejects.toThrow(/403/);
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
