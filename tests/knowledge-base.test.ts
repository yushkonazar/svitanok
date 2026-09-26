import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_CHUNK_MAX_CHARS,
  chunkKnowledgeText,
  ingestKnowledgeDocument,
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

describe('narrow knowledge base', () => {
  it('chunks on paragraphs without losing text or exceeding the limit', () => {
    const chunks = chunkKnowledgeText(`Перший абзац\n\n${'а'.repeat(KNOWLEDGE_CHUNK_MAX_CHARS + 5)}`);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe('Перший абзац');
    expect(chunks.every((chunk) => chunk.length <= KNOWLEDGE_CHUNK_MAX_CHARS)).toBe(true);
  });

  it('accepts only an explicit allowlisted source and returns versioned citations', async () => {
    const store = d1();
    const env = workerEnv({ DB: store.stub });
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
    const env = workerEnv({ DB: store.stub });
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
    const env = workerEnv({ DB: store.stub });
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
});
