import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_CHUNK_MAX_CHARS,
  chunkKnowledgeText,
  deleteKnowledgeDocument,
  ingestKnowledgeDocument,
  reconcileKnowledgeProjection,
  revokeKnowledgeDocument,
  runKnowledgeSearch,
  searchKnowledge,
} from '../web/core/knowledge-base.mjs';
import { workerEnv } from './helpers/env.js';
import { TOOLS } from '../web/core/tools/index.mjs';

const NOW = Date.parse('2026-09-26T09:00:00.000Z');

function d1() {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', '0019_knowledge_base.sql'), 'utf8'),
  );
  return {
    database,
    stub: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          sql,
          args,
          run: async () => {
            // @ts-expect-error node:sqlite accepts variadic bindings.
            database.prepare(sql).run(...args);
          },
          all: async () => ({
            // @ts-expect-error node:sqlite accepts variadic bindings.
            results: database.prepare(sql).all(...args),
          }),
        }),
      }),
      batch: async (statements: { sql: string; args: unknown[] }[]) => {
        database.exec('BEGIN');
        try {
          for (const statement of statements) {
            // @ts-expect-error node:sqlite accepts variadic bindings.
            database.prepare(statement.sql).run(...statement.args);
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        return statements.map(() => ({ success: true }));
      },
    },
  };
}

function indexedEnv(store: ReturnType<typeof d1>, vectorize?: { upsert: (rows: unknown[]) => Promise<void> }) {
  return workerEnv({
    DB: store.stub,
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((value) => [value.length, 1, 0]),
      }),
    },
    VECTORIZE:
      vectorize ??
      {
        upsert: async () => {},
        deleteByIds: async () => {},
      },
  });
}

describe('narrow knowledge base', () => {
  it('chunks on paragraphs without losing text or exceeding the limit', () => {
    const chunks = chunkKnowledgeText(`Перший абзац\n\n${'а'.repeat(KNOWLEDGE_CHUNK_MAX_CHARS + 5)}`);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe('Перший абзац');
    expect(chunks.every((chunk) => chunk.length <= KNOWLEDGE_CHUNK_MAX_CHARS)).toBe(true);
  });

  it('accepts only an explicit allowlisted source and returns versioned citations', async () => {
    const store = d1();
    const env = indexedEnv(store);
    const added = await ingestKnowledgeDocument(
      env,
      {
        sourceType: 'drive',
        sourceRef: 'file-cv-2026',
        title: 'CV Назара',
        kind: 'cv',
        sourceVersion: 'drive-v3',
        content: 'TypeScript, Cloudflare Workers і OpenAI Responses.\n\nДосвід керування продуктом.',
        section: 'Навички',
        page: 2,
      },
      NOW,
    );
    expect(added).toMatchObject({ added: true, chunks: 1 });
    expect(await searchKnowledge(env, { q: 'Cloudflare' })).toEqual([
      {
        excerpt: 'TypeScript, Cloudflare Workers і OpenAI Responses.\n\nДосвід керування продуктом.',
        citation: {
          document: 'CV Назара',
          kind: 'cv',
          version: 'drive-v3',
          section: 'Навички',
          page: 2,
          chunk: 1,
        },
      },
    ]);
    await expect(
      ingestKnowledgeDocument(env, {
        sourceType: 'drive',
        sourceRef: 'all-drive',
        title: 'Все',
        kind: 'private_messages',
        sourceVersion: '1',
        content: 'не має пройти',
      }),
    ).rejects.toThrow(/kind/);
  });

  it('is idempotent per source version and revoke immediately removes it from retrieval', async () => {
    const store = d1();
    const env = indexedEnv(store);
    const input = {
      sourceType: 'upload',
      sourceRef: 'manual-learning-1',
      title: 'Конспект',
      kind: 'learning',
      sourceVersion: '1',
      content: 'Векторний пошук повертає лише цитовані докази.',
    };
    const first = await ingestKnowledgeDocument(env, input, NOW);
    const duplicate = await ingestKnowledgeDocument(env, input, NOW + 1_000);
    expect(duplicate).toMatchObject({ documentId: first.documentId, added: false, chunks: 0 });
    expect(store.database.prepare('SELECT count(*) AS n FROM knowledge_chunks').get()).toEqual({ n: 1 });

    await revokeKnowledgeDocument(env, first.documentId, NOW + 2_000);
    await expect(searchKnowledge(env, { q: 'докази' })).resolves.toEqual([]);
    expect(store.database.prepare("SELECT status FROM knowledge_documents").get()).toEqual({ status: 'revoked' });
  });

  it('is a tainting read-only core tool with citations, not a Drive crawler', async () => {
    const store = d1();
    const env = indexedEnv(store);
    await ingestKnowledgeDocument(env, {
      sourceType: 'upload',
      sourceRef: 'learning-2',
      title: 'Нотатки з архітектури',
      kind: 'learning',
      sourceVersion: '2',
      content: 'Durable Objects серіалізують критичний mutable state.',
    });
    expect(TOOLS['knowledge.search']?.tainting).toBe(true);
    await expect(runKnowledgeSearch(env, { q: 'Durable' })).resolves.toMatchObject({
      result: [
        {
          citation: { document: 'Нотатки з архітектури', version: '2', chunk: 1 },
        },
      ],
    });
  });

  it('deletes vector projection before local chunks and preserves truth on a vector failure', async () => {
    const store = d1();
    const vectorDeletes: string[][] = [];
    const env = workerEnv({
      DB: store.stub,
      VECTORIZE: { deleteByIds: async (ids: string[]) => void vectorDeletes.push(ids) },
    });
    const added = await ingestKnowledgeDocument(env, {
      sourceType: 'upload',
      sourceRef: 'learning-delete',
      title: 'Конспект для видалення',
      kind: 'learning',
      sourceVersion: '1',
      content: 'Цей документ треба видалити повністю.',
    });
    store.database.prepare("UPDATE knowledge_chunks SET vector_id = 'kb-vector-1'").run();
    await expect(deleteKnowledgeDocument(env, added.documentId)).resolves.toEqual({ vectorIds: 1 });
    expect(vectorDeletes).toEqual([['kb-vector-1']]);
    expect(store.database.prepare('SELECT count(*) AS n FROM knowledge_documents').get()).toEqual({ n: 0 });

    const second = await ingestKnowledgeDocument(env, {
      sourceType: 'upload',
      sourceRef: 'learning-delete-2',
      title: 'Другий конспект',
      kind: 'learning',
      sourceVersion: '1',
      content: 'Текст лишається, коли індекс не можна прибрати.',
    });
    store.database.prepare("UPDATE knowledge_chunks SET vector_id = 'kb-vector-2'").run();
    await expect(deleteKnowledgeDocument(workerEnv({ DB: store.stub }), second.documentId)).rejects.toThrow(
      /VECTORIZE/,
    );
    expect(store.database.prepare('SELECT count(*) AS n FROM knowledge_documents').get()).toEqual({ n: 1 });
  });

  it('leaves an interrupted projection hidden, then rebuilds exactly its D1 chunks', async () => {
    const store = d1();
    const failedEnv = indexedEnv(store, {
      upsert: async () => {
        throw new Error('Vectorize down');
      },
    });
    const added = await ingestKnowledgeDocument(failedEnv, {
      sourceType: 'upload',
      sourceRef: 'retryable',
      title: 'Retryable note',
      kind: 'learning',
      sourceVersion: '1',
      content: 'Текст існує в D1 до того, як готовий індекс.',
    });
    expect(added).toMatchObject({ indexed: false });
    expect(await searchKnowledge(failedEnv, { q: 'Текст' })).toEqual([]);
    expect(store.database.prepare('SELECT status FROM knowledge_document_versions').get()).toEqual({
      status: 'failed',
    });

    const upserts: unknown[][] = [];
    const repairedEnv = indexedEnv(store, {
      upsert: async (rows) => void upserts.push(rows),
    });
    await expect(reconcileKnowledgeProjection(repairedEnv)).resolves.toEqual({ indexed: 1, failed: 0 });
    expect(upserts[0]).toHaveLength(1);
    await expect(searchKnowledge(repairedEnv, { q: 'Текст' })).resolves.toHaveLength(1);
  });
});
