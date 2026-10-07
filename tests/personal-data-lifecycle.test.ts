import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_TABLES,
  buildBackupDocument,
  encryptBackup,
  decryptBackup,
  restoreSql,
} from '../web/core/backup/core.mjs';
import { dumpTables } from '../web/core/backup/task.mjs';
import { buildExportFiles } from '../web/core/export/data-export.mjs';
import { forgetAll, DELETION_RECEIPT_KEY } from '../web/core/export/forget-all.mjs';
import { reconcileKnowledgeProjection, searchKnowledge } from '../web/core/knowledge-base.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { ALL_MIGRATIONS } from './helpers/migrations.js';
import { lifecycleRows, seedLifecycleRows } from './helpers/lifecycle-fixtures.js';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const SECRET = 'synthetic sufficiently long backup key';
const NOW = Date.parse('2026-10-05T10:00:00Z');

afterEach(() => vi.unstubAllGlobals());

function setup() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected external request in local lifecycle test');
    }),
  );
  const { db, stub } = d1FromSqlite(ALL_MIGRATIONS);
  const store = new Map<string, string>();
  const deleted: string[][] = [];
  const deleteByIds = vi.fn(async (ids: string[]) => {
    deleted.push(ids);
  });
  const env = workerEnv({
    DB: stub,
    BRIEFING: memoryKv(store, { listKeys: () => [...store.keys()] }),
    VECTORIZE: { deleteByIds },
  });
  return { db, env, store, deleted, deleteByIds };
}

describe('personal data lifecycle: complete schema', () => {
  it('reads every new table and exports its rows, with secrets redacted', async () => {
    const { db, env } = setup();
    const seeded = seedLifecycleRows(db);
    const tables = await dumpTables(env);
    const files = buildExportFiles({ tables, kv: {}, secrets: ['Навчальний текст'], nowMs: NOW });
    for (const [table, rows] of Object.entries(seeded)) {
      expect(tables[table], table).toEqual(rows);
      const text = new TextDecoder().decode(
        files.find((file) => file.name === `d1/${table}.json`)!.bytes,
      );
      expect(JSON.parse(text)).toHaveLength(rows.length);
      expect(text).not.toContain('Навчальний текст');
    }
    db.close();
  });

  it('encrypted round-trip restores rows and repairs the external knowledge index', async () => {
    const source = setup();
    seedLifecycleRows(source.db);
    const doc = buildBackupDocument({
      createdMs: NOW,
      envName: 'local-test',
      tables: await dumpTables(source.env),
      kv: {},
    });
    const restored = await decryptBackup(SECRET, await encryptBackup(SECRET, doc));
    const target = setup();
    target.db.exec(restoreSql(restored));
    expect(target.db.prepare('SELECT status FROM knowledge_document_versions').get()).toEqual({
      status: 'pending',
    });
    expect(target.db.prepare('SELECT text, projection_status FROM knowledge_chunks').get()).toEqual(
      { text: 'Навчальний текст: лимон', projection_status: 'pending' },
    );
    for (const table of ['knowledge_documents', 'learning_sessions', 'worker_card_actions']) {
      expect(target.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(
        source.db.prepare(`SELECT * FROM ${table}`).all(),
      );
    }
    const upsert = vi.fn(async () => {});
    const env = workerEnv({
      ...target.env,
      AI: {
        run: async (_model: string, input: { text: string[] }) => ({
          data: input.text.map(() => [1, 0, 0]),
        }),
      },
      VECTORIZE: { upsert, deleteByIds: target.deleteByIds },
    });
    expect(await searchKnowledge(env, { q: 'лимон' })).toEqual([]);
    expect(await reconcileKnowledgeProjection(env)).toEqual({ indexed: 1, failed: 0 });
    expect(upsert).toHaveBeenCalledOnce();
    expect(await searchKnowledge(env, { q: 'лимон' })).toHaveLength(1);
    expect(doc.d1.knowledge_document_versions?.[0]?.status).toBe('ready');
    source.db.close();
    target.db.close();
  });

  it('old backups preserve newer data, while an explicit empty snapshot clears it', () => {
    const { db } = setup();
    seedLifecycleRows(db);
    const doc = buildBackupDocument({ createdMs: NOW, envName: 'legacy', tables: {}, kv: {} });
    for (const table of Object.keys(lifecycleRows())) delete doc.d1[table];
    db.exec(restoreSql(doc));
    for (const table of Object.keys(lifecycleRows()))
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    db.exec(
      restoreSql(buildBackupDocument({ createdMs: NOW, envName: 'new', tables: {}, kv: {} })),
    );
    for (const table of Object.keys(lifecycleRows()))
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('rejects malformed or partial knowledge archives before producing restore SQL', () => {
    const doc = buildBackupDocument({ createdMs: NOW, envName: 'test', tables: {}, kv: {} });
    delete doc.d1.knowledge_chunks;
    expect(() => restoreSql(doc)).toThrow(/неповний/);
    doc.d1.knowledge_chunks = null as never;
    expect(() => restoreSql(doc)).toThrow(/масив рядків/);
  });

  it('restoring a revoked document never reactivates it or labels its index for active rebuild', () => {
    const tables = lifecycleRows();
    tables.knowledge_documents![0]!.status = 'revoked';
    const doc = buildBackupDocument({ createdMs: NOW, envName: 'test', tables, kv: {} });
    const { db } = setup();
    db.exec(restoreSql(doc));
    expect(db.prepare('SELECT status FROM knowledge_documents').get()).toEqual({
      status: 'revoked',
    });
    expect(db.prepare('SELECT status FROM knowledge_document_versions').get()).toEqual({
      status: 'ready',
    });
    db.close();
  });

  it('full forget removes knowledge vectors before deleting all new personal rows', async () => {
    const { db, env, store, deleted, deleteByIds } = setup();
    seedLifecycleRows(db);
    deleteByIds.mockImplementation(async (ids) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get()).toEqual({ n: 1 });
      deleted.push(ids);
    });
    const result = await forgetAll(env);
    expect(result).toMatchObject({ external: { vectors: 1 } });
    expect(deleted).toEqual([['kc']]);
    for (const table of Object.keys(lifecycleRows()))
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(JSON.parse(store.get(DELETION_RECEIPT_KEY)!)).toMatchObject({ status: 'completed' });
    db.close();
  });

  it('a failed knowledge-vector delete preserves D1 and a retry can finish safely', async () => {
    const { db, env, store, deleteByIds } = setup();
    seedLifecycleRows(db);
    deleteByIds.mockRejectedValueOnce(new Error('Vectorize unavailable'));
    await expect(forgetAll(env)).rejects.toThrow(/Vectorize/);
    for (const table of Object.keys(lifecycleRows()))
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    expect(JSON.parse(store.get(DELETION_RECEIPT_KEY)!)).toMatchObject({ status: 'failed' });
    await expect(forgetAll(env)).resolves.toMatchObject({ external: { vectors: 1 } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents').get()).toEqual({ n: 0 });
    db.close();
  });

  it('missing Vectorize is not falsely reported as completed deletion', async () => {
    const { db, env } = setup();
    seedLifecycleRows(db);
    env.VECTORIZE = undefined;
    await expect(forgetAll(env)).rejects.toThrow(/VECTORIZE/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM learning_sessions').get()).toEqual({ n: 1 });
    expect(BACKUP_TABLES).toContain('knowledge_chunks');
    db.close();
  });

  it('also deletes stable knowledge IDs when a crash left vector_id unset, across pages', async () => {
    const { db, env, deleted } = setup();
    seedLifecycleRows(db);
    db.exec('BEGIN');
    const insert = db.prepare(
      `INSERT INTO knowledge_chunks (id, document_version_id, ordinal, text, vector_id, projection_status, created_at) VALUES (?, 'kv', ?, 'synthetic pending text', NULL, 'pending', '2026-10-05T10:00:00Z')`,
    );
    for (let n = 1; n <= 2005; n++) insert.run(`pending-${n}`, n);
    db.exec('COMMIT');
    await expect(forgetAll(env)).resolves.toMatchObject({ external: { vectors: 2006 } });
    const ids = deleted.flat();
    expect(new Set(ids).size).toBe(2006);
    expect(ids).toContain('pending-2005');
    expect(deleted.every((batch) => batch.length <= 100)).toBe(true);
    db.close();
  });

  it('a late D1 deletion failure rolls back all local tables as one batch', async () => {
    const { db, env, store } = setup();
    seedLifecycleRows(db);
    // Model the real D1 batch transaction; the common narrow fixture shim
    // intentionally runs statements sequentially without transaction handling.
    const batch = env.DB!.batch.bind(env.DB);
    vi.spyOn(env.DB!, 'batch').mockImplementation(async (statements) => {
      db.exec('BEGIN');
      try {
        const result = await batch(statements);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    db.exec(
      `CREATE TRIGGER stop_delete BEFORE DELETE ON knowledge_documents BEGIN SELECT RAISE(ABORT, 'D1 injected failure'); END`,
    );
    await expect(forgetAll(env)).rejects.toThrow(/D1 injected/);
    for (const table of Object.keys(lifecycleRows()))
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    expect(JSON.parse(store.get(DELETION_RECEIPT_KEY)!)).toMatchObject({
      status: 'failed',
      stages: { local: { status: 'running' } },
    });
    db.exec('DROP TRIGGER stop_delete');
    await expect(forgetAll(env)).resolves.toMatchObject({ external: { vectors: 1 } });
    db.close();
  });
});
