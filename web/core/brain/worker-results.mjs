// Результати працівників (07 §4 delegate, S-7-1; етап 4 PR-3): мозок кладе
// текст останнього працівника в deliver, ядро зберігає його в `reports`
// (kind `worker:<name>`) і дає кнопки під відповіддю: «✏️ Коротше» і «🔁 Інший
// тон» - той самий тред, наступний chat-прогін із підказкою (сесія памʼятає
// задачу); «📎 .md» - файл із базою. Понад 3 500 символів - файл іде одразу
// разом із копією в Drive (Світанок/workers), кнопки .md тоді немає.

import { sendDocument } from '../tg/outbox.mjs';
import { uploadMarkdown } from '../adapters/drive.mjs';

/** Стеля тексту працівника в чаті (S-7-1): довше - файл + Drive. */
export const WORKER_CHAT_MAX = 3_500;
export const WORKER_DRIVE_FOLDER = ['Світанок', 'workers'];
/** Підказки в тред за кнопками - модель дістає їх як текст власника. */
export const WORKER_FOLLOWUPS = {
  short: 'Коротше: скороти результат працівника вдвічі, суть лиши.',
  tone: 'Інший тон: перепиши результат працівника в іншому тоні, зміст той самий.',
};
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/** Кнопки під відповіддю (07 §9 `m:w:<id>:<choice>`). @param {string} id @param {boolean} withMd */
export function workerButtons(id, withMd) {
  const row = [
    { text: '✏️ Коротше', callback_data: `m:w:${id}:short` },
    { text: '🔁 Інший тон', callback_data: `m:w:${id}:tone` },
  ];
  if (withMd) row.push({ text: '📎 .md', callback_data: `m:w:${id}:md` });
  return [row];
}

/** @param {string} name @param {number} nowMs */
export function workerFilename(name, nowMs) {
  return `${name}-${new Date(nowMs).toISOString().slice(0, 10)}.md`;
}

/**
 * Зберегти результат працівника; повертає id рядка. Імʼя - з реєстру мозку
 * (латиниця з дефісом), текст - під кап; чуже імʼя - помилка контракту.
 * @param {Env} env @param {{ name: string, text: string }} worker @param {number} nowMs
 */
export async function saveWorkerResult(env, worker, nowMs) {
  const name = String(worker.name ?? '');
  if (!NAME_RE.test(name)) throw new Error(`worker: імʼя «${name.slice(0, 40)}» не за форматом`);
  // Довжину тримає DELIVER_SCHEMA.worker.text (20 000) ДО цього виклику.
  const text = String(worker.text ?? '');
  if (!text.trim()) throw new Error('worker: порожній текст');
  const id = crypto.randomUUID();
  await db(env)
    .prepare('INSERT INTO reports (id, kind, text_md, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, `worker:${name}`, text, new Date(nowMs).toISOString())
    .run();
  return { id, name, text };
}

/**
 * @param {Env} env @param {string} id
 * @returns {Promise<{ id: string, name: string, text: string, createdAt: string } | null>}
 */
export async function loadWorkerResult(env, id) {
  const row =
    /** @type {{ id: string, kind: string, text_md: string, created_at: string } | null} */ (
      await db(env)
        .prepare(
          `SELECT id, kind, text_md, created_at FROM reports WHERE id = ? AND kind LIKE 'worker:%'`,
        )
        .bind(id)
        .first()
    );
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.kind).slice('worker:'.length),
    text: String(row.text_md ?? ''),
    createdAt: String(row.created_at),
  };
}

/**
 * Файл із результатом у тред (кнопка «📎 .md» або довгий результат одразу).
 * @param {Env} env @param {{ chatId: number | string, threadId: number | string | null }} target
 * @param {{ name: string, text: string }} result @param {number} nowMs
 */
export async function sendWorkerDocument(env, target, result, nowMs) {
  await sendDocument(
    env,
    target,
    {
      filename: workerFilename(result.name, nowMs),
      content: result.text,
      caption: `Результат працівника «${result.name}»`,
    },
    nowMs,
  );
}

/**
 * Копія в Drive (S-7-1: «> 3 500 → .md + Drive») - best-effort: збій лише в
 * лог, файл у чаті власник уже має.
 * @param {Env} env @param {{ name: string, text: string }} result @param {number} nowMs
 */
export function uploadWorkerResult(env, result, nowMs) {
  return uploadMarkdown(
    env,
    WORKER_DRIVE_FOLDER,
    workerFilename(result.name, nowMs),
    result.text,
    'worker-results',
  );
}
