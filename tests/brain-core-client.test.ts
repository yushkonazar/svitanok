// Клієнт internal API мозку: підписані запити проходять ядровий verify
// (наскрізна парність, не самозвірка), Access-заголовки лише за наявності
// пари, політика помилок за ендпоїнтом (callTool -> {ok:false}, deliver ->
// виняток, status/runs - мовчазні).

import { describe, expect, it, vi } from 'vitest';
import { verifyInternalRequest } from '../web/core/internal/auth.mjs';
import { CoreClient } from '../brain/src/core-client.js';
import { workerEnv } from './helpers/env.js';

const KEY = 'client-test-key';
const NOW = 1_756_300_000_000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(
  fetchFn: typeof fetch,
  over: Partial<ConstructorParameters<typeof CoreClient>[0]> = {},
) {
  return new CoreClient({
    baseUrl: 'https://svitanok.example',
    hmacKey: KEY,
    accessClientId: 'access-id',
    accessClientSecret: 'access-secret',
    fetchFn,
    now: () => NOW,
    ...over,
  });
}

function captureFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse(status, body);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('CoreClient: транспорт і підпис', () => {
  it('callTool шле POST /internal/tool/:name з envelope {args} і підписом, що проходить ядровий verify', async () => {
    const { fetchFn, calls } = captureFetch(200, {
      ok: true,
      tool: 'data.read',
      tainted: false,
      result: 'дані',
    });
    const outcome = await makeClient(fetchFn).callTool('run-1', 'data.read', { scope: 'briefing' });

    expect(outcome).toMatchObject({ ok: true, tool: 'data.read', tainted: false, result: 'дані' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://svitanok.example/internal/tool/data.read');
    expect(call.init.method).toBe('POST');
    const rawBody = String(call.init.body);
    expect(JSON.parse(rawBody)).toEqual({ args: { scope: 'briefing' } });

    const headers = new Headers(call.init.headers as Record<string, string>);
    expect(headers.get('CF-Access-Client-Id')).toBe('access-id');
    expect(headers.get('CF-Access-Client-Secret')).toBe('access-secret');
    const verdict = await verifyInternalRequest({
      method: 'POST',
      path: '/internal/tool/data.read',
      headers,
      bodyText: rawBody,
      nowMs: NOW + 1000,
      env: workerEnv({ INTERNAL_HMAC_KEY: KEY }),
    });
    expect(verdict).toMatchObject({ ok: true, runId: 'run-1' });
  });

  it('без Access-пари заголовки CF-Access-* не шлються', async () => {
    const { fetchFn, calls } = captureFetch(200, { ok: true, tool: 't', tainted: false });
    await makeClient(fetchFn, { accessClientId: null, accessClientSecret: null }).callTool(
      'run-1',
      'geo.last',
      {},
    );
    const headers = new Headers(calls[0]!.init.headers as Record<string, string>);
    expect(headers.get('CF-Access-Client-Id')).toBeNull();
    expect(headers.get('CF-Access-Client-Secret')).toBeNull();
  });

  it('кожен запит несе НОВИЙ nonce (антиреплей за ADR-037)', async () => {
    const { fetchFn, calls } = captureFetch(200, { ok: true, tool: 't', tainted: false });
    const client = makeClient(fetchFn);
    await client.callTool('run-1', 'geo.last', {});
    await client.callTool('run-1', 'geo.last', {});
    const nonces = calls.map((c) =>
      new Headers(c.init.headers as Record<string, string>).get('X-Internal-Nonce'),
    );
    expect(nonces[0]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});

describe('CoreClient: політика помилок', () => {
  it('callTool на 502 повертає {ok:false} з кодом і reason - не кидає', async () => {
    const { fetchFn } = captureFetch(502, { ok: false, error: 'tool-failed', reason: 'календар' });
    const outcome = await makeClient(fetchFn).callTool('run-1', 'calendar.read', { days: 1 });
    expect(outcome).toEqual({ ok: false, status: 502, error: 'tool-failed: календар' });
  });

  it('callTool з write-відповіддю mode=proposed віддає proposal', async () => {
    const { fetchFn } = captureFetch(200, {
      ok: true,
      tool: 'facts.set',
      tainted: true,
      mode: 'proposed',
      proposal: { id: 'p1' },
    });
    const outcome = await makeClient(fetchFn).callTool('run-1', 'facts.set', {
      kind: 'setting',
      key: 'k',
      value: 1,
    });
    expect(outcome).toMatchObject({ ok: true, mode: 'proposed', proposal: { id: 'p1' } });
  });

  it('deliver кидає на не-2xx і шле {text} без buttons, коли їх нема', async () => {
    const okCapture = captureFetch(200, { ok: true, queued: 1 });
    await makeClient(okCapture.fetchFn).deliver('run-1', 'привіт');
    expect(JSON.parse(String(okCapture.calls[0]!.init.body))).toEqual({ text: 'привіт' });

    const failCapture = captureFetch(400, { ok: false, error: 'contract: $.buttons' });
    await expect(makeClient(failCapture.fetchFn).deliver('run-1', 'привіт')).rejects.toThrow(
      /deliver: 400 contract/,
    );
  });

  it('deliver з кнопками шле {text, buttons}', async () => {
    const { fetchFn, calls } = captureFetch(200, { ok: true, queued: 1 });
    const buttons = [[{ text: 'Так', callback_data: 'a:1:yes' }]];
    await makeClient(fetchFn).deliver('run-1', 'питання', buttons);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'питання', buttons });
  });

  it('транспортний збій callTool - {ok:false, error:network…}, не виняток (модель бачить відмову одного інструмента)', async () => {
    const boom = vi.fn(async () => {
      throw new Error('мережа впала');
    }) as unknown as typeof fetch;
    const outcome = await makeClient(boom).callTool('run-1', 'geo.last', {});
    expect(outcome).toMatchObject({ ok: false, status: 0 });
    expect(String((outcome as { error: string }).error)).toMatch(/^network:/);
  });

  it('status і reportRuns мовчать на збоях мережі та не-2xx; runs терпить 501', async () => {
    const boom = vi.fn(async () => {
      throw new Error('мережа впала');
    }) as unknown as typeof fetch;
    const client = makeClient(boom);
    await expect(client.status('run-1', 5, 'думаю')).resolves.toBeUndefined();
    await expect(client.reportRuns('run-1', [{ n: 1 }])).resolves.toBeUndefined();

    const { fetchFn } = captureFetch(501, { ok: false, error: 'not-implemented' });
    await expect(makeClient(fetchFn).reportRuns('run-1', [{ n: 1 }])).resolves.toBeUndefined();
  });

  it('session: true на 2xx; false (не виняток) на відмову ядра і мережу', async () => {
    const okCap = captureFetch(200, { ok: true, thread_id: 'dm' });
    expect(
      await makeClient(okCap.fetchFn).session('run-1', {
        thread_id: 'dm',
        sdk_session_id: 's1',
        turns_inc: 1,
      }),
    ).toBe(true);
    expect(okCap.calls[0]!.url).toBe('https://svitanok.example/internal/session');
    expect(JSON.parse(String(okCap.calls[0]!.init.body))).toEqual({
      thread_id: 'dm',
      sdk_session_id: 's1',
      turns_inc: 1,
    });

    const failCap = captureFetch(500, { ok: false, error: 'session-not-persisted' });
    expect(await makeClient(failCap.fetchFn).session('run-1', { thread_id: 'dm' })).toBe(false);
    const boom = vi.fn(async () => {
      throw new Error('мережа впала');
    }) as unknown as typeof fetch;
    expect(await makeClient(boom).session('run-1', { thread_id: 'dm' })).toBe(false);
  });

  it('status шле {message_id, text} за контрактом STATUS_SCHEMA', async () => {
    const { fetchFn, calls } = captureFetch(200, { ok: true, queued: 1 });
    await makeClient(fetchFn).status('run-1', 42, '▸ Читаю пошту…');
    expect(calls[0]!.url).toBe('https://svitanok.example/internal/status');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      message_id: 42,
      text: '▸ Читаю пошту…',
    });
  });
});

describe('CoreClient: instruction / taint / deliver з працівником (етап 4)', () => {
  it('instruction: POST /internal/instruction {name} → тіло з хешем; 404 і транспорт - {ok:false}', async () => {
    const { fetchFn, calls } = captureFetch(200, {
      ok: true,
      name: 'editor',
      version_hash: 'a'.repeat(64),
      body_md: '# Редактор',
    });
    const out = await makeClient(fetchFn).instruction('run-1', 'editor');
    expect(out).toEqual({
      ok: true,
      name: 'editor',
      version_hash: 'a'.repeat(64),
      body_md: '# Редактор',
    });
    expect(calls[0]!.url).toBe('https://svitanok.example/internal/instruction');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: 'editor' });
    const missing = captureFetch(404, { ok: false, error: 'instruction-missing', reason: 'немає' });
    expect(await makeClient(missing.fetchFn).instruction('run-1', 'ghost')).toEqual({
      ok: false,
      status: 404,
      error: 'instruction-missing: немає',
    });
    const boom = vi.fn(async () => {
      throw new Error('мережа');
    }) as unknown as typeof fetch;
    expect(await makeClient(boom).instruction('run-1', 'editor')).toMatchObject({
      ok: false,
      status: 0,
    });
    // Неповне тіло 200 - теж не ok (хеш чи тіло без імені не приймаємо).
    const partial = captureFetch(200, { ok: true, name: 'editor' });
    expect((await makeClient(partial.fetchFn).instruction('run-1', 'editor')).ok).toBe(false);
  });

  it('taint: true лише на 2xx; 503 і мережа - false (fail-closed у викликача)', async () => {
    const ok = captureFetch(200, { ok: true, tainted: true });
    expect(await makeClient(ok.fetchFn).taint('run-1', 'worker:researcher')).toBe(true);
    expect(JSON.parse(String(ok.calls[0]!.init.body))).toEqual({ source: 'worker:researcher' });
    const fail = captureFetch(503, { ok: false, error: 'taint-not-persisted' });
    expect(await makeClient(fail.fetchFn).taint('run-1', 'worker:researcher')).toBe(false);
    const boom = vi.fn(async () => {
      throw new Error('мережа');
    }) as unknown as typeof fetch;
    expect(await makeClient(boom).taint('run-1', 'w')).toBe(false);
  });

  it('deliver з працівником шле {text, buttons?, worker}; без кнопок - buttons відсутній', async () => {
    const { fetchFn, calls } = captureFetch(200, { ok: true, queued: 1 });
    await makeClient(fetchFn).deliver('run-1', 'готово', [], { name: 'editor', text: 'hello' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      text: 'готово',
      worker: { name: 'editor', text: 'hello' },
    });
  });
});
