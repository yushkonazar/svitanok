// HTTP-шар мозку: /health (канон 07 §3 - ядро читає version+gitSha, деплой
// грепає повний 40-hex sha) і /run (підпис → нонс → контракт → 202 + фоновий
// прогін, слоти ≤ 2). Сходинка відмов - та сама, що в ядровому router.

import { describe, expect, it, vi } from 'vitest';
import { createHandler, type RunRequest, type ServerDeps } from '../brain/src/server.js';
import { buildSignedHeaders } from '../brain/src/sign.js';
import { probeInternalApi } from '../brain/src/health.js';
import type { BrainConfig } from '../brain/src/config.js';

const KEY = 'server-test-key';
const NOW = 1_756_300_000_000;
const SHA = 'a'.repeat(40);

const CONFIG: BrainConfig = {
  host: '127.0.0.1',
  port: 8788,
  internalApiUrl: 'https://svitanok.example',
  hmacKeys: [KEY],
  accessClientId: null,
  accessClientSecret: null,
};

function makeHandler(over: Partial<ServerDeps> = {}) {
  const runs: RunRequest[] = [];
  const deps: ServerDeps = {
    config: CONFIG,
    buildInfo: { version: '0.1.0', gitSha: SHA, builtAt: '2026-08-27T00:00:00Z' },
    limits: { tools: ['data.read'], models: ['claude-sonnet-5'], maxSteps: 12 },
    runner: async (req) => {
      runs.push(req);
    },
    sdkVersion: '0.3.247',
    claudeVersion: null,
    internalApiProbe: () => 'ok',
    now: () => NOW,
    ...over,
  };
  return { handler: createHandler(deps), runs };
}

function runBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    run_id: 'run-1',
    profile: 'chat',
    thread_id: 'dm',
    input: { text: 'привіт' },
    ...over,
  });
}

function signedReq(
  bodyText: string,
  over: { runId?: string; nonce?: string; nowMs?: number } = {},
) {
  const headers = buildSignedHeaders(KEY, {
    method: 'POST',
    path: '/run',
    runId: over.runId ?? 'run-1',
    rawBody: bodyText,
    nowMs: over.nowMs ?? NOW,
    nonce: over.nonce ?? `nonce-${Math.random()}`,
  });
  return {
    method: 'POST',
    path: '/run',
    getHeader: (n: string) => headers[n] ?? null,
    bodyText,
  };
}

describe('/health', () => {
  it('віддає канонічні поля; gitSha - повний 40-hex', async () => {
    const { handler } = makeHandler();
    const res = await handler.handle({
      method: 'GET',
      path: '/health',
      getHeader: () => null,
      bodyText: '',
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('0.1.0');
    expect(res.body.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.body.limits).toEqual({
      tools: ['data.read'],
      models: ['claude-sonnet-5'],
      maxSteps: 12,
    });
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.internalApiProbe).toBe('ok');
  });

  it('POST /health - 405; невідомий шлях - 404', async () => {
    const { handler } = makeHandler();
    const post = await handler.handle({
      method: 'POST',
      path: '/health',
      getHeader: () => null,
      bodyText: '',
    });
    expect(post).toMatchObject({ status: 405 });
    const other = await handler.handle({
      method: 'GET',
      path: '/internal/tool/x',
      getHeader: () => null,
      bodyText: '',
    });
    expect(other).toMatchObject({ status: 404, body: { error: 'not-found' } });
  });
});

describe('/run: сходинка відмов', () => {
  it('валідний підписаний запит - 202, runner отримує розібране тіло', async () => {
    const { handler, runs } = makeHandler();
    const res = await handler.handle(signedReq(runBody({ status_message_id: 7 })));
    expect(res).toMatchObject({ status: 202, body: { ok: true, run_id: 'run-1' } });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({
      run_id: 'run-1',
      profile: 'chat',
      thread_id: 'dm',
      input: { text: 'привіт' },
      status_message_id: 7,
    });
  });

  it('без підпису - 401 missing-auth; зіпсоване тіло після підпису - 401 bad-signature', async () => {
    const { handler } = makeHandler();
    const naked = await handler.handle({
      method: 'POST',
      path: '/run',
      getHeader: () => null,
      bodyText: runBody(),
    });
    expect(naked).toMatchObject({ status: 401, body: { error: 'missing-auth' } });

    const req = signedReq(runBody());
    const tampered = await handler.handle({ ...req, bodyText: runBody({ thread_id: 'інший' }) });
    expect(tampered).toMatchObject({ status: 401, body: { error: 'bad-signature' } });
  });

  it('повтор нонса - 401 replayed (перший раз проходить)', async () => {
    const { handler } = makeHandler();
    const body = runBody();
    const first = await handler.handle(signedReq(body, { nonce: 'n-1' }));
    expect(first.status).toBe(202);
    const replay = await handler.handle(signedReq(body, { nonce: 'n-1' }));
    expect(replay).toMatchObject({ status: 401, body: { error: 'replayed' } });
  });

  it('прострочений підпис - 401 stale-timestamp', async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(signedReq(runBody(), { nowMs: NOW - 11 * 60_000 }));
    expect(res).toMatchObject({ status: 401, body: { error: 'stale-timestamp' } });
  });

  it('run_id тіла ≠ підписаному заголовку - 400 run-mismatch', async () => {
    const { handler } = makeHandler();
    const res = await handler.handle(signedReq(runBody({ run_id: 'run-2' })));
    expect(res).toMatchObject({ status: 400, body: { error: 'run-mismatch' } });
  });

  it('невалідний контракт - 400 з шляхом поля; битий JSON - 400 bad-json', async () => {
    const { handler } = makeHandler();
    const badProfile = await handler.handle(signedReq(runBody({ profile: 'weekly' })));
    expect(badProfile.status).toBe(400);
    expect(String(badProfile.body.error)).toMatch(/^contract: \$\.profile/);

    const badJson = await handler.handle(signedReq('{нежить'));
    expect(badJson).toMatchObject({ status: 400, body: { error: 'bad-json' } });
  });

  it('без ключів HMAC - 500 hmac-not-configured (fail-closed)', async () => {
    const { handler } = makeHandler({ config: { ...CONFIG, hmacKeys: [] } });
    const res = await handler.handle(signedReq(runBody()));
    expect(res).toMatchObject({ status: 500, body: { error: 'hmac-not-configured' } });
  });

  it('слоти: третій одночасний прогін - 429 busy; після завершення слот вільний', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler } = makeHandler({ runner: () => gate });

    expect(
      (await handler.handle(signedReq(runBody({ run_id: 'r1' }), { runId: 'r1' }))).status,
    ).toBe(202);
    expect(
      (await handler.handle(signedReq(runBody({ run_id: 'r2' }), { runId: 'r2' }))).status,
    ).toBe(202);
    const third = await handler.handle(signedReq(runBody({ run_id: 'r3' }), { runId: 'r3' }));
    expect(third).toMatchObject({ status: 429, body: { error: 'busy' } });
    expect(handler.activeRuns()).toBe(2);

    release();
    await vi.waitFor(() => expect(handler.activeRuns()).toBe(0));
    const again = await handler.handle(signedReq(runBody({ run_id: 'r4' }), { runId: 'r4' }));
    expect(again.status).toBe(202);
  });

  it('збій runner-а не топить обробник: 202 віддано, слот звільнено', async () => {
    const { handler } = makeHandler({
      runner: async () => {
        throw new Error('впав');
      },
    });
    const res = await handler.handle(signedReq(runBody()));
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(handler.activeRuns()).toBe(0));
  });
});

describe('probeInternalApi', () => {
  it('401/403 - ok; 404 - unexpected-404; мережевий збій - unreachable', async () => {
    const mk = (status: number) =>
      (async () => new Response('', { status })) as unknown as typeof fetch;
    expect(await probeInternalApi('https://x', mk(401))).toBe('ok');
    expect(await probeInternalApi('https://x', mk(403))).toBe('ok');
    expect(await probeInternalApi('https://x', mk(404))).toBe('unexpected-404');
    const boom = (async () => {
      throw new Error('мережа');
    }) as unknown as typeof fetch;
    expect(await probeInternalApi('https://x', boom)).toBe('unreachable');
  });
});
