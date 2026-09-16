// Handshake версій ядро↔мозок (етап 1, PR-9): порівняння з очікуваним,
// алерт лише за ЗМІНОЮ стану, тихий no-op до появи мозку, відновлення.
// Алерти йдуть через outbox (D1 - справжня міграція 0002) у TOPIC_SYSTEM.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  compareBrainVersions,
  checkBrainHandshake,
  BRAIN_EXPECTED_KEY,
  BRAIN_HEALTH_STATE_KEY,
  BRAIN_HEALTH_STALE_MS,
  brainHealthSnapshot,
} from '../web/core/brain/health.mjs';
import { workerEnv } from './helpers/env.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', '0002_assistant.sql'), 'utf8'),
  );
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          // @ts-expect-error node:sqlite приймає біндинги варіативно
          const info = db.prepare(sql).run(...args);
          return { meta: { changes: Number(info.changes) } };
        },
        all: async () => ({
          // @ts-expect-error те саме для all
          results: db.prepare(sql).all(...args),
        }),
      }),
    }),
  };
}

describe('compareBrainVersions — чиста звірка', () => {
  it('без очікуваного (деплоїв не було) — ok', () => {
    expect(compareBrainVersions(null, { version: '1.0.0', gitSha: 'abc' }).state).toBe('ok');
  });

  it('збіг — ok; інший sha чи version — desync із деталлю', () => {
    const exp = { version: '1.2.0', gitSha: 'aaaa1111aaaa1111' };
    expect(compareBrainVersions(exp, { version: '1.2.0', gitSha: 'aaaa1111aaaa1111' }).state).toBe(
      'ok',
    );
    const sha = compareBrainVersions(exp, { version: '1.2.0', gitSha: 'bbbb2222bbbb2222' });
    expect(sha.state).toBe('desync');
    expect(sha.detail).toContain('aaaa1111aaaa');
    expect(compareBrainVersions(exp, { version: '1.3.0', gitSha: 'aaaa1111aaaa1111' }).state).toBe(
      'desync',
    );
  });

  it('health без полів контракту 07 §3 — desync, не ok', () => {
    expect(compareBrainVersions({ gitSha: 'x' }, {} as never).state).toBe('desync');
  });
});

describe('checkBrainHandshake', () => {
  let kv: Map<string, string>;
  let tgSent: string[];
  let env: Env;

  const setFetch = (health: () => Promise<Response>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('api.telegram.org')) {
          tgSent.push(JSON.parse(String(init?.body)).text);
          return new Response('{"ok":true}', { status: 200 });
        }
        return health();
      }),
    );

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    kv = new Map();
    tgSent = [];
    env = workerEnv({
      BRAIN_URL: 'https://brain.test',
      BRAIN_ACCESS_CLIENT_ID: 'cid',
      BRAIN_ACCESS_CLIENT_SECRET: 'csec',
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_CHAT_ID: '-100',
      TOPIC_SYSTEM: '9',
      DB: d1(),
      BRIEFING: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        list: async () => ({ keys: [] }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('BRAIN_URL не заданий — тихий no-op (етап 1, мозку ще немає)', async () => {
    const bare = workerEnv({});
    const res = await checkBrainHandshake(bare, NOW);
    expect(res).toEqual({ skipped: 'not-configured' });
  });

  it('розсинхрон: алерт РІВНО ОДИН на зміну стану, не щотіка', async () => {
    kv.set(BRAIN_EXPECTED_KEY, JSON.stringify({ version: '1.0.0', gitSha: 'expected-sha' }));
    setFetch(
      async () =>
        new Response(JSON.stringify({ version: '1.0.0', gitSha: 'rogue-sha' }), { status: 200 }),
    );
    const first = await checkBrainHandshake(env, NOW);
    expect(first).toMatchObject({ state: 'desync', alerted: true });
    expect(tgSent).toHaveLength(1);
    expect(tgSent[0]).toContain('розсинхрон');
    // Другий тік із тим самим станом - тиша.
    const second = await checkBrainHandshake(env, NOW + 300_000);
    expect(second).toMatchObject({ state: 'desync', alerted: false });
    expect(tgSent).toHaveLength(1);
  });

  it('збіг версій — ok без алерту; Access-заголовки при пробі є', async () => {
    kv.set(BRAIN_EXPECTED_KEY, JSON.stringify({ version: '1.0.0', gitSha: 'same-sha' }));
    let seenHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        return new Response(JSON.stringify({ version: '1.0.0', gitSha: 'same-sha' }), {
          status: 200,
        });
      }),
    );
    const res = await checkBrainHandshake(env, NOW);
    expect(res).toMatchObject({ state: 'ok', alerted: false });
    expect(seenHeaders['cf-access-client-id']).toBe('cid');
    expect(seenHeaders['cf-access-client-secret']).toBe('csec');
  });

  it('оновлює мітку кожної health-проби; старий запис не може вдавати healthy', async () => {
    kv.set(BRAIN_EXPECTED_KEY, JSON.stringify({ version: '1.0.0', gitSha: 'same-sha' }));
    setFetch(
      async () =>
        new Response(JSON.stringify({ version: '1.0.0', gitSha: 'same-sha' }), { status: 200 }),
    );

    await checkBrainHandshake(env, NOW);
    expect(JSON.parse(kv.get(BRAIN_HEALTH_STATE_KEY) ?? '{}')).toMatchObject({
      state: 'ok',
      checkedAtMs: NOW,
    });

    await checkBrainHandshake(env, NOW + 300_000);
    expect(JSON.parse(kv.get(BRAIN_HEALTH_STATE_KEY) ?? '{}')).toMatchObject({
      state: 'ok',
      checkedAtMs: NOW + 300_000,
    });
    expect(await brainHealthSnapshot(env, NOW + 300_000)).toMatchObject({ state: 'ok' });
    expect(await brainHealthSnapshot(env, NOW + 300_000 + BRAIN_HEALTH_STALE_MS + 1)).toMatchObject(
      {
        state: 'stale',
      },
    );
  });

  it('down → алерт; відновлення → «знову в нормі»', async () => {
    setFetch(async () => new Response('gateway error', { status: 502 }));
    expect(await checkBrainHandshake(env, NOW)).toMatchObject({ state: 'down', alerted: true });
    expect(tgSent[0]).toContain('недоступний');

    setFetch(
      async () => new Response(JSON.stringify({ version: '1.0.0', gitSha: 'x' }), { status: 200 }),
    );
    const back = await checkBrainHandshake(env, NOW + 300_000);
    expect(back).toMatchObject({ state: 'ok', alerted: true });
    expect(tgSent.at(-1)).toContain('знову в нормі');
  });

  it('URL є, а Access-креденшлів немає — down із явною причиною', async () => {
    const misEnv = workerEnv({
      BRAIN_URL: 'https://brain.test',
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_CHAT_ID: '-100',
      DB: d1(),
      BRIEFING: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        list: async () => ({ keys: [] }),
      },
    });
    setFetch(async () => new Response('{}', { status: 200 }));
    const res = await checkBrainHandshake(misEnv, NOW);
    expect(res).toMatchObject({ state: 'down' });
  });
});
