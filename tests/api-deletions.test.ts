import { describe, expect, it } from 'vitest';
import worker from '../web/worker.js';
import { handleDeletions } from '../web/api-deletions.mjs';
import {
  DELETION_RECEIPT_KEY,
  DELETION_RECEIPT_HISTORY_PREFIX,
  DELETION_RECEIPT_RETENTION_DAYS,
} from '../web/core/export/forget-all.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { deletionsSchema } from '../web/app/src/api/schema.ts';

const NOW = Date.parse('2026-09-17T10:00:00.000Z');

function receipt(over: Record<string, unknown> = {}) {
  return {
    id: 'del-private-id',
    requestedAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:02:00.000Z',
    status: 'completed',
    scope: 'all',
    stages: {
      queues: { status: 'completed', count: 2 },
      sdkSessions: { status: 'completed', count: 3 },
      vectors: { status: 'completed', count: 4 },
      backups: { status: 'completed', count: 1 },
      local: { status: 'completed', rows: 10, kvKeys: 5 },
    },
    ...over,
  };
}

function envWith(entries: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  return workerEnv({
    BRIEFING: memoryKv(store, { listKeys: () => [...store.keys()] }),
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  });
}

describe('GET /api/deletions — приватний read-only звіт T2', () => {
  it('не пускає без initData і не відкриває приватні лічильники', async () => {
    const env = envWith({
      [`${DELETION_RECEIPT_HISTORY_PREFIX}20260916-del-private-id`]: receipt(),
    });
    const res = await worker.fetch(new Request('https://svitanok.yushko.dev/api/deletions'), env, {
      waitUntil: () => {},
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('sdkSessions');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('лише GET: POST не проходить навіть до auth/KV', async () => {
    const res = await worker.fetch(
      new Request('https://svitanok.yushko.dev/api/deletions', { method: 'POST' }),
      envWith(),
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ ok: false, error: 'method' });
  });

  it('віддає лише нормалізований зріз без id, URL чи detail помилки', async () => {
    const env = envWith({
      [`${DELETION_RECEIPT_HISTORY_PREFIX}20260916-del-private-id`]: receipt({
        status: 'failed',
        error: 'VPS SDK не підтверджено: https://brain.example/sessions/sdk-secret',
      }),
      [DELETION_RECEIPT_KEY]: receipt({
        status: 'failed',
        error: 'VPS SDK не підтверджено: https://brain.example/sessions/sdk-secret',
      }),
    });
    const body = await (await handleDeletions(env, { ok: true })).json();
    expect(deletionsSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      retentionDays: DELETION_RECEIPT_RETENTION_DAYS,
      receipts: [
        expect.objectContaining({
          requestedAt: '2026-09-16T10:00:00.000Z',
          status: 'failed',
          error: 'VPS SDK не підтвердив видалення; локальні дані збережено.',
          stages: expect.objectContaining({
            local: { status: 'completed', count: 0, rows: 10, kvKeys: 5 },
          }),
        }),
      ],
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('del-private-id');
    expect(text).not.toContain('sdk-secret');
    expect(text).not.toContain('brain.example');
  });

  it('старі або биті квитанції не видає як актуальний доказ', async () => {
    const env = envWith({
      [`${DELETION_RECEIPT_HISTORY_PREFIX}old`]: receipt({
        requestedAt: '2026-01-01T00:00:00.000Z',
      }),
      [`${DELETION_RECEIPT_HISTORY_PREFIX}bad`]: { requestedAt: 'never', status: 'completed' },
    });
    const originalNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(await (await handleDeletions(env, { ok: true })).json()).toEqual({
        receipts: [],
        retentionDays: DELETION_RECEIPT_RETENTION_DAYS,
      });
    } finally {
      Date.now = originalNow;
    }
  });
});
