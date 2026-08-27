// POST /internal/session (ADR-038): єдиний канал, яким мозок оновлює сесійний
// стан. На СПРАВЖНІЙ міграції 0001 (node:sqlite): upsert, COALESCE-семантика
// (виклик без поля не затирає збережене), turn_count-інкремент, незмінність
// tainted (мозок не сміє знімати прапорець), сходинка відмов роутера.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signInternal } from '../web/core/internal/auth.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { workerEnv } from './helpers/env.js';

const KEY = 'session-test-key';
const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const PATH = '/internal/session';

const d1FromSqlite = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', '0001_base.sql'), 'utf8'),
  );
  return {
    db,
    stub: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            // @ts-expect-error node:sqlite приймає біндинги варіативно
            db.prepare(sql).run(...args);
          },
          all: async () => ({
            // @ts-expect-error те саме для all
            results: db.prepare(sql).all(...args),
          }),
        }),
      }),
    },
  };
};

let nonceSeq = 0;
const request = async (bodyObj: unknown, opts: { rawBody?: string } = {}) => {
  const body = opts.rawBody ?? JSON.stringify(bodyObj);
  nonceSeq += 1;
  const nonce = `n-${nonceSeq}`;
  return new Request(`https://svitanok.test${PATH}`, {
    method: 'POST',
    headers: {
      'X-Internal-Timestamp': String(NOW),
      'X-Internal-Run': 'r1',
      'X-Internal-Nonce': nonce,
      'X-Internal-Signature': await signInternal(KEY, {
        method: 'POST',
        path: PATH,
        timestampMs: NOW,
        runId: 'r1',
        nonce,
        rawBody: body,
      }),
    },
    body,
  });
};

describe('POST /internal/session', () => {
  let env: Env;
  let db: DatabaseSync;

  const sessionRow = (threadId: string) =>
    db.prepare('SELECT * FROM sessions WHERE thread_id = ?').get(threadId) as
      Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d1 = d1FromSqlite();
    db = d1.db;
    const consumed = new Set<string>();
    env = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      DB: d1.stub,
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

  it('новий тред: insert з sdk_session_id, tainted=0, turn_count=turns_inc', async () => {
    const res = await handleInternal(
      await request({ thread_id: 'dm', sdk_session_id: 'sess-1', turns_inc: 1 }),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, thread_id: 'dm' });
    expect(sessionRow('dm')).toMatchObject({
      sdk_session_id: 'sess-1',
      tainted: 0,
      turn_count: 1,
      summary_md: null,
    });
  });

  it('COALESCE: виклик без summary_md не затирає збережену згортку і навпаки', async () => {
    await handleInternal(
      await request({ thread_id: 'dm', sdk_session_id: 'sess-1', summary_md: 'Згортка дня' }),
      env,
      NOW,
    );
    // Лише інкремент ходів - згортка і сесія лишаються.
    await handleInternal(await request({ thread_id: 'dm', turns_inc: 2 }), env, NOW + 1000);
    expect(sessionRow('dm')).toMatchObject({
      sdk_session_id: 'sess-1',
      summary_md: 'Згортка дня',
      turn_count: 2,
    });
    // Нова згортка без sdk_session_id - сесія лишається, згортка оновлюється.
    await handleInternal(await request({ thread_id: 'dm', summary_md: 'Нова' }), env, NOW + 2000);
    expect(sessionRow('dm')).toMatchObject({ sdk_session_id: 'sess-1', summary_md: 'Нова' });
    expect(String(sessionRow('dm')?.last_at)).toBe(new Date(NOW + 2000).toISOString());
  });

  it('tainted НЕ чіпається: прапорець, поставлений ядром, переживає будь-який виклик мозку', async () => {
    db.prepare(
      `INSERT INTO sessions (thread_id, started_at, last_at, tainted, turn_count)
       VALUES ('dm', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z', 1, 5)`,
    ).run();
    await handleInternal(
      await request({ thread_id: 'dm', sdk_session_id: 'sess-2', summary_md: 'x', turns_inc: 1 }),
      env,
      NOW,
    );
    expect(sessionRow('dm')).toMatchObject({ tainted: 1, turn_count: 6, sdk_session_id: 'sess-2' });
  });

  it('контракт: без thread_id - 400 зі шляхом поля; зайва довжина - 400', async () => {
    const missing = await handleInternal(await request({ sdk_session_id: 's' }), env, NOW);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'contract: $: бракує поля "thread_id"' });

    const long = await handleInternal(
      await request({ thread_id: 'dm', summary_md: 'а'.repeat(20_001) }),
      env,
      NOW,
    );
    expect(long.status).toBe(400);
  });

  it('без DB - 500 db-not-configured; збій D1 - 500 session-not-persisted', async () => {
    (env as { DB?: unknown }).DB = undefined;
    const noDb = await handleInternal(await request({ thread_id: 'dm' }), env, NOW);
    expect(noDb.status).toBe(500);
    expect(await noDb.json()).toMatchObject({ error: 'db-not-configured' });

    (env as { DB?: unknown }).DB = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('D1 упав');
          },
        }),
      }),
    };
    const broken = await handleInternal(await request({ thread_id: 'dm' }), env, NOW);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ error: 'session-not-persisted' });
  });

  it('без підпису - 401 (сходинка роутера діє і для session)', async () => {
    const naked = new Request(`https://svitanok.test${PATH}`, {
      method: 'POST',
      body: JSON.stringify({ thread_id: 'dm' }),
    });
    const res = await handleInternal(naked, env, NOW);
    expect(res.status).toBe(401);
  });
});
