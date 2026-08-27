// Internal API (етап 1, PR-5): підпис (метод+шлях+ts+run+nonce+тіло), TTL,
// nonce-антиреплей, run_id, контракти, маршрути. Приймальна сходинка PR:
// 401 без підпису → 403 невідомий прогін → 501 валідний виклик — кожна
// сходинка і кожен вектор реплею тут — тест.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  signInternal,
  verifyInternalRequest,
  INTERNAL_SIG_TTL_MS,
} from '../web/core/internal/auth.mjs';
import { validateAgainst, TOOL_REQUEST_SCHEMA } from '../web/core/internal/schemas.mjs';
import { handleInternal, MAX_INTERNAL_BODY_BYTES } from '../web/core/internal/router.mjs';
import { workerEnv } from './helpers/env.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const KEY = 'test-hmac-key';
const PATH = '/internal/tool/data.read';

type SignOpts = {
  method?: string;
  path?: string;
  runId?: string;
  key?: string;
  ts?: number;
  nonce?: string;
};

const signedHeaders = async (bodyText: string, opts: SignOpts = {}) => {
  const { method = 'POST', path = PATH, runId = 'r1', key = KEY, ts = NOW, nonce = 'n-1' } = opts;
  return {
    'X-Internal-Timestamp': String(ts),
    'X-Internal-Run': runId,
    'X-Internal-Nonce': nonce,
    'X-Internal-Signature': await signInternal(key, {
      method,
      path,
      timestampMs: ts,
      runId,
      nonce,
      rawBody: bodyText,
    }),
  };
};

const verify = (
  headers: Record<string, string>,
  bodyText: string,
  env: Record<string, unknown>,
  opts: { method?: string; path?: string; nowMs?: number } = {},
) =>
  verifyInternalRequest({
    method: opts.method ?? 'POST',
    path: opts.path ?? PATH,
    headers: new Headers(headers),
    bodyText,
    nowMs: opts.nowMs ?? NOW,
    env: env as never,
  });

describe('verifyInternalRequest — підпис і TTL', () => {
  const env = { INTERNAL_HMAC_KEY: KEY };

  it('валідний підпис проходить і повертає runId + nonce', async () => {
    const res = await verify(await signedHeaders('{"a":1}'), '{"a":1}', env);
    expect(res).toEqual({ ok: true, runId: 'r1', nonce: 'n-1' });
  });

  it('чужий ключ — bad-signature, не інша помилка (діагностованість)', async () => {
    const res = await verify(await signedHeaders('{}', { key: 'wrong' }), '{}', env);
    expect(res).toMatchObject({ ok: false, status: 401, error: 'bad-signature' });
  });

  it('підпис не переноситься: інше тіло, інший runId, інший nonce', async () => {
    const h = await signedHeaders('{"a":1}');
    expect(await verify(h, '{"a":2}', env)).toMatchObject({ error: 'bad-signature' });
    expect(await verify({ ...h, 'X-Internal-Run': 'r2' }, '{"a":1}', env)).toMatchObject({
      error: 'bad-signature',
    });
    expect(await verify({ ...h, 'X-Internal-Nonce': 'n-2' }, '{"a":1}', env)).toMatchObject({
      error: 'bad-signature',
    });
  });

  it('підпис не переноситься на ІНШИЙ ендпоїнт і метод — шлях у повідомленні', async () => {
    // Головний вектор із security-ревʼю: статусний рядок, перекинутий на
    // /internal/deliver, ставав би доставленим повідомленням.
    const h = await signedHeaders('{"text":"x"}', { path: '/internal/status' });
    expect(await verify(h, '{"text":"x"}', env, { path: '/internal/deliver' })).toMatchObject({
      error: 'bad-signature',
    });
    expect(
      await verify(h, '{"text":"x"}', env, { path: '/internal/status', method: 'PUT' }),
    ).toMatchObject({ error: 'bad-signature' });
    expect(await verify(h, '{"text":"x"}', env, { path: '/internal/status' })).toMatchObject({
      ok: true,
    });
  });

  it('ключ ротації INTERNAL_HMAC_KEY_NEXT теж приймається (05-ops §3)', async () => {
    const res = await verify(await signedHeaders('{}', { key: 'next-key' }), '{}', {
      INTERNAL_HMAC_KEY: KEY,
      INTERNAL_HMAC_KEY_NEXT: 'next-key',
    });
    expect(res).toMatchObject({ ok: true });
  });

  it('ключ із хвостовим \\r\\n працює — задокументована пастка секретів', async () => {
    const res = await verify(await signedHeaders('{}'), '{}', {
      INTERNAL_HMAC_KEY: `${KEY}\r\n`,
    });
    expect(res).toMatchObject({ ok: true });
  });

  it('TTL: старіший за 10 хв — stale, молодший — проходить, обидва боки скью', async () => {
    const old = NOW - INTERNAL_SIG_TTL_MS - 1;
    expect(await verify(await signedHeaders('{}', { ts: old }), '{}', env)).toMatchObject({
      error: 'stale-timestamp',
    });
    const future = NOW + INTERNAL_SIG_TTL_MS + 1;
    expect(await verify(await signedHeaders('{}', { ts: future }), '{}', env)).toMatchObject({
      error: 'stale-timestamp',
    });
    const edge = NOW - INTERNAL_SIG_TTL_MS + 1_000;
    expect(await verify(await signedHeaders('{}', { ts: edge }), '{}', env)).toMatchObject({
      ok: true,
    });
  });

  it('бракує будь-якого заголовка — 401 missing-auth', async () => {
    const h = await signedHeaders('{}');
    for (const drop of [
      'X-Internal-Timestamp',
      'X-Internal-Run',
      'X-Internal-Nonce',
      'X-Internal-Signature',
    ]) {
      const partial: Record<string, string> = { ...h };
      delete partial[drop];
      expect(await verify(partial, '{}', env)).toMatchObject({ status: 401 });
    }
  });

  it('ключі не задані — 500 hmac-not-configured, НЕ 401 (misconfig ≠ атака)', async () => {
    expect(await verify(await signedHeaders('{}'), '{}', {})).toMatchObject({
      status: 500,
      error: 'hmac-not-configured',
    });
    // Рядок із пробілів = незаданий ключ (та сама семантика, що validateInitData).
    expect(
      await verify(await signedHeaders('{}'), '{}', { INTERNAL_HMAC_KEY: '  ' }),
    ).toMatchObject({ status: 500 });
  });
});

describe('validateAgainst — контракти', () => {
  it('tool: args обовʼязковий обʼєкт; помилка називає шлях', () => {
    expect(validateAgainst(TOOL_REQUEST_SCHEMA, { args: {} })).toEqual({ ok: true });
    expect(validateAgainst(TOOL_REQUEST_SCHEMA, {})).toMatchObject({
      ok: false,
      error: '$: бракує поля "args"',
    });
    expect(validateAgainst(TOOL_REQUEST_SCHEMA, { args: 'x' })).toMatchObject({
      ok: false,
      error: '$.args: очікується обʼєкт',
    });
  });
});

describe('handleInternal — маршрутизатор', () => {
  let env: Env;
  let consumed: Set<string>;

  const request = async (
    path: string,
    bodyObj: unknown,
    opts: SignOpts & { method?: string; sign?: boolean; rawBody?: string } = {},
  ) => {
    const body = opts.rawBody ?? JSON.stringify(bodyObj);
    const headers: Record<string, string> =
      opts.sign === false ? {} : await signedHeaders(body, { ...opts, path });
    return new Request(`https://svitanok.test${path}`, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.method === 'GET' ? undefined : body,
    });
  };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    consumed = new Set();
    env = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async (runId: string, nonce: string) => {
            const key = `${runId}:${nonce}`;
            if (consumed.has(key)) return false;
            consumed.add(key);
            return true;
          },
        }),
      },
    });
  });

  it('off: 404 як для неіснуючого шляху — код «не існує»', async () => {
    const offEnv = workerEnv({ INTERNAL_HMAC_KEY: KEY });
    const res = await handleInternal(await request(PATH, { args: {} }), offEnv, NOW);
    expect(res.status).toBe(404);
  });

  it('не-POST — 405', async () => {
    const res = await handleInternal(await request(PATH, {}, { method: 'GET' }), env, NOW);
    expect(res.status).toBe(405);
  });

  it('без підпису — 401, робота не виконується', async () => {
    const res = await handleInternal(await request(PATH, { args: {} }, { sign: false }), env, NOW);
    expect(res.status).toBe(401);
  });

  it('підпис є, прогін невідомий реєстру — 403 run-unknown', async () => {
    const res = await handleInternal(
      await request(PATH, { args: {} }, { runId: 'ghost' }),
      env,
      NOW,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'run-unknown' });
  });

  it('той самий підписаний запит удруге — 401 replayed (nonce спожито)', async () => {
    const args = { args: { scope: 'reminders' } };
    const first = await handleInternal(await request(PATH, args), env, NOW);
    expect(first.status).toBe(200);
    const second = await handleInternal(await request(PATH, args), env, NOW);
    expect(second.status).toBe(401);
    expect(await second.json()).toMatchObject({ error: 'replayed' });
    // Інший nonce — інший запит: проходить.
    const third = await handleInternal(await request(PATH, args, { nonce: 'n-2' }), env, NOW);
    expect(third.status).toBe(200);
  });

  it('валідний виклик інструмента виконується: 200 {ok, tool, tainted, result}', async () => {
    const res = await handleInternal(
      await request(PATH, { args: { scope: 'reminders' } }),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      tool: string;
      tainted: boolean;
      result: unknown;
    };
    expect(body).toMatchObject({ ok: true, tool: 'data.read', tainted: false });
    expect(typeof body.result).toBe('string');
  });

  it('невідомий інструмент — 404 tool-unknown (імʼя обмежене регексом)', async () => {
    const res = await handleInternal(
      await request('/internal/tool/mail.explode', { args: {} }),
      env,
      NOW,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'tool-unknown' });
  });

  it('args поза контрактом інструмента — 400 зі шляхом (days > 7)', async () => {
    const res = await handleInternal(
      await request('/internal/tool/calendar.read', { args: { days: 9 } }),
      env,
      NOW,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'contract: $.days: більше за 7' });
  });

  it('збій джерела — 502 tool-failed із причиною, не тиха деградація', async () => {
    // geo.geocode без WEATHER_API_KEY кидає — рівно той шлях.
    const res = await handleInternal(
      await request('/internal/tool/geo.geocode', { args: { text: 'Львів' } }),
      env,
      NOW,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'tool-failed', tool: 'geo.geocode' });
  });

  it('tainting-інструмент ставить sessions.tainted=1 треду прогону', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 })),
    );
    const sessionWrites: { sql: string; args: unknown[] }[] = [];
    const taintEnv = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      GOOGLE_CLIENT_ID: 'c',
      GOOGLE_CLIENT_SECRET: 's',
      GOOGLE_REFRESH_TOKEN: 'r',
      BRIEFING: {
        get: async (k: string) =>
          k === 'googleToken' ? JSON.stringify({ token: 't', expMs: NOW + 3_600_000 }) : null,
        put: async () => {},
        list: async () => ({ keys: [] }),
      },
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              sessionWrites.push({ sql, args });
            },
          }),
        }),
      },
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async () => true,
          runInfo: async () => ({ threadId: 'thread-7' }),
        }),
      },
    });
    const res = await handleInternal(
      await request('/internal/tool/mail.search', { args: { q: 'пошта' } }),
      taintEnv,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tainted: true });
    expect(sessionWrites).toHaveLength(1);
    expect(sessionWrites[0]?.sql).toContain('INSERT INTO sessions');
    expect(sessionWrites[0]?.sql).toContain('tainted = 1');
    expect(sessionWrites[0]?.args[0]).toBe('thread-7');
    vi.unstubAllGlobals();
  });

  it('порушення контракту — 400 зі шляхом поля', async () => {
    const res = await handleInternal(await request(PATH, {}), env, NOW);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'contract: $: бракує поля "args"' });
  });

  it('битий JSON — 400 bad-json (підпис перевіряється ПО сирому тілу раніше)', async () => {
    const res = await handleInternal(
      await request('/internal/deliver', null, { rawBody: '{не json' }),
      env,
      NOW,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad-json' });
  });

  it('deliver/status/runs — контракти живі, виконавців ще немає (501)', async () => {
    const post = (path: string, body: unknown, nonce: string) =>
      request(path, body, { nonce }).then((r) => handleInternal(r, env, NOW));
    expect((await post('/internal/deliver', { text: 'привіт' }, 'a')).status).toBe(501);
    expect((await post('/internal/status', { text: '▸ думаю' }, 'b')).status).toBe(501);
    expect((await post('/internal/runs', { steps: [] }, 'c')).status).toBe(501);
    expect((await post('/internal/deliver', { no: 'text' }, 'd')).status).toBe(400);
  });

  it('невідомий /internal/шлях — 404 (після auth, не до)', async () => {
    const res = await handleInternal(await request('/internal/whatever', {}), env, NOW);
    expect(res.status).toBe(404);
  });

  it('тіло понад кап — 413 до будь-якої криптографії', async () => {
    const big = 'x'.repeat(MAX_INTERNAL_BODY_BYTES + 1);
    const res = await handleInternal(
      new Request('https://svitanok.test/internal/deliver', {
        method: 'POST',
        headers: { 'content-length': String(big.length) },
        body: big,
      }),
      env,
      NOW,
    );
    expect(res.status).toBe(413);
  });

  it('тіло без Content-Length (chunked) понад кап — теж 413, потік рветься на стелі', async () => {
    // Вектор з ультраревʼю: arrayBuffer() матеріалізував би все тіло ДО капу,
    // коли заголовка немає. readCappedBody рве стрім на першому байті понад
    // стелю — памʼять обмежена стелею плюс один шматок.
    const chunk = new Uint8Array(64 * 1024).fill(120);
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent > MAX_INTERNAL_BODY_BYTES + chunk.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const req = new Request('https://svitanok.test/internal/deliver', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull(); // саме той вектор
    const res = await handleInternal(req, env, NOW);
    expect(res.status).toBe(413);
  });

  it('POST без тіла — 400 no-body, не виняток', async () => {
    const res = await handleInternal(
      new Request('https://svitanok.test/internal/deliver', { method: 'POST' }),
      env,
      NOW,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no-body' });
  });

  it('збій реєстру = відмова (fail-closed), не пропуск', async () => {
    const broken = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async () => {
            throw new Error('DO впав');
          },
        }),
      },
    });
    const res = await handleInternal(await request(PATH, { args: {} }), broken, NOW);
    expect(res.status).toBe(403);
  });
});
