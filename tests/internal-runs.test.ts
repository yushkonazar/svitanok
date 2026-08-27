// POST /internal/runs (дротування етапу 2 PR-2): кроки мозку в run_steps на
// СПРАВЖНІЙ міграції 0003 + закриття прогону в RunRegistry. Поля коерсяться
// дбайливо (контракт гарантує лише масив обʼєктів), kind='error' у кроках →
// finish з error='brain-error'.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signInternal } from '../web/core/internal/auth.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { workerEnv } from './helpers/env.js';

const KEY = 'runs-test-key';
const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const PATH = '/internal/runs';

const d1FromSqlite = () => {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0001_base.sql', '0003_telemetry.sql']) {
    db.exec(readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', file), 'utf8'));
  }
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
const request = async (bodyObj: unknown) => {
  const body = JSON.stringify(bodyObj);
  nonceSeq += 1;
  const nonce = `rn-${nonceSeq}`;
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

describe('POST /internal/runs', () => {
  let env: Env;
  let db: DatabaseSync;
  let finishes: { id: string; patch: Record<string, unknown> }[];

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d1 = d1FromSqlite();
    db = d1.db;
    finishes = [];
    env = workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      DB: d1.stub,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async (id: string) => id === 'r1',
          consumeNonce: async () => true,
          finish: async (id: string, patch: Record<string, unknown>) =>
            void finishes.push({ id, patch }),
        }),
      },
    });
  });

  it('кроки пишуться в run_steps як прийшли; finish зі steps-лічильником, без error', async () => {
    const res = await handleInternal(
      await request({
        steps: [
          { n: 1, at: '2026-08-27T11:59:00Z', kind: 'tool', name: 'data.read', ms: 120, ok: true },
          { n: 2, at: '2026-08-27T11:59:05Z', kind: 'reply', name: 'deliver', ms: 5000, ok: true },
        ],
      }),
      env,
      NOW,
    );
    expect(await res.json()).toMatchObject({ ok: true, steps: 2 });
    const rows = db.prepare('SELECT * FROM run_steps ORDER BY n').all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ run_id: 'r1', n: 1, kind: 'tool', name: 'data.read', ok: 1 });
    expect(rows[1]).toMatchObject({ kind: 'reply', ms: 5000 });
    expect(finishes).toEqual([{ id: 'r1', patch: { finishedMs: NOW, error: null, steps: 2 } }]);
  });

  it('kind=error серед кроків → finish з error=brain-error', async () => {
    await handleInternal(
      await request({ steps: [{ kind: 'error', name: 'chat', note: 'таймаут профілю' }] }),
      env,
      NOW,
    );
    expect(finishes[0]!.patch).toMatchObject({ error: 'brain-error' });
  });

  it('криві поля коерсяться, а не валять телеметрію: n з індексу, note ріжеться', async () => {
    const res = await handleInternal(
      await request({ steps: [{ ms: 'не число', note: 'х'.repeat(600), ok: 0 }] }),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT * FROM run_steps').get() as Record<string, unknown>;
    expect(row).toMatchObject({ n: 1, kind: 'tool', ms: null, ok: 0 });
    expect(String(row.note)).toHaveLength(500);
  });

  it('збій D1 - явний 500 steps-not-persisted; порожні steps - ok, лише finish', async () => {
    const empty = await handleInternal(await request({ steps: [] }), env, NOW);
    expect(await empty.json()).toMatchObject({ ok: true, steps: 0 });
    expect(finishes).toHaveLength(1);

    (env as { DB?: unknown }).DB = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('D1 упав');
          },
        }),
      }),
    };
    const broken = await handleInternal(await request({ steps: [{ n: 1 }] }), env, NOW);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ error: 'steps-not-persisted' });
  });
});
