// Памʼять асистента (01 §2.1, ADR-038): згортки тредів ріжуться на чанки в D1
// memory_chunks, вектори bge-m3 (Workers AI) їдуть у Vectorize svitanok-memory.
// Пошук - інструмент memory.search (07 §4, S-N1-3): «що я казав про X» →
// цитати згорток з датами. Якість bge-m3 для української - UNKNOWN (ADR-020):
// перевіряється чеклистом приймання; без привʼязок усе відмовляє ЯВНО, а
// згортки живуть далі в sessions.summary_md (резерв).

import { neutralizeExternalTags } from './tools/markup.mjs';

const EMBED_MODEL = '@cf/baai/bge-m3';
/** Стеля чанка: згортка ≤ 20 000 символів (SESSION_SCHEMA) → ≤ 20 чанків. */
export const MEMORY_CHUNK_MAX_CHARS = 1000;
export const MEMORY_SEARCH_DEFAULT_LIMIT = 5;
export const MEMORY_PROJECTION_RECONCILE_LIMIT = 10;

/**
 * Ембединги для пакета текстів. Збій чи несподівана форма відповіді - явний
 * виняток: тихий null означав би «памʼять мовчки не пишеться».
 * @param {Env} env
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(env, texts) {
  if (!env.AI) throw new Error('памʼять: привʼязки AI немає');
  const out = /** @type {{ data?: number[][] } | undefined} */ (
    await env.AI.run(/** @type {never} */ (EMBED_MODEL), { text: texts })
  );
  const vectors = out?.data;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error('памʼять: несподівана відповідь ембединг-моделі');
  }
  return vectors;
}

/**
 * Порізати згортку на чанки ≤ MEMORY_CHUNK_MAX_CHARS: жадібно по абзацах
 * (порожній рядок), задовгий абзац - жорсткий зріз. Порожні шматки геть.
 * @param {string} summaryMd
 * @returns {string[]}
 */
export function chunkSummary(summaryMd) {
  /** @type {string[]} */
  const chunks = [];
  let current = '';
  for (const para of summaryMd.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > MEMORY_CHUNK_MAX_CHARS) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < p.length; i += MEMORY_CHUNK_MAX_CHARS) {
        chunks.push(p.slice(i, i + MEMORY_CHUNK_MAX_CHARS));
      }
      continue;
    }
    const joined = current ? `${current}\n\n${p}` : p;
    if (joined.length > MEMORY_CHUNK_MAX_CHARS) {
      chunks.push(current);
      current = p;
    } else {
      current = joined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Записати згортку як НОВУ версію D1 → Vectorize projection. Нові D1-рядки
 * спершу стають `pending`; лише успішно індексована повна версія стає `ready`.
 * Попередня ready-версія живе до switch, тому частковий збій не робить пошук
 * порожнім. Vectorize можна зібрати повторно з D1 через reconciliation.
 * @param {Env} env
 * @param {string} threadId
 * @param {string} summaryMd
 * @param {number} nowMs
 * @returns {Promise<{ written: number }>}
 */
export async function writeMemoryChunks(env, threadId, summaryMd, nowMs) {
  const db = env.DB;
  if (!db) throw new Error('памʼять: привʼязки DB немає');
  if (!env.VECTORIZE) throw new Error('памʼять: привʼязки VECTORIZE немає');
  const chunks = chunkSummary(summaryMd);
  if (chunks.length === 0) return { written: 0 };

  const at = new Date(nowMs).toISOString();
  const version = crypto.randomUUID();
  const rows = chunks.map((text) => ({
    id: crypto.randomUUID(),
    text,
  }));

  // D1 є truth навіть до індексування: якщо AI/Vectorize впаде, repair
  // повторить саме ці тексти та ті самі vector ids, без втрати нової згортки.
  await db.batch([
    db
      .prepare(
        `INSERT INTO memory_projection_versions
         (thread_id, version, status, chunk_count, embedding_model, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(threadId, version, rows.length, EMBED_MODEL, at),
    ...rows.map((row) =>
      db
        .prepare(
          `INSERT INTO memory_chunks
           (id, thread_id, at, text, vector_id, projection_version, projection_status)
           VALUES (?1, ?2, ?3, ?4, ?1, ?5, 'pending')`,
        )
        .bind(row.id, threadId, at, row.text, version),
    ),
  ]);
  try {
    const vectors = await embedTexts(
      env,
      rows.map((row) => row.text),
    );
    await env.VECTORIZE.upsert(
      rows.map((row, i) => ({
        id: row.id,
        values: /** @type {number[]} */ (vectors[i]),
        metadata: { thread_id: threadId, at, projection_version: version },
      })),
    );
    await markProjectionIndexed(env, threadId, version, at);
    await activateProjection(env, threadId, version, at, at);
  } catch (/** @type {any} */ e) {
    await markProjectionFailed(env, threadId, version, String(e?.message ?? 'index failed'));
    throw e;
  }
  // Нова версія вже ready. Збій cleanup старих векторів не має удавати, що
  // її не записано: retired-рядки сховає пошук, а reconcile повторить delete.
  await cleanupRetiredMemoryChunks(env).catch((/** @type {any} */ e) =>
    console.error('памʼять: retired projection не прибрано', e?.message),
  );
  return { written: rows.length };
}

/** Mark a staged generation indexed only after Vectorize confirms its upsert.
 * @param {Env} env @param {string} threadId @param {string} version @param {string} at */
async function markProjectionIndexed(env, threadId, version, at) {
  const db = /** @type {NonNullable<Env['DB']>} */ (env.DB);
  await db.batch([
    db
      .prepare(
        `UPDATE memory_projection_versions
         SET status = 'indexed', indexed_at = ?, error = NULL
         WHERE thread_id = ? AND version = ? AND status IN ('pending', 'failed')`,
      )
      .bind(at, threadId, version),
    db
      .prepare(
        `UPDATE memory_chunks SET projection_status = 'indexed', indexed_at = ?
         WHERE thread_id = ? AND projection_version = ?
           AND projection_status IN ('pending', 'failed')`,
      )
      .bind(at, threadId, version),
  ]);
}

/**
 * Atomically make an indexed generation searchable and retire an older one.
 * An older async write may finish after a newer ready generation; it is retired
 * instead of rolling memory back to stale text.
 * @param {Env} env @param {string} threadId @param {string} version
 * @param {string} createdAt @param {string} readyAt
 */
async function activateProjection(env, threadId, version, createdAt, readyAt) {
  const db = /** @type {NonNullable<Env['DB']>} */ (env.DB);
  const { results } = await db
    .prepare(
      `SELECT version, created_at FROM memory_projection_versions
       WHERE thread_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(threadId)
    .all();
  const current = /** @type {{ version: string, created_at: string } | undefined} */ (results?.[0]);
  if (current && Date.parse(current.created_at) > Date.parse(createdAt)) {
    await db.batch([
      db
        .prepare(
          `UPDATE memory_projection_versions SET status = 'retired', error = 'superseded-before-ready'
           WHERE thread_id = ? AND version = ?`,
        )
        .bind(threadId, version),
      db
        .prepare(
          `UPDATE memory_chunks SET projection_status = 'retired'
           WHERE thread_id = ? AND projection_version = ?`,
        )
        .bind(threadId, version),
    ]);
    return false;
  }
  await db.batch([
    db
      .prepare(
        `UPDATE memory_projection_versions SET status = 'retired'
         WHERE thread_id = ? AND status = 'ready' AND version <> ?`,
      )
      .bind(threadId, version),
    db
      .prepare(
        `UPDATE memory_chunks SET projection_status = 'retired'
         WHERE thread_id = ? AND projection_status = 'ready' AND projection_version <> ?`,
      )
      .bind(threadId, version),
    db
      .prepare(
        `UPDATE memory_projection_versions SET status = 'ready', ready_at = ?, error = NULL
         WHERE thread_id = ? AND version = ? AND status = 'indexed'`,
      )
      .bind(readyAt, threadId, version),
    db
      .prepare(
        `UPDATE memory_chunks SET projection_status = 'ready', indexed_at = COALESCE(indexed_at, ?)
         WHERE thread_id = ? AND projection_version = ? AND projection_status = 'indexed'`,
      )
      .bind(readyAt, threadId, version),
  ]);
  return true;
}

/** Persist a failed state rather than leaving a D1 row that looks searchable.
 * @param {Env} env @param {string} threadId @param {string} version @param {string} error */
async function markProjectionFailed(env, threadId, version, error) {
  const db = /** @type {NonNullable<Env['DB']>} */ (env.DB);
  await db.batch([
    db
      .prepare(
        `UPDATE memory_projection_versions SET status = 'failed', error = ?
         WHERE thread_id = ? AND version = ? AND status <> 'ready'`,
      )
      .bind(error.slice(0, 500), threadId, version),
    db
      .prepare(
        `UPDATE memory_chunks SET projection_status = 'failed'
         WHERE thread_id = ? AND projection_version = ? AND projection_status <> 'ready'`,
      )
      .bind(threadId, version),
  ]);
}

/** Delete only retired local rows after their external vectors are confirmed gone.
 * @param {Env} env @param {number} [limit] */
export async function cleanupRetiredMemoryChunks(env, limit = MEMORY_PROJECTION_RECONCILE_LIMIT) {
  if (!env.DB) throw new Error('памʼять: привʼязки DB немає');
  if (!env.VECTORIZE) throw new Error('памʼять: привʼязки VECTORIZE немає');
  const { results } = await env.DB.prepare(
    `SELECT id, vector_id FROM memory_chunks
       WHERE projection_status = 'retired' ORDER BY at LIMIT ?`,
  )
    .bind(limit)
    .all();
  const rows = /** @type {{ id: string, vector_id: string | null }[]} */ (results ?? []);
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.vector_id).filter(Boolean);
  if (ids.length) await env.VECTORIZE.deleteByIds(/** @type {string[]} */ (ids));
  const marks = rows.map(() => '?').join(', ');
  await env.DB.prepare(`DELETE FROM memory_chunks WHERE id IN (${marks})`)
    .bind(...rows.map((row) => row.id))
    .run();
  return rows.length;
}

/**
 * Repair interrupted pending/failed generations from their D1 text. Repeated
 * upsert by id is safe; an indexed generation merely needs the atomic ready
 * switch. Retired vectors are also drained here.
 * @param {Env} env @param {number} nowMs @param {number} [limit]
 */
export async function reconcileMemoryProjection(
  env,
  nowMs,
  limit = MEMORY_PROJECTION_RECONCILE_LIMIT,
) {
  if (!env.DB) throw new Error('памʼять: привʼязки DB немає');
  if (!env.VECTORIZE) throw new Error('памʼять: привʼязки VECTORIZE немає');
  const now = new Date(nowMs).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT thread_id, version, status, created_at FROM memory_projection_versions
       WHERE status IN ('pending', 'indexed', 'failed') ORDER BY created_at LIMIT ?`,
  )
    .bind(limit)
    .all();
  const versions =
    /** @type {{ thread_id: string, version: string, status: string, created_at: string }[]} */ (
      results ?? []
    );
  let repaired = 0;
  let failed = 0;
  for (const projection of versions) {
    try {
      if (projection.status !== 'indexed') {
        const { results: chunkRows } = await env.DB.prepare(
          `SELECT id, text, at FROM memory_chunks
             WHERE thread_id = ? AND projection_version = ?
               AND projection_status IN ('pending', 'failed') ORDER BY id`,
        )
          .bind(projection.thread_id, projection.version)
          .all();
        const chunks = /** @type {{ id: string, text: string, at: string }[]} */ (chunkRows ?? []);
        if (chunks.length === 0) throw new Error('projection не має D1-чанків');
        const vectors = await embedTexts(
          env,
          chunks.map((chunk) => chunk.text),
        );
        await env.VECTORIZE.upsert(
          chunks.map((chunk, i) => ({
            id: chunk.id,
            values: /** @type {number[]} */ (vectors[i]),
            metadata: {
              thread_id: projection.thread_id,
              at: chunk.at,
              projection_version: projection.version,
            },
          })),
        );
        await markProjectionIndexed(env, projection.thread_id, projection.version, now);
      }
      await activateProjection(
        env,
        projection.thread_id,
        projection.version,
        projection.created_at,
        now,
      );
      repaired += 1;
    } catch (/** @type {any} */ e) {
      failed += 1;
      await markProjectionFailed(
        env,
        projection.thread_id,
        projection.version,
        String(e?.message ?? 'reconcile failed'),
      );
    }
  }
  const retired = await cleanupRetiredMemoryChunks(env, limit);
  return { repaired, failed, retired };
}

/** Put the latest ready generation(s) back into pending and rebuild them from D1.
 * @param {Env} env @param {number} nowMs @param {string | null} [threadId]
 */
export async function rebuildMemoryProjection(env, nowMs, threadId = null) {
  if (!env.DB) throw new Error('памʼять: привʼязки DB немає');
  const where = threadId == null ? '' : 'AND thread_id = ?';
  const binds = threadId == null ? [] : [threadId];
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE memory_projection_versions SET status = 'pending', indexed_at = NULL, ready_at = NULL,
         error = NULL WHERE status = 'ready' ${where}`,
    ).bind(...binds),
    env.DB.prepare(
      `UPDATE memory_chunks SET projection_status = 'pending', indexed_at = NULL
         WHERE projection_status = 'ready' ${where}`,
    ).bind(...binds),
  ]);
  return reconcileMemoryProjection(env, nowMs);
}

/**
 * Пошук у згортках (S-N1-3): ембединг запиту → topK → тексти з D1 за
 * vector_id, у порядку релевантності, з датою кожної згортки.
 * @param {Env} env
 * @param {string} q
 * @param {number} limit
 * @returns {Promise<string>}
 */
export async function searchMemory(env, q, limit) {
  if (!env.DB) throw new Error('памʼять: привʼязки DB немає');
  if (!env.VECTORIZE) throw new Error('памʼять: привʼязки VECTORIZE немає');
  const [vector] = await embedTexts(env, [q]);
  const res = await env.VECTORIZE.query(/** @type {number[]} */ (vector), { topK: limit });
  const matches = res?.matches ?? [];
  if (matches.length === 0) return 'У памʼяті нічого не знаходжу.';

  const ids = matches.map((m) => m.id);
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id, at, text FROM memory_chunks
     WHERE id IN (${placeholders}) AND projection_status = 'ready'`,
  )
    .bind(...ids)
    .all();
  const byId = new Map(
    /** @type {{ id: string, at: string, text: string }[]} */ (results ?? []).map((r) => [r.id, r]),
  );
  const lines = matches
    .map((m) => byId.get(m.id))
    .filter((r) => r != null)
    // Нейтралізація тегів (defense-in-depth, security-ревʼю PR-2): згортка,
    // що містить `</external>` (від власника чи успадковане), не сміє
    // підробити рамку маркування іншого <external>-блоку в тому ж діалозі.
    .map((r) => `- [${String(r.at).slice(0, 10)}] ${neutralizeExternalTags(r.text)}`);
  // Вектори без рядків (ретенція 90 днів вичистила D1 раніше за індекс) -
  // чесно порожньо, не вигадані цитати.
  return lines.length > 0 ? lines.join('\n') : 'У памʼяті нічого не знаходжу.';
}

/**
 * Виконавець інструмента memory.search (07 §4): читання, НЕ taint - згортки
 * власних розмов, не зовнішній вміст.
 * @param {Env} env
 * @param {{ q: string, limit?: number }} args
 */
export async function runMemorySearch(env, args) {
  const limit = args.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT;
  return { result: await searchMemory(env, args.q, limit) };
}
