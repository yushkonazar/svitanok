// Internal API (етап 1, PR-5): підпис, TTL, run_id, контракти, маршрути.
// Приймальна сходинка цього PR: 401 без підпису → 403 невідомий прогін →
// 501 валідний виклик (виконавці — наступні PR-и). Кожна сходинка тут — тест.

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

const verify = (
  headers: Record<string, string>,
  bodyText: string,
  env: Record<string, unknown>,
  nowMs = NOW,
) =>
  verifyInternalRequest({
    headers: new Headers(headers),
    bodyText,
    nowMs,
    env: env as never,
  });

const signedHeaders = async (bodyText: string, { runId = 'r1', key = KEY, ts = NOW } = {}) => ({
  'X-Internal-Timestamp': String(ts),
  'X-Internal-Run': runId,
  'X-Internal-Signature': await signInternal(key, ts, runId, bodyText),
});

describe('verifyInternalRequest — підпис і TTL', () => {
  const env = { INTERNAL_HMAC_KEY: KEY };

  it('валідний підпис проходить і повертає runId', async () => {
    const res = await verify(await signedHeaders('{"a":1}'), '{"a":1}', env);
    expect(res).toEqual({ ok: true, runId: 'r1' });
  });

  it('чужий ключ — bad-signature, не інша помилка (діагностованість)', async () => {
    const res = await verify(await signedHeaders('{}', { key: 'wrong' }), '{}', env);
    expect(res).toMatchObject({ ok: false, status: 401, error: 'bad-signature' });
  });

  it('підпис не переноситься на інше тіло і інший runId', async () => {
    const h = await signedHeaders('{"a":1}');
    expect(await verify(h, '{"a":2}', env)).toMatchObject({ error: 'bad-signature' });
    expect(await verify({ ...h, 'X-Internal-Run': 'r2' }, '{"a":1}', env)).toMatchObject({
      error: 'bad-signature',
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
    for (const drop of ['X-Internal-Timestamp', 'X-Internal-Run', 'X-Internal-Signature']) {
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

  const request = async (
    path: string,
    bodyObj: unknown,
    opts: { runId?: string; key?: string; ts?: number; method?: string; sign?: boolean } = {},
  ) => {
    const body = JSON.stringify(bodyObj);
    const headers: Record<string, string> =
      opts.sign === false ? {} : await signedHeaders(body, opts);
    return new Request(`https://svitanok.test${path}`, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.method === 'GET' ? undefined : body,
    });
  };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      RUN_REGISTRY: { getByName: () => ({ has: async (id: string) => id === 'r1' }) },
    });
  });

  it('off: 404 як для неіснуючого шляху — код «не існує»', async () => {
    const offEnv = workerEnv({ INTERNAL_HMAC_KEY: KEY });
    const res = await handleInternal(
      await request('/internal/tool/data.read', { args: {} }),
      offEnv,
      NOW,
    );
    expect(res.status).toBe(404);
  });

  it('не-POST — 405', async () => {
    const res = await handleInternal(
      await request('/internal/tool/data.read', {}, { method: 'GET' }),
      env,
      NOW,
    );
    expect(res.status).toBe(405);
  });

  it('без підпису — 401, робота не виконується', async () => {
    const res = await handleInternal(
      await request('/internal/tool/data.read', { args: {} }, { sign: false }),
      env,
      NOW,
    );
    expect(res.status).toBe(401);
  });

  it('підпис є, прогін невідомий реєстру — 403 run-unknown', async () => {
    const res = await handleInternal(
      await request('/internal/tool/data.read', { args: {} }, { runId: 'ghost' }),
      env,
      NOW,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'run-unknown' });
  });

  it('валідний виклик інструмента — 501 not-implemented з імʼям (PR-6 замінить)', async () => {
    const res = await handleInternal(
      await request('/internal/tool/data.read', { args: { scope: 'briefing' } }),
      env,
      NOW,
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: 'not-implemented', tool: 'data.read' });
  });

  it('порушення контракту — 400 зі шляхом поля', async () => {
    const res = await handleInternal(await request('/internal/tool/data.read', {}), env, NOW);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'contract: $: бракує поля "args"' });
  });

  it('битий JSON — 400 bad-json (підпис перевіряється ПО сирому тілу раніше)', async () => {
    const bodyText = '{не json';
    const headers = await signedHeaders(bodyText);
    const res = await handleInternal(
      new Request('https://svitanok.test/internal/deliver', {
        method: 'POST',
        headers,
        body: bodyText,
      }),
      env,
      NOW,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad-json' });
  });

  it('deliver/status/runs — контракти живі, виконавців ще немає (501)', async () => {
    expect(
      (await handleInternal(await request('/internal/deliver', { text: 'привіт' }), env, NOW))
        .status,
    ).toBe(501);
    expect(
      (await handleInternal(await request('/internal/status', { text: '▸ думаю' }), env, NOW))
        .status,
    ).toBe(501);
    expect(
      (await handleInternal(await request('/internal/runs', { steps: [] }), env, NOW)).status,
    ).toBe(501);
    expect(
      (await handleInternal(await request('/internal/deliver', { no: 'text' }), env, NOW)).status,
    ).toBe(400);
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
    const res = await handleInternal(
      await request('/internal/tool/data.read', { args: {} }),
      broken,
      NOW,
    );
    expect(res.status).toBe(403);
  });
});
