import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFetcher } from '../src/core/fetcher.js';

afterEach(() => vi.useRealTimers());

const mk = (fetchImpl: typeof fetch, retries = 2) =>
  createFetcher({ allowlist: ['x.com'], timeoutMs: 1000, retries, fetchImpl });

describe('fetcher — allowlist (анти-SSRF)', () => {
  it('блокує хост не з allowlist', async () => {
    const f = mk(vi.fn() as unknown as typeof fetch);
    await expect(f.fetch('https://evil.com/a')).rejects.toThrow(/allowlist/);
  });

  it('фетчить дозволений хост і повертає тіло', async () => {
    const fetchImpl = vi.fn(async () => new Response('BODY', { status: 200 }));
    const f = mk(fetchImpl as unknown as typeof fetch);
    await expect(f.fetch('https://x.com/feed')).resolves.toBe('BODY');
  });

  it('слідує редиректу в межах allowlist (M3)', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      n += 1;
      if (n === 1) {
        expect(String(url)).toBe('https://x.com/a');
        return new Response('', { status: 302, headers: { location: 'https://x.com/b' } });
      }
      expect(String(url)).toBe('https://x.com/b');
      return new Response('MOVED', { status: 200 });
    });
    const f = mk(fetchImpl as unknown as typeof fetch);
    await expect(f.fetch('https://x.com/a')).resolves.toBe('MOVED');
  });

  it('блокує редирект на хост поза allowlist (анти-SSRF, M3)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 302, headers: { location: 'https://evil.com/x' } }),
    );
    // retries=0 -> без ретраю на заблокованому редиректі.
    const f = createFetcher({
      allowlist: ['x.com'],
      timeoutMs: 1000,
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(f.fetch('https://x.com/a')).rejects.toThrow(/allowlist.*evil\.com/);
  });
});

describe('fetcher — ретрай з бекофом', () => {
  it('ретраїть після збою й повертає успіх', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('net');
      return new Response('OK', { status: 200 });
    });
    const f = mk(fetchImpl as unknown as typeof fetch);
    const p = f.fetch('https://x.com/a');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('OK');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('кидає після вичерпання ретраїв', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const f = mk(fetchImpl as unknown as typeof fetch, 1);
    const p = f.fetch('https://x.com/a');
    const expectation = expect(p).rejects.toThrow(/down/);
    await vi.runAllTimersAsync();
    await expectation;
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 + 1 retry
  });
});

/* User-Agent (P4). Значення саме по собі неважливе — важливо, що слаг
 * репозиторію в ньому БІЛЬШЕ НЕ ЗАШИТИЙ: форк має міняти його змінною, а не
 * правкою коду. Модуль читає env один раз при імпорті, тому override
 * перевіряється через resetModules + свіжий import. */
describe('fetcher — User-Agent і GH_REPO (P4)', () => {
  const uaOf = async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('ok', { status: 200 }),
    );
    const { createFetcher: fresh } = await import('../src/core/fetcher.js');
    const f = fresh({
      allowlist: ['x.com'],
      timeoutMs: 1000,
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await f.fetch('https://x.com/feed');
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    return headers['user-agent'];
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('без GH_REPO — дефолтний слаг', async () => {
    vi.stubEnv('GH_REPO', '');
    vi.resetModules();
    expect(await uaOf()).toBe(
      'Mozilla/5.0 (compatible; svitanok-bot/1.0; +https://github.com/yushkonazar/svitanok)',
    );
  });

  it('GH_REPO перекриває слаг', async () => {
    vi.stubEnv('GH_REPO', 'someone/fork');
    vi.resetModules();
    expect(await uaOf()).toContain('+https://github.com/someone/fork)');
  });
});
