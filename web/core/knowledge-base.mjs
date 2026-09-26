// Вузька база знань: D1 зберігає документ, його незмінні версії та фрагменти.
// Це не є пам'яттю діалогу і не має права автоматично читати Drive. Зовнішній
// адаптер мусить одержати явний дозвіл на ОДИН source_ref, а сюди передає вже
// витягнутий текст. Vectorize є rebuildable projection поверх цих стабільних
// D1-рядків і ніколи не стає окремим джерелом правди.

import { embedTexts } from './memory.mjs';

export const KNOWLEDGE_KINDS = ['cv', 'job_preparation', 'learning'];
export const KNOWLEDGE_CHUNK_MAX_CHARS = 1_200;
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 5;
export const KNOWLEDGE_PROJECTION_RECONCILE_LIMIT = 10;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('база знань: привʼязки DB немає');
  return env.DB;
}

/** @param {unknown} value @param {string} name @param {number} max */
function text(value, name, max) {
  const out = String(value ?? '').trim();
  if (!out || out.length > max) throw new Error(`база знань: некоректне поле ${name}`);
  return out;
}

/** Дозволити лише стабільний тип джерела й тип документа з allowlist.
 * @param {{sourceType?: unknown, sourceRef?: unknown, title?: unknown, kind?: unknown}} input */
function validateSource(input) {
  const sourceType = text(input.sourceType, 'sourceType', 16);
  if (!['drive', 'upload'].includes(sourceType)) {
    throw new Error('база знань: sourceType має бути drive або upload');
  }
  const kind = text(input.kind, 'kind', 32);
  if (!KNOWLEDGE_KINDS.includes(kind)) {
    throw new Error(`база знань: kind має бути одним із ${KNOWLEDGE_KINDS.join(', ')}`);
  }
  return {
    sourceType,
    sourceRef: text(input.sourceRef, 'sourceRef', 256),
    title: text(input.title, 'title', 200),
    kind,
  };
}

/** Порізати текст по абзацах, не руйнуючи порядок для точних цитат.
 * @param {unknown} value */
export function chunkKnowledgeText(value) {
  const chunks = [];
  let current = '';
  for (const paragraph of String(value ?? '').split(/\n\s*\n/)) {
    const next = paragraph.trim();
    if (!next) continue;
    if (next.length > KNOWLEDGE_CHUNK_MAX_CHARS) {
      if (current) chunks.push(current);
      current = '';
      for (let i = 0; i < next.length; i += KNOWLEDGE_CHUNK_MAX_CHARS) {
        chunks.push(next.slice(i, i + KNOWLEDGE_CHUNK_MAX_CHARS));
      }
      continue;
    }
    const joined = current ? `${current}\n\n${next}` : next;
    if (joined.length > KNOWLEDGE_CHUNK_MAX_CHARS) {
      chunks.push(current);
      current = next;
    } else {
      current = joined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** @param {string} value */
async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Створити (або явно оновити) allowlisted документ і одну незмінну версію.
 * Повтор того самого source_version є ідемпотентним: нових фрагментів не буде.
 * @param {Env} env
 * @param {{sourceType: unknown, sourceRef: unknown, title: unknown, kind: unknown, sourceVersion: unknown, content: unknown, section?: unknown, page?: unknown}} input
 * @param {number} [nowMs]
 */
export async function ingestKnowledgeDocument(env, input, nowMs = Date.now()) {
  const source = validateSource(input);
  const sourceVersion = text(input.sourceVersion, 'sourceVersion', 160);
  const content = text(input.content, 'content', 200_000);
  const section = input.section == null ? null : text(input.section, 'section', 240);
  const rawPage = input.page == null ? null : Number(input.page);
  if (rawPage != null && (!Number.isInteger(rawPage) || rawPage < 1 || rawPage > 100_000)) {
    throw new Error('база знань: некоректна page');
  }
  const chunks = chunkKnowledgeText(content);
  if (chunks.length === 0) throw new Error('база знань: у документі немає тексту');
  const at = new Date(nowMs).toISOString();
  const { results } = await db(env)
    .prepare('SELECT id FROM knowledge_documents WHERE source_type = ? AND source_ref = ? LIMIT 1')
    .bind(source.sourceType, source.sourceRef)
    .all();
  const documentId = String(results?.[0]?.id ?? crypto.randomUUID());
  const { results: versions } = await db(env)
    .prepare('SELECT id FROM knowledge_document_versions WHERE document_id = ? AND source_version = ? LIMIT 1')
    .bind(documentId, sourceVersion)
    .all();
  if (versions?.[0]?.id) return { documentId, versionId: String(versions[0].id), added: false, chunks: 0 };

  const versionId = crypto.randomUUID();
  const hash = await sha256(content);
  await db(env).batch([
    db(env)
      .prepare(
        `INSERT INTO knowledge_documents
         (id, source_type, source_ref, title, kind, access_scope, status, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, 'owner', 'active', ?, NULL)
         ON CONFLICT(source_type, source_ref) DO UPDATE SET
           title = excluded.title, kind = excluded.kind, status = 'active', revoked_at = NULL`,
      )
      .bind(documentId, source.sourceType, source.sourceRef, source.title, source.kind, at),
    db(env)
      .prepare(
        `INSERT INTO knowledge_document_versions
         (id, document_id, source_version, content_sha256, status, extracted_at, error)
         VALUES (?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .bind(versionId, documentId, sourceVersion, hash, at),
    ...chunks.map((chunk, ordinal) =>
      db(env)
        .prepare(
          `INSERT INTO knowledge_chunks
           (id, document_version_id, ordinal, section, page, text, vector_id, projection_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`,
        )
        .bind(crypto.randomUUID(), versionId, ordinal, section, rawPage, chunk, at),
    ),
  ]);
  let indexed = false;
  if (env.AI && env.VECTORIZE) {
    try {
      await indexKnowledgeVersion(env, versionId);
      indexed = true;
    } catch (error) {
      await markKnowledgeVersionFailed(
        env,
        versionId,
        error instanceof Error ? error.message : 'index failed',
      );
    }
  }
  return { documentId, versionId, added: true, chunks: chunks.length, indexed };
}

/** D1 rows -> Vectorize. The chunk id is a stable, retry-safe vector id.
 * @param {Env} env @param {string} versionId */
export async function indexKnowledgeVersion(env, versionId) {
  if (!env.AI) throw new Error('база знань: привʼязки AI немає');
  if (!env.VECTORIZE) throw new Error('база знань: привʼязки VECTORIZE немає');
  const { results } = await db(env)
    .prepare(
      `SELECT c.id, c.text, c.ordinal, v.document_id
       FROM knowledge_chunks c JOIN knowledge_document_versions v ON v.id = c.document_version_id
       WHERE c.document_version_id = ? AND c.projection_status IN ('pending', 'failed')
       ORDER BY c.ordinal`,
    )
    .bind(versionId)
    .all();
  const chunks = results ?? [];
  if (chunks.length === 0) throw new Error('база знань: версія не має pending-чанків');
  const vectors = await embedTexts(
    env,
    chunks.map((chunk) => String(chunk.text)),
  );
  const vectorRows = chunks.map((chunk, index) => {
    const values = vectors[index];
    if (!values) throw new Error('база знань: бракує ембедингу для чанка');
    return {
      id: String(chunk.id),
      values,
      metadata: {
        source: 'knowledge',
        document_id: String(chunk.document_id),
        document_version_id: versionId,
        ordinal: Number(chunk.ordinal),
      },
    };
  });
  await env.VECTORIZE.upsert(vectorRows);
  const documentId = String(chunks[0]?.document_id ?? '');
  await db(env).batch([
    // The last ready generation stays available until this upsert succeeds.
    db(env)
      .prepare(
        `UPDATE knowledge_document_versions SET status = 'retired'
         WHERE document_id = ? AND status = 'ready' AND id <> ?`,
      )
      .bind(documentId, versionId),
    db(env)
      .prepare(
        `UPDATE knowledge_chunks SET projection_status = 'retired'
         WHERE document_version_id IN (
           SELECT id FROM knowledge_document_versions WHERE document_id = ? AND status = 'retired'
         )`,
      )
      .bind(documentId),
    db(env)
      .prepare(`UPDATE knowledge_document_versions SET status = 'ready', error = NULL WHERE id = ?`)
      .bind(versionId),
    ...chunks.map((chunk) =>
      db(env)
        .prepare(
          `UPDATE knowledge_chunks SET vector_id = ?, projection_status = 'ready'
           WHERE id = ? AND projection_status IN ('pending', 'failed')`,
        )
        .bind(String(chunk.id), String(chunk.id)),
    ),
  ]);
  return { indexed: chunks.length };
}

/** @param {Env} env @param {string} versionId @param {string} error */
async function markKnowledgeVersionFailed(env, versionId, error) {
  await db(env).batch([
    db(env)
      .prepare(`UPDATE knowledge_document_versions SET status = 'failed', error = ? WHERE id = ?`)
      .bind(error.slice(0, 500), versionId),
    db(env)
      .prepare(
        `UPDATE knowledge_chunks SET projection_status = 'failed'
         WHERE document_version_id = ? AND projection_status = 'pending'`,
      )
      .bind(versionId),
  ]);
}

/** Repair a pending/failed projection without rereading its source document.
 * @param {Env} env @param {number} [limit] */
export async function reconcileKnowledgeProjection(env, limit = KNOWLEDGE_PROJECTION_RECONCILE_LIMIT) {
  if (!env.DB || !env.AI || !env.VECTORIZE) return { skipped: 'not-configured' };
  const { results } = await db(env)
    .prepare(
      `SELECT id FROM knowledge_document_versions
       WHERE status IN ('pending', 'failed') ORDER BY extracted_at LIMIT ?`,
    )
    .bind(limit)
    .all();
  let indexed = 0;
  let failed = 0;
  for (const row of results ?? []) {
    try {
      indexed += (await indexKnowledgeVersion(env, String(row.id))).indexed;
    } catch (error) {
      failed += 1;
      await markKnowledgeVersionFailed(
        env,
        String(row.id),
        error instanceof Error ? error.message : 'index failed',
      );
    }
  }
  return { indexed, failed };
}

/** Escape LIKE wildcards; bound values alone do not preserve query meaning.
 * @param {string} value */
function like(value) {
  const slash = String.fromCharCode(92);
  return `%${value.replace(/[\\%_]/g, (char) => slash + char)}%`;
}

/**
 * Пошук тільки активного allowlist-корпусу. Цитата є частиною кожного hit —
 * модель не мусить й не може вигадувати документ, версію чи сторінку.
 * @param {Env} env @param {{q: unknown, limit?: unknown}} input
 */
export async function searchKnowledge(env, input) {
  const q = text(input.q, 'q', 160);
  const limit = input.limit == null ? KNOWLEDGE_SEARCH_DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('база знань: limit має бути від 1 до 10');
  }
  const { results } = await db(env)
    .prepare(
      `SELECT c.id, c.text, c.section, c.page, c.ordinal,
              d.title, d.kind, v.source_version
       FROM knowledge_chunks c
       JOIN knowledge_document_versions v ON v.id = c.document_version_id
       JOIN knowledge_documents d ON d.id = v.document_id
       WHERE d.status = 'active' AND d.access_scope = 'owner' AND v.status = 'ready'
         AND c.projection_status = 'ready'
         AND c.text LIKE ? ESCAPE '\\'
       ORDER BY d.created_at DESC, c.ordinal ASC LIMIT ?`,
    )
    .bind(like(q), limit)
    .all();
  return (results ?? []).map((row) => ({
    excerpt: String(row.text),
    citation: {
      document: String(row.title),
      kind: String(row.kind),
      version: String(row.source_version),
      ...(row.section ? { section: String(row.section) } : {}),
      ...(row.page == null ? {} : { page: Number(row.page) }),
      chunk: Number(row.ordinal) + 1,
    },
  }));
}

/** Internal tool adapter: permitted documents are still external content.
 * @param {Env} env @param {{q: unknown, limit?: unknown}} input */
export async function runKnowledgeSearch(env, input) {
  return { result: await searchKnowledge(env, input) };
}

/** Open revoke: retrieval stops immediately; physical purge is a later job. */
/** @param {Env} env @param {unknown} documentId @param {number} [nowMs] */
export async function revokeKnowledgeDocument(env, documentId, nowMs = Date.now()) {
  const id = text(documentId, 'documentId', 80);
  const at = new Date(nowMs).toISOString();
  await db(env).batch([
    db(env)
      .prepare(`UPDATE knowledge_documents SET status = 'revoked', revoked_at = ? WHERE id = ?`)
      .bind(at, id),
    db(env)
      .prepare(
        `UPDATE knowledge_document_versions SET status = 'revoked'
         WHERE document_id = ? AND status <> 'revoked'`,
      )
      .bind(id),
  ]);
}

/**
 * Фізичне видалення після revoke. Зовнішня проєкція завжди йде першою: D1
 * лишається truth про те, які vector_id треба прибрати, а невдалий delete не
 * стирає цей список. `forget` зможе викликати цю ж функцію без особливого
 * шляху для документів.
 * @param {Env} env @param {unknown} documentId
 */
export async function deleteKnowledgeDocument(env, documentId) {
  const id = text(documentId, 'documentId', 80);
  const { results } = await db(env)
    .prepare(
      `SELECT c.vector_id FROM knowledge_chunks c
       JOIN knowledge_document_versions v ON v.id = c.document_version_id
       WHERE v.document_id = ? AND c.vector_id IS NOT NULL`,
    )
    .bind(id)
    .all();
  const vectorIds = (results ?? []).map((row) => String(row.vector_id)).filter(Boolean);
  if (vectorIds.length > 0) {
    if (!env.VECTORIZE) throw new Error('база знань: VECTORIZE потрібен для видалення проєкції');
    await env.VECTORIZE.deleteByIds(vectorIds);
  }
  await db(env).batch([
    db(env)
      .prepare(
        `DELETE FROM knowledge_chunks
         WHERE document_version_id IN (
           SELECT id FROM knowledge_document_versions WHERE document_id = ?
         )`,
      )
      .bind(id),
    db(env).prepare('DELETE FROM knowledge_document_versions WHERE document_id = ?').bind(id),
    db(env).prepare('DELETE FROM knowledge_documents WHERE id = ?').bind(id),
  ]);
  return { vectorIds: vectorIds.length };
}
