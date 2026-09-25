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
  aiProvider: 'claude',
  openAiApiKey: null,
  openAiModels: null,
  openAiReasoningEffort: null,
  openAiRollout: null,
  openAiCanaryTargets: [],
  openAiCanaryProfiles: [],
  openAiShadowTargets: [],
  openAiShadowProfiles: [],
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

  it('/ready підтверджує готовий runtime, а health без Claude CLI лишається лише живим процесом', async () => {
    const ready = makeHandler({ claudeVersion: '1.2.3' }).handler;
    await expect(
      ready.handle({ method: 'GET', path: '/ready', getHeader: () => null, bodyText: '' }),
    ).resolves.toMatchObject({ status: 200, body: { ok: true, gitSha: SHA } });

    const notReady = makeHandler().handler;
    await expect(
      notReady.handle({ method: 'GET', path: '/ready', getHeader: () => null, bodyText: '' }),
    ).resolves.toMatchObject({ status: 503, body: { error: 'sdk-or-cli-unavailable' } });
  });
});

describe('/run: сходинка відмов', () => {
  it('валідний підписаний запит - 202, runner отримує розібране тіло', async () => {
    const { handler, runs } = makeHandler();
    const res = await handler.handle(
      signedReq(runBody({ chat_id: '-100123', status_message_id: 7 })),
    );
    expect(res).toMatchObject({ status: 202, body: { ok: true, run_id: 'run-1' } });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({
      run_id: 'run-1',
      profile: 'chat',
      thread_id: 'dm',
      chat_id: '-100123',
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

  it('session (ADR-038): nullable-поля і профіль summarize приймаються; крива session - 400', async () => {
    const { handler, runs } = makeHandler();
    const ok = await handler.handle(
      signedReq(
        runBody({
          profile: 'summarize',
          session: { sdk_session_id: 'sess-1', summary_md: null },
        }),
      ),
    );
    expect(ok.status).toBe(202);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({
      profile: 'summarize',
      session: { sdk_session_id: 'sess-1', summary_md: null },
    });

    const bad = await handler.handle(
      signedReq(runBody({ session: { sdk_session_id: 5, summary_md: null } })),
    );
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/^contract: \$\.session/);
  });

  it('без ключів HMAC - 500 hmac-not-configured (fail-closed)', async () => {
    const { handler } = makeHandler({ config: { ...CONFIG, hmacKeys: [] } });
    const res = await handler.handle(signedReq(runBody()));
    expect(res).toMatchObject({ status: 500, body: { error: 'hmac-not-configured' } });
  });

  it('слоти: третій одночасний прогін - 429 busy, нонс НЕ згорає: той самий підписаний запит проходить після звільнення', async () => {
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
    const thirdReq = signedReq(runBody({ run_id: 'r3' }), { runId: 'r3', nonce: 'busy-n' });
    const third = await handler.handle(thirdReq);
    expect(third).toMatchObject({ status: 429, body: { error: 'busy' } });
    expect(handler.activeRuns()).toBe(2);

    release();
    await vi.waitFor(() => expect(handler.activeRuns()).toBe(0));
    // Ретрай БАЙТ-У-БАЙТ тим самим запитом (той самий nonce/підпис) - 202:
    // 429 не спалює нонс (знахідка ревʼю).
    const retry = await handler.handle(thirdReq);
    expect(retry).toMatchObject({ status: 202, body: { run_id: 'r3' } });
  });

  it('drain не приймає новий run і не спалює nonce для retry після нового release', async () => {
    const { handler } = makeHandler();
    const req = signedReq(runBody(), { nonce: 'drain-n' });
    handler.beginDrain();
    await expect(handler.handle(req)).resolves.toMatchObject({
      status: 503,
      body: { error: 'draining' },
    });

    const fresh = makeHandler().handler;
    await expect(fresh.handle(req)).resolves.toMatchObject({
      status: 202,
      body: { run_id: 'run-1' },
    });
  });

  it('400 contract не спалює нонс: після відмови той самий нонс із валідним тілом проходить', async () => {
    const { handler } = makeHandler();
    const bad = await handler.handle(signedReq(runBody({ profile: 'weekly' }), { nonce: 'ctr-n' }));
    expect(bad.status).toBe(400);
    const good = await handler.handle(signedReq(runBody(), { nonce: 'ctr-n' }));
    expect(good.status).toBe(202);
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
  const mk = (status: number) => (async () => new Response(null, { status })) as never;

  it('без Access-пари (локальний dev): 401/403 - ok; 404 - unexpected-404; збій - unreachable', async () => {
    expect(await probeInternalApi('https://x', mk(401))).toBe('ok');
    expect(await probeInternalApi('https://x', mk(403))).toBe('ok');
    expect(await probeInternalApi('https://x', mk(404))).toBe('unexpected-404');
    const boom = (async () => {
      throw new Error('мережа');
    }) as unknown as typeof fetch;
    expect(await probeInternalApi('https://x', boom)).toBe('unreachable');
  });

  it('з Access-парою: шле креди, redirect=manual, ok - ЛИШЕ строгий 401 від HMAC-шару (чужий Access-хост із 403 не «ok»)', async () => {
    const access = { clientId: 'id', clientSecret: 'secret' };
    const calls: RequestInit[] = [];
    const capture = (status: number) =>
      (async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(null, { status });
      }) as unknown as typeof fetch;

    expect(await probeInternalApi('https://x', capture(401), access)).toBe('ok');
    expect(await probeInternalApi('https://x', capture(403), access)).toBe('unexpected-403');
    expect(await probeInternalApi('https://x', capture(200), access)).toBe('unexpected-200');

    const headers = new Headers(calls[0]!.headers as Record<string, string>);
    expect(headers.get('CF-Access-Client-Id')).toBe('id');
    expect(headers.get('CF-Access-Client-Secret')).toBe('secret');
    expect(calls[0]!.redirect).toBe('manual');
  });
});

describe('POST /abort (ADR-039)', () => {
  const abortReq = (runId: string, body?: string, nonce?: string) => {
    const bodyText = body ?? JSON.stringify({ run_id: runId });
    const headers = buildSignedHeaders(KEY, {
      method: 'POST',
      path: '/abort',
      runId,
      rawBody: bodyText,
      nowMs: NOW,
      nonce: nonce ?? `an-${Math.random()}`,
    });
    return {
      method: 'POST',
      path: '/abort',
      getHeader: (n: string) => headers[n] ?? null,
      bodyText,
    };
  };

  it('валідний підписаний abort рве активний прогін; без активного - aborted:false', async () => {
    const aborted: string[] = [];
    const { handler } = makeHandler({
      abortRun: (runId: string) => {
        aborted.push(runId);
        return runId === 'run-live';
      },
    });
    const live = await handler.handle(abortReq('run-live'));
    expect(live).toMatchObject({ status: 200, body: { ok: true, aborted: true } });
    const gone = await handler.handle(abortReq('run-gone'));
    expect(gone).toMatchObject({ status: 200, body: { ok: true, aborted: false } });
    expect(aborted).toEqual(['run-live', 'run-gone']);
  });

  it('сходинка: без підпису 401; run-mismatch 400; повтор нонса 401 replayed', async () => {
    const { handler } = makeHandler({ abortRun: () => true });
    const naked = await handler.handle({
      method: 'POST',
      path: '/abort',
      getHeader: () => null,
      bodyText: JSON.stringify({ run_id: 'r' }),
    });
    expect(naked.status).toBe(401);

    const mismatch = await handler.handle(abortReq('run-a', JSON.stringify({ run_id: 'run-b' })));
    expect(mismatch).toMatchObject({ status: 400, body: { error: 'run-mismatch' } });

    const first = abortReq('run-x', undefined, 'abort-n1');
    expect((await handler.handle(first)).status).toBe(200);
    expect(await handler.handle(first)).toMatchObject({ status: 401, body: { error: 'replayed' } });
  });
});

describe('POST /sessions/delete', () => {
  function deleteReq(body: string, nonce = `delete-${Math.random()}`) {
    const headers = buildSignedHeaders(KEY, {
      method: 'POST',
      path: '/sessions/delete',
      runId: 'deletion-1',
      rawBody: body,
      nowMs: NOW,
      nonce,
    });
    return {
      method: 'POST',
      path: '/sessions/delete',
      getHeader: (n: string) => headers[n] ?? null,
      bodyText: body,
    };
  }

  it('підписаний cleanup видаляє лише передані SDK-сесії й не повертає їх у відповідь', async () => {
    const received: string[][] = [];
    const { handler } = makeHandler({
      deleteSessions: async (ids) => {
        received.push(ids);
        return { deleted: ids.length, alreadyMissing: 0 };
      },
    });
    const body = JSON.stringify({ run_id: 'deletion-1', session_ids: ['s-1', 's-2'] });
    const out = await handler.handle(deleteReq(body, 'delete-once'));
    expect(out).toEqual({ status: 200, body: { ok: true, deleted: 2, alreadyMissing: 0 } });
    expect(received).toEqual([['s-1', 's-2']]);
    expect(await handler.handle(deleteReq(body, 'delete-once'))).toMatchObject({
      status: 401,
      body: { error: 'replayed' },
    });
  });

  it('active model run блокує cleanup без спалювання nonce', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler } = makeHandler({
      runner: () => gate,
      deleteSessions: async () => ({ deleted: 1, alreadyMissing: 0 }),
    });
    await handler.handle(signedReq(runBody()));
    const body = JSON.stringify({ run_id: 'deletion-1', session_ids: ['s-1'] });
    const req = deleteReq(body, 'delete-busy');
    expect(await handler.handle(req)).toMatchObject({
      status: 409,
      body: { error: 'active-runs' },
    });
    release();
    await vi.waitFor(() => expect(handler.activeRuns()).toBe(0));
    expect(await handler.handle(req)).toMatchObject({ status: 200, body: { deleted: 1 } });
  });
});
