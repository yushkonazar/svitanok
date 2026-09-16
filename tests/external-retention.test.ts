// Реальні межі retention: D1 не оголошує вектор/VPS/Drive стерті раніше, ніж
// це підтвердив зовнішній сервіс. Тут усі три межі проходять одним тестом.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetAll,
  DELETION_RECEIPT_KEY,
  resumePendingForgetAll,
} from '../web/core/export/forget-all.mjs';
import { retentionCleanupTask } from '../web/core/retention/cleanup.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0005_finance.sql',
  '0006_inbox_collections.sql',
  '0007_instructions_plans.sql',
  '0008_fts.sql',
  '0009_voice.sql',
  '0010_reminders_address.sql',
  '0011_ideas_number.sql',
  '0012_reminders_recurrence.sql',
  '0013_run_steps_idempotency.sql',
];
const NOW = Date.parse('2026-09-16T01:10:00.000Z'); // 04:10 Київ
const OLD = '2026-01-01T00:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(over: Record<string, unknown> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const store = new Map<string, string>([
    [
      'googleToken',
      JSON.stringify({
        token: 'drive-access-token',
        expMs: Date.now() + 3_600_000,
        scope: 'https://www.googleapis.com/auth/drive.file',
      }),
    ],
  ]);
  const deletedVectors: string[][] = [];
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(store),
    ASSISTANT_V2: 'on',
    BRAIN_URL: 'https://brain.example',
    INTERNAL_HMAC_KEY: 'test-hmac-key',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    VECTORIZE: { deleteByIds: vi.fn(async (ids: string[]) => void deletedVectors.push(ids)) },
    ...over,
  });
  return { env, db: d1.db, store, deletedVectors };
}

function seedExternalRows(db: ReturnType<typeof setup>['db'], withBackup = false) {
  db.prepare(
    `INSERT INTO sessions (thread_id, sdk_session_id, started_at, last_at, tainted, summary_md, turn_count)
     VALUES ('dm', 'sdk-1', ?, ?, 0, 'коротка згортка', 2)`,
  ).run(OLD, OLD);
  db.prepare(
    `INSERT INTO memory_chunks (id, thread_id, at, text, vector_id)
     VALUES ('mem-1', 'dm', ?, 'зміст', 'vec-1')`,
  ).run(OLD);
  db.prepare(
    `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
     VALUES ('f-owner', 'setting', 'owner_data', '"так"', 'owner', 1, ?, ?)`,
  ).run(OLD, OLD);
  if (withBackup) {
    db.prepare(
      `INSERT INTO facts (id, kind, key, value_json, source, confidence, created_at, updated_at)
       VALUES ('f-backup', 'setting', 'last_backup', '{}', 'inferred', NULL, ?, ?)`,
    ).run(OLD, OLD);
  }
}

function successTransport() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: text, method });
      if (text === 'https://brain.example/sessions/delete') {
        return new Response(JSON.stringify({ ok: true, deleted: 1, alreadyMissing: 0 }), {
          status: 200,
        });
      }
      if (method === 'DELETE' && text.includes('drive/v3/files/backup-1')) {
        return new Response(null, { status: 204 });
      }
      if (text.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        const q = new URL(text).searchParams.get('q') ?? '';
        if (q.includes("name = 'Світанок'")) {
          return new Response(JSON.stringify({ files: [{ id: 'folder-root', name: 'Світанок' }] }));
        }
        if (q.includes("name = 'backups'")) {
          return new Response(
            JSON.stringify({ files: [{ id: 'folder-backups', name: 'backups' }] }),
          );
        }
        if (q.includes("'folder-backups' in parents")) {
          return new Response(
            JSON.stringify({
              files: [
                { id: 'backup-1', name: 'svitanok-2026-01-01.enc', createdTime: OLD },
                { id: 'other', name: 'note.md', createdTime: OLD },
              ],
            }),
          );
        }
      }
      throw new Error(`unexpected fetch ${method} ${text}`);
    }),
  );
  return calls;
}

describe('зовнішня retention і T2 deletion', () => {
  it('«забудь усе» підтверджує VPS, Vectorize й точні Drive backups перед D1; квитанція не містить id', async () => {
    const { env, db, store, deletedVectors } = setup();
    seedExternalRows(db, true);
    const calls = successTransport();

    const out = await forgetAll(env);
    if ('pending' in out) throw new Error('cleanup не мав чекати активний run');

    expect(out.external).toEqual({ queues: 0, sdkSessions: 1, vectors: 1, backups: 1 });
    expect(deletedVectors).toEqual([['vec-1']]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 0 });
    expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('backup-1'))).toBe(
      true,
    );
    const receipt = store.get(DELETION_RECEIPT_KEY) ?? '';
    expect(JSON.parse(receipt)).toMatchObject({ status: 'completed', scope: 'all' });
    expect(receipt).not.toContain('sdk-1');
    expect(receipt).not.toContain('vec-1');
  });

  it('помилка VPS залишає локальні дані й квитанцію failed — «все стерто» не повертається', async () => {
    const { env, db, store } = setup();
    seedExternalRows(db);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: 'unavailable' }), { status: 503 }),
      ),
    );

    await expect(forgetAll(env)).rejects.toThrow(/VPS SDK-сесії/);
    expect(db.prepare('SELECT sdk_session_id FROM sessions').get()).toEqual({
      sdk_session_id: 'sdk-1',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get()).toEqual({ n: 1 });
    expect(JSON.parse(store.get(DELETION_RECEIPT_KEY) ?? '{}')).toMatchObject({ status: 'failed' });
  });

  it('активний run спершу abort-иться й очищає чергу, а scheduler завершує T2 без другого слова', async () => {
    let active = true;
    const registry = {
      getByName: () => ({
        clearAllThreads: async () =>
          active ? { activeRunIds: ['run-live'], cleared: 2 } : { activeRunIds: [], cleared: 0 },
      }),
    };
    const { env, db, store } = setup({ RUN_REGISTRY: registry });
    seedExternalRows(db);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const text = String(url);
        if (text === 'https://brain.example/abort') {
          return new Response(JSON.stringify({ ok: true, aborted: true }));
        }
        if (text === 'https://brain.example/sessions/delete') {
          return new Response(JSON.stringify({ ok: true, deleted: 1, alreadyMissing: 0 }));
        }
        throw new Error(`unexpected fetch ${text}`);
      }),
    );

    const pending = await forgetAll(env);
    expect(pending).toMatchObject({ pending: true });
    expect(db.prepare('SELECT sdk_session_id FROM sessions').get()).toEqual({
      sdk_session_id: 'sdk-1',
    });
    expect(JSON.parse(store.get(DELETION_RECEIPT_KEY) ?? '{}')).toMatchObject({
      status: 'waiting_for_active_runs',
    });

    active = false;
    const done = await resumePendingForgetAll(env);
    if ('pending' in done) throw new Error('active run уже завершився');
    if ('skipped' in done) throw new Error('очікувалась відкладена квитанція');
    expect(done.external.queues).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get()).toEqual({ n: 0 });
  });

  it('нічна ретенція очищає старі SDK-транскрипт і вектор перед D1, а summary лишається', async () => {
    const { env, db, deletedVectors } = setup();
    seedExternalRows(db);
    successTransport();

    const out = await retentionCleanupTask(env, NOW);

    expect(out).toMatchObject({ removed: { memory_chunks: 1, sessions: 1 }, failed: [] });
    expect(deletedVectors).toEqual([['vec-1']]);
    expect(db.prepare('SELECT sdk_session_id, summary_md FROM sessions').get()).toEqual({
      sdk_session_id: null,
      summary_md: 'коротка згортка',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get()).toEqual({ n: 0 });
  });
});
