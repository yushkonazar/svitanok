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
