// Зовнішні копії даних: Vectorize, локальне сховище Claude SDK на VPS і
// зашифровані Drive-бекапи. D1 є картою цих копій, але НЕ доказом їхнього
// зникнення, тому порядок всюди один: зовнішнє видалення → локальний рядок.

import { callBrainAbort, callBrainDeleteSessions } from '../brain/run-client.mjs';
import { deleteFilePermanently, listManagedBackupFiles } from '../adapters/drive.mjs';
import { BACKUP_FOLDER_PATH } from '../backup/task.mjs';
import { registryClearAllThreads } from '../run-registry/client.mjs';

export const EXTERNAL_RETENTION_MS = 90 * 86_400_000;
export const EXTERNAL_DELETE_BATCH = 100;
export const EXTERNAL_SCAN_BATCH = 2_000;

/** Сигнал для T2: не помилка даних, а безпечне очікування фінішу SDK. */
export class ActiveBrainRunsError extends Error {
  code = 'active-brain-runs';
}

/** @template T @param {T[]} values @param {number} size @returns {T[][]} */
function batches(values, size = EXTERNAL_DELETE_BATCH) {
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - зовнішнє прибирання неможливе');
  return env.DB;
}

/**
 * Видалити SDK-сесії за конкретними D1-рядками. Локальні посилання стають
 * NULL тільки після підтвердження VPS. Ідентифікатори не пишуться в receipt.
 * @param {Env} env
 * @param {{ thread_id: string, sdk_session_id: string }[]} rows
 * @param {string} operationId
 * @param {number} nowMs
 */
export async function eraseSdkSessionRows(env, rows, operationId, nowMs) {
  let erased = 0;
  for (const [batchNo, part] of batches(rows).entries()) {
    const sessionIds = [...new Set(part.map((row) => String(row.sdk_session_id)))];
    const brain = await callBrainDeleteSessions(
      env,
      { runId: `${operationId}-sdk-${batchNo}`, sessionIds },
      nowMs,
    );
    if (!brain.ok) {
      if (brain.status === 409) throw new ActiveBrainRunsError('VPS ще виконує активний прогін');
      throw new Error(`VPS SDK-сесії не підтверджено: ${brain.detail}`);
    }
    const marks = part.map(() => '?').join(', ');
    await db(env)
      .prepare(`UPDATE sessions SET sdk_session_id = NULL WHERE thread_id IN (${marks})`)
      .bind(...part.map((row) => row.thread_id))
      .run();
    erased += part.length;
  }
  return erased;
}

/**
 * Регулярна 90-day ретенція повних SDK-транскриптів. D1 summary лишається
 * (це окреме, коротке джерело памʼяті), але повторно resume вже неможливий.
 * @param {Env} env @param {number} nowMs @param {number} [limit]
 */
export async function eraseExpiredSdkSessions(env, nowMs, limit = EXTERNAL_SCAN_BATCH) {
  const before = new Date(nowMs - EXTERNAL_RETENTION_MS).toISOString();
  const { results } = await db(env)
    .prepare(
      'SELECT thread_id, sdk_session_id FROM sessions WHERE sdk_session_id IS NOT NULL AND last_at < ? LIMIT ?',
    )
    .bind(before, limit)
    .all();
  const rows = /** @type {{ thread_id: string, sdk_session_id: string }[]} */ (results ?? []);
  if (rows.length === 0) return 0;
  return eraseSdkSessionRows(env, rows, `retention-${Math.floor(nowMs)}`, nowMs);
}

/** @param {Env} env @param {string[]} vectorIds */
export async function eraseVectorIds(env, vectorIds) {
  const ids = [...new Set(vectorIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return 0;
  if (!env.VECTORIZE) throw new Error('привʼязки VECTORIZE немає - вектори не підтверджено стерті');
  for (const part of batches(ids)) await env.VECTORIZE.deleteByIds(/** @type {string[]} */ (part));
  return ids.length;
}

/**
 * Регулярна 90-day ретенція memory_chunks. Вектор прибирається першим; якщо
 * Vectorize недоступний, текстовий рядок навмисно лишається на наступний tick.
 * @param {Env} env @param {number} nowMs @param {number} [limit]
 */
export async function eraseExpiredMemoryChunks(env, nowMs, limit = EXTERNAL_SCAN_BATCH) {
  const before = new Date(nowMs - EXTERNAL_RETENTION_MS).toISOString();
  const { results } = await db(env)
    .prepare('SELECT id, vector_id FROM memory_chunks WHERE at < ? LIMIT ?')
    .bind(before, limit)
    .all();
  const rows = /** @type {{ id: string, vector_id: string | null }[]} */ (results ?? []);
  if (rows.length === 0) return 0;
  await eraseVectorIds(
    env,
    rows.map((row) => row.vector_id ?? ''),
  );
  for (const part of batches(rows)) {
    const marks = part.map(() => '?').join(', ');
    await db(env)
      .prepare(`DELETE FROM memory_chunks WHERE id IN (${marks})`)
      .bind(...part.map((row) => row.id))
      .run();
  }
  return rows.length;
}

/**
 * Фізично стерти всі VPS SDK-транскрипти, що ще мають D1-посилання. D1 не
 * змінюється: `forgetAll` робить це лише після успіху КОЖНОГО зовнішнього
 * кроку, тож невдалий cleanup можна повторити без втрати адресатів.
 * @param {Env} env @param {string} operationId @param {number} nowMs
 */
export async function eraseAllSdkTranscripts(env, operationId, nowMs) {
  let afterRowId = 0;
  let erased = 0;
  for (;;) {
    const { results } = await db(env)
      .prepare(
        `SELECT rowid AS row_id, thread_id, sdk_session_id
         FROM sessions WHERE sdk_session_id IS NOT NULL AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .bind(afterRowId, EXTERNAL_SCAN_BATCH)
      .all();
    const rows = /** @type {{ row_id: number, thread_id: string, sdk_session_id: string }[]} */ (
      results ?? []
    );
    if (rows.length === 0) return erased;
    for (const [batchNo, part] of batches(rows).entries()) {
      const sessionIds = [...new Set(part.map((row) => String(row.sdk_session_id)))];
      const brain = await callBrainDeleteSessions(
        env,
        { runId: `${operationId}-sdk-${afterRowId}-${batchNo}`, sessionIds },
        nowMs,
      );
      if (!brain.ok) {
        if (brain.status === 409) throw new ActiveBrainRunsError('VPS ще виконує активний прогін');
        throw new Error(`VPS SDK-сесії не підтверджено: ${brain.detail}`);
      }
      erased += part.length;
    }
    const last = rows[rows.length - 1];
    if (!last) return erased;
    afterRowId = last.row_id;
  }
}

/** @param {Env} env */
export async function eraseAllMemoryVectors(env) {
  let afterRowId = 0;
  let erased = 0;
  for (;;) {
    const { results } = await db(env)
      .prepare(
        `SELECT rowid AS row_id, vector_id
         FROM memory_chunks WHERE vector_id IS NOT NULL AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .bind(afterRowId, EXTERNAL_SCAN_BATCH)
      .all();
    const rows = /** @type {{ row_id: number, vector_id: string }[]} */ (results ?? []);
    if (rows.length === 0) return erased;
    erased += await eraseVectorIds(
      env,
      rows.map((row) => row.vector_id),
    );
    const last = rows[rows.length - 1];
    if (!last) return erased;
    afterRowId = last.row_id;
  }
}

/**
 * Власницькі черги теж містять текст повідомлень. Спершу очищаємо їх у DO;
 * активні прогони просимо abortнути та відкладаємо наступний етап до моменту,
 * коли SDK точно перестане записувати транскрипт.
 * @param {Env} env @param {number} nowMs
 */
export async function eraseAllQueuedRuns(env, nowMs) {
  const queue = await registryClearAllThreads(env);
  if (queue.activeRunIds.length === 0) return queue.cleared;
  for (const runId of queue.activeRunIds) {
    const aborted = await callBrainAbort(env, runId, nowMs);
    if (!aborted.ok) console.error(`forget: abort ${runId} не підтверджено: ${aborted.detail}`);
  }
  throw new ActiveBrainRunsError('активні прогони зупиняються; cleanup повториться автоматично');
}

/** @param {Env} env */
async function hasRecordedBackup(env) {
  const result = await db(env)
    .prepare("SELECT 1 FROM facts WHERE kind = 'setting' AND key = 'last_backup' LIMIT 1")
    .bind()
    .first();
  return result != null;
}

/**
 * Видалити всі відомі app-owned бекапи. Відсутній last_backup означає, що цей
 * інстанс жодного backup не реєстрував — Drive не чіпаємо й не створюємо теку.
 * @param {Env} env
 */
export async function eraseAllManagedBackups(env) {
  if (!(await hasRecordedBackup(env))) return 0;
  const files = await listManagedBackupFiles(env, BACKUP_FOLDER_PATH);
  for (const file of files) await deleteFilePermanently(env, file.id);
  return files.length;
}

/** 90-day purge app-owned encrypted backups; список імен — proof scope.
 * @param {Env} env @param {number} nowMs */
export async function eraseExpiredManagedBackups(env, nowMs) {
  if (!(await hasRecordedBackup(env))) return 0;
  const before = nowMs - EXTERNAL_RETENTION_MS;
  const files = await listManagedBackupFiles(env, BACKUP_FOLDER_PATH);
  const expired = files.filter((file) => {
    const date = /^svitanok-(\d{4}-\d{2}-\d{2})\.enc$/.exec(file.name)?.[1];
    const at = date ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
    return Number.isFinite(at) && at < before;
  });
  for (const file of expired) await deleteFilePermanently(env, file.id);
  return expired.length;
}
