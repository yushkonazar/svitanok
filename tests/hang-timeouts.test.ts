import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { fetchJsonWithTimeout } from '../src/core/google-auth.js';
import { createFetcher } from '../src/core/fetcher.js';
import { createKvStateStore, readKvJson, writeKvJson } from '../src/core/state-kv.js';

/* B14 (аудит 11.08.2026): таймаут покривав лише ЗАГОЛОВКИ. AbortController
 * знімався у finally щойно приходив статус, а `await res.json()` читав стрічку
 * тіла вже без жодної межі. Сервер, який віддав заголовки й завис на тілі
 * (класична напівсмерть проксі), підвішував увесь прогін брифінгу до 360-хв
 * ліміту job'а GitHub Actions — жодного алерту, просто ран, що не закінчується.
 * KV-виклики (state-kv.ts) не мали таймауту взагалі.
 *
 * ⚠️ Тести НЕ можуть просто чекати на зависання (вони б висіли самі), тому
 * кожен гоняє виклик проти дедлайну: 'hang' == баг, будь-яке інше значення ==
 * межа спрацювала. */

const TIMEOUT_MS = 25;
const DEADLINE_MS = 400; // >> TIMEOUT_MS, але миттєвий за мірками vitest

/** Що сталось першим: виклик завершився (як завгодно) чи дедлайн? */
async function raceHang<T>(p: Promise<T>): Promise<'hang' | { ok: T } | { err: unknown }> {
  return Promise.race([
    p.then(
      (ok) => ({ ok }),
      (err) => ({ err }),
    ),
    new Promise<'hang'>((r) => setTimeout(() => r('hang'), DEADLINE_MS)),
  ]);
}

/**
 * Відповідь, у якої ЗАГОЛОВКИ вже прийшли, а тіло висить, доки не спрацює
 * abort — рівно та поведінка, що в undici: читання тіла привʼязане до signal
 * запиту, тож живий таймер його й обриває.
 */
function headersThenHangingBody(signal: AbortSignal | undefined, status = 200) {
  const hang = () =>
    new Promise<never>((_, reject) => {
      if (!signal) return; // без signal тіло не обірветься НІКОЛИ — це й є баг
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { ok: status < 400, status, json: hang, text: hang } as unknown as Response;
}

/** fetch, що не відповідає взагалі (навіть заголовками), поки не обірвуть. */
function neverResolves(_url: string, init?: RequestInit) {
  return new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

describe('fetchJsonWithTimeout — тіло читається ПІД тим самим таймаутом', () => {
  it('заголовки прийшли, тіло висить -> відхилення за таймаут, не зависання', async () => {
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) =>
      headersThenHangingBody(init?.signal ?? undefined),
    );
    const outcome = await raceHang(
      fetchJsonWithTimeout(fetchImpl as unknown as typeof fetch, 'https://x/y', {}, TIMEOUT_MS),
    );
    expect(outcome).not.toBe('hang');
    expect(outcome).toHaveProperty('err');
  });

  it('нормальна відповідь -> {ok,status,body}; тіло розпарсене', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const r = await fetchJsonWithTimeout<{ a: number }>(
      fetchImpl as unknown as typeof fetch,
      'https://x/y',
      {},
      TIMEOUT_MS,
    );
    expect(r).toEqual({ ok: true, status: 200, body: { a: 1 } });
  });

  it('HTTP-помилка -> {ok:false,status}, тіло НЕ читаємо (ще одне вікно зависання)', async () => {
    const json = vi.fn(async () => ({}));
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json }) as unknown as Response);
    const r = await fetchJsonWithTimeout(
      fetchImpl as unknown as typeof fetch,
      'https://x/y',
      {},
      TIMEOUT_MS,
    );
    expect(r).toEqual({ ok: false, status: 503, body: null });
    expect(json).not.toHaveBeenCalled();
  });
});

describe('createFetcher — зависле тіло RSS (найчастіше джерело, найменш надійні сервери)', () => {
  it('не підвішує прогін; помилка йде у звичайний ретрай-цикл', async () => {
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) =>
      headersThenHangingBody(init?.signal ?? undefined),
    );
    const f = createFetcher({
      allowlist: ['example.com'],
      timeoutMs: TIMEOUT_MS,
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await raceHang(f.fetch('https://example.com/rss'));
    expect(outcome).not.toBe('hang');
    expect(outcome).toHaveProperty('err');
  });
});

describe('state-kv — KV-виклики під таймаутом (раніше без жодного)', () => {
  // ⚠️ retryDelayMs: 0 — не «щоб тест проходив», а щоб він міряв ТЕ, ЩО
  // обіцяє. Читання блоба тепер ретраїться (KV_READ_ATTEMPTS=3), тож межа
  // виклику = спроби × таймаут + бекоф. Сам бекоф — це sleep, а не зависання;
  // лишивши його, тест перевіряв би довжину пауз замість наявності таймауту, і
  // впав би на 400 мс дедлайні через власні 600 мс сну. З нулем лишається саме
  // те, заради чого тест писався: три обірвані за таймаутом спроби (3×25 мс)
  // завершуються, а не висять.
  const OPTS = {
    accountId: 'acc',
    apiToken: 'tok',
    namespaceId: 'ns',
    timeoutMs: TIMEOUT_MS,
    retryDelayMs: 0,
  };

  it('завантаження висить -> порожній стан (фолбек), не зависання', async () => {
    const outcome = await raceHang(
      createKvStateStore({ ...OPTS, fetchImpl: neverResolves as unknown as typeof fetch }),
    );
    expect(outcome).not.toBe('hang');
    expect(outcome).toHaveProperty('ok'); // load ковтає збій -> порожній стан
  });

  it('запис висить -> throw (видимий failed-ран), не зависання', async () => {
    // Перший виклик (load) успішний, далі все висить: re-read і PUT на flush.
    let call = 0;
    const fetchImpl = (url: string, init?: RequestInit) => {
      if (call++ === 0) return Promise.resolve(new Response('{}', { status: 200 }));
      return neverResolves(url, init);
    };
    const store = await createKvStateStore({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    store.set('lastSentDate', '2026-08-11');
    const outcome = await raceHang(store.flush());
    expect(outcome).not.toBe('hang');
    expect(outcome).toHaveProperty('err');
  });

  it('readKvJson висить -> null', async () => {
    const outcome = await raceHang(
      readKvJson({ ...OPTS, fetchImpl: neverResolves as unknown as typeof fetch }, 'settings'),
    );
    expect(outcome).toEqual({ ok: null });
  });

  it('writeKvJson висить -> false (best-effort, не валить ран)', async () => {
    const outcome = await raceHang(
      writeKvJson(
        { ...OPTS, fetchImpl: neverResolves as unknown as typeof fetch },
        'assistantPending',
        { a: 1 },
      ),
    );
    expect(outcome).toEqual({ ok: false });
  });
});

describe('brief.yml — остання сітка безпеки на рівні job', () => {
  it('job `brief` має timeout-minutes (дефолт 360 хв = пів дня на завислий виклик)', () => {
    const wf = load(
      readFileSync(new URL('../.github/workflows/brief.yml', import.meta.url), 'utf8'),
    ) as { jobs: { brief: { 'timeout-minutes'?: number } } };
    const limit = wf.jobs.brief['timeout-minutes'];
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(60); // сітка має бути ВІДЧУТНО меншою за дефолт
  });
});
