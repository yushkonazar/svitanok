// Парність підпису мозок↔ядро (ADR-037): мозок (brain/src/sign.ts, node:crypto)
// мусить давати БАЙТ-У-БАЙТ той самий hex, що ядро (web/core/internal/auth.mjs,
// crypto.subtle), і збудовані мозком заголовки мусять проходити ядровий verify.
// Це контракт, який не видно жодним типом - лише прогоном обох реалізацій.

import { describe, expect, it } from 'vitest';
import {
  INTERNAL_SIG_TTL_MS as CORE_TTL,
  signInternal as coreSign,
  verifyInternalRequest,
} from '../web/core/internal/auth.mjs';
import {
  INTERNAL_SIG_TTL_MS,
  buildSignedHeaders,
  signInternal,
  verifySignedRequest,
} from '../brain/src/sign.js';
import { NonceCache } from '../brain/src/nonces.js';
import { workerEnv } from './helpers/env.js';

const KEY = 'test-hmac-key-1';
const INPUT = {
  method: 'POST',
  path: '/internal/tool/data.read',
  timestampMs: 1_756_300_000_000,
  runId: 'run-01',
  nonce: 'nonce-01',
  rawBody: '{"args":{"scope":"briefing"}}',
};

describe('парність підпису мозок↔ядро', () => {
  it('той самий hex на тих самих входах (і на юнікоді в тілі)', async () => {
    expect(signInternal(KEY, INPUT)).toBe(await coreSign(KEY, INPUT));
    const uk = { ...INPUT, rawBody: '{"text":"привіт, Світанку 🌅"}' };
    expect(signInternal(KEY, uk)).toBe(await coreSign(KEY, uk));
  });

  it('TTL мозку = TTL ядра', () => {
    expect(INTERNAL_SIG_TTL_MS).toBe(CORE_TTL);
  });

  it('заголовки, збудовані мозком, проходять ядровий verify', async () => {
    const headers = buildSignedHeaders(KEY, {
      method: INPUT.method,
      path: INPUT.path,
      runId: INPUT.runId,
      rawBody: INPUT.rawBody,
      nowMs: INPUT.timestampMs,
    });
    const res = await verifyInternalRequest({
      method: INPUT.method,
      path: INPUT.path,
      headers: new Headers(headers),
      bodyText: INPUT.rawBody,
      nowMs: INPUT.timestampMs + 1000,
      env: workerEnv({ INTERNAL_HMAC_KEY: KEY }),
    });
    expect(res).toMatchObject({ ok: true, runId: INPUT.runId });
  });

  it('підписане ядром проходить перевірку мозку (зворотний бік)', async () => {
    const signature = await coreSign(KEY, INPUT);
    const headers = new Map([
      ['X-Internal-Timestamp', String(INPUT.timestampMs)],
      ['X-Internal-Run', INPUT.runId],
      ['X-Internal-Nonce', INPUT.nonce],
      ['X-Internal-Signature', signature],
    ]);
    const res = verifySignedRequest({
      method: INPUT.method,
      path: INPUT.path,
      getHeader: (n) => headers.get(n) ?? null,
      bodyText: INPUT.rawBody,
      nowMs: INPUT.timestampMs,
      keys: [KEY],
    });
    expect(res).toMatchObject({ ok: true, runId: INPUT.runId, nonce: INPUT.nonce });
  });
});

describe('перевірка /run на боці мозку', () => {
  // Через бойовий buildSignedHeaders (а не ручну збірку): інакше перейменування
  // заголовка в білдері лишило б ці тести зеленими на форматі, якого ніхто не шле.
  function signedHeaders(over: Partial<typeof INPUT> = {}) {
    const i = { ...INPUT, ...over };
    const headers = buildSignedHeaders(KEY, {
      method: i.method,
      path: i.path,
      runId: i.runId,
      rawBody: i.rawBody,
      nowMs: i.timestampMs,
      nonce: i.nonce,
    });
    return (n: string) => headers[n] ?? null;
  }

  it('підміна тіла, методу або шляху ламає підпис', () => {
    const base = {
      getHeader: signedHeaders(),
      bodyText: INPUT.rawBody,
      nowMs: INPUT.timestampMs,
      keys: [KEY],
    };
    expect(verifySignedRequest({ ...base, method: 'POST', path: INPUT.path })).toMatchObject({
      ok: true,
    });
    expect(
      verifySignedRequest({ ...base, method: 'POST', path: INPUT.path, bodyText: '{"args":{}}' }),
    ).toMatchObject({ ok: false, status: 401, error: 'bad-signature' });
    expect(verifySignedRequest({ ...base, method: 'PUT', path: INPUT.path })).toMatchObject({
      ok: false,
      error: 'bad-signature',
    });
    expect(
      verifySignedRequest({ ...base, method: 'POST', path: '/internal/deliver' }),
    ).toMatchObject({ ok: false, error: 'bad-signature' });
  });

  it('прострочена мітка - stale-timestamp, невалідна - bad-timestamp, без заголовків - missing-auth', () => {
    const base = { method: 'POST', path: INPUT.path, bodyText: INPUT.rawBody, keys: [KEY] };
    expect(
      verifySignedRequest({
        ...base,
        getHeader: signedHeaders(),
        nowMs: INPUT.timestampMs + INTERNAL_SIG_TTL_MS + 1,
      }),
    ).toMatchObject({ ok: false, status: 401, error: 'stale-timestamp' });

    const broken = signedHeaders();
    expect(
      verifySignedRequest({
        ...base,
        getHeader: (n) => (n === 'X-Internal-Timestamp' ? 'не-число' : broken(n)),
        nowMs: INPUT.timestampMs,
      }),
    ).toMatchObject({ ok: false, status: 401, error: 'bad-timestamp' });

    expect(
      verifySignedRequest({ ...base, getHeader: () => null, nowMs: INPUT.timestampMs }),
    ).toMatchObject({ ok: false, status: 401, error: 'missing-auth' });
  });

  it('двоключова ротація: підпис ключем NEXT приймається', () => {
    const NEXT = 'test-hmac-key-2';
    const res = verifySignedRequest({
      method: INPUT.method,
      path: INPUT.path,
      getHeader: (n) => {
        const h = buildSignedHeaders(NEXT, {
          method: INPUT.method,
          path: INPUT.path,
          runId: INPUT.runId,
          rawBody: INPUT.rawBody,
          nowMs: INPUT.timestampMs,
          nonce: INPUT.nonce,
        });
        return h[n as keyof typeof h] ?? null;
      },
      bodyText: INPUT.rawBody,
      nowMs: INPUT.timestampMs,
      keys: [KEY, NEXT],
    });
    expect(res).toMatchObject({ ok: true });
  });

  it('без ключів - 500 hmac-not-configured (fail-closed, не 401)', () => {
    expect(
      verifySignedRequest({
        method: INPUT.method,
        path: INPUT.path,
        getHeader: signedHeaders(),
        bodyText: INPUT.rawBody,
        nowMs: INPUT.timestampMs,
        keys: [],
      }),
    ).toMatchObject({ ok: false, status: 500, error: 'hmac-not-configured' });
  });
});

describe('NonceCache', () => {
  it('перше споживання true, повтор false, після TTL - знову true', () => {
    const cache = new NonceCache(1000);
    expect(cache.consume('r1', 'n1', 0)).toBe(true);
    expect(cache.consume('r1', 'n1', 500)).toBe(false);
    expect(cache.consume('r1', 'n2', 500)).toBe(true);
    expect(cache.consume('r2', 'n1', 500)).toBe(true);
    expect(cache.consume('r1', 'n1', 1001)).toBe(true);
  });

  it('протухлі записи прибираються (память не тече)', () => {
    const cache = new NonceCache(1000);
    for (let n = 0; n < 50; n += 1) cache.consume('r', `n${n}`, n);
    expect(cache.size).toBe(50);
    cache.consume('r', 'late', 5000);
    expect(cache.size).toBe(1);
  });
});
