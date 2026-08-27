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
 * Записати згортку треду в памʼять: рядки в D1 (джерело тексту) ПЕРШИМИ, потім
 * вектори у Vectorize. Порядок свідомий: збій Vectorize лишає рядки без
 * векторів (пошук їх не бачить, але текст цілий і згортка є в sessions);
 * зворотний порядок лишав би «сироти»-вектори без тексту.
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

  const vectors = await embedTexts(env, chunks);
  const at = new Date(nowMs).toISOString();
  const rows = chunks.map((text, i) => ({
    id: crypto.randomUUID(),
    text,
    vector: /** @type {number[]} */ (vectors[i]),
  }));

  // Згортка треду ЗАМІЩУЄ попередню, а не накопичується (ревʼю PR-2): інакше
  // memory.search віддавав би N застарілих версій тих самих подій. Стара
  // партія чанків цього треду - геть: спершу з Vectorize (за зібраними
  // vector_id), потім з D1 і вставка нової - усе D1 однією batch-транзакцією,
  // тож часткова вставка неможлива (ревʼю PR-2: осиротілі рядки без векторів).
  const { results } = await db
    .prepare('SELECT vector_id FROM memory_chunks WHERE thread_id = ?')
    .bind(threadId)
    .all();
  const oldVectorIds = /** @type {{ vector_id: string }[]} */ (results ?? [])
    .map((r) => r.vector_id)
    .filter(Boolean);
  if (oldVectorIds.length > 0) await env.VECTORIZE.deleteByIds(oldVectorIds);

  await db.batch([
    db.prepare('DELETE FROM memory_chunks WHERE thread_id = ?').bind(threadId),
    ...rows.map((row) =>
      db
        .prepare(
          'INSERT INTO memory_chunks (id, thread_id, at, text, vector_id) VALUES (?1, ?2, ?3, ?4, ?1)',
        )
        .bind(row.id, threadId, at, row.text),
    ),
  ]);
  await env.VECTORIZE.upsert(
    rows.map((row) => ({
      id: row.id,
      values: row.vector,
      metadata: { thread_id: threadId, at },
    })),
  );
  return { written: rows.length };
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
    `SELECT id, at, text FROM memory_chunks WHERE id IN (${placeholders})`,
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
