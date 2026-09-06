// Адаптер запису в Google Drive (01 §2.1 adapters, скоуп drive.file з етапу
// 0): теки й завантаження файлів. Ключі - лише тут (googleAccessToken);
// помилка HTTP - виняток із кодом, не null: бекап без файлу мусить бути
// видимим збоєм, а не тихим «ок».
//
// drive.file бачить ЛИШЕ файли, створені цим застосунком, тож тека
// «Світанок» шукається серед своїх і створюється, якщо її ще немає.

import { googleAccessToken } from '../../google.mjs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Таймаут одного HTTP-виклику: бекап у кілька мегабайт має встигнути. */
const DRIVE_TIMEOUT_MS = 60_000;

/** @param {Env} env */
async function tokenOrThrow(env) {
  const token = await googleAccessToken(env);
  if (!token) throw new Error('Google OAuth недоступний (секрети або мережа)');
  return token;
}

/**
 * @param {string} url
 * @param {RequestInit} init
 */
async function driveFetch(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DRIVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return /** @type {any} */ (await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Escape для мови запитів Drive - той самий, що в searchDrive. @param {string} s */
function q(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Знайти теку за назвою в батьківській (або в корені) серед видимих
 * застосунку; null - немає.
 * @param {Env} env
 * @param {string} name
 * @param {string | null} parentId
 */
export async function findFolder(env, name, parentId) {
  const token = await tokenOrThrow(env);
  const url = new URL(`${DRIVE_API}/files`);
  const parent = parentId ? `'${q(parentId)}' in parents and ` : '';
  url.searchParams.set(
    'q',
    `${parent}name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
  );
  url.searchParams.set('fields', 'files(id,name)');
  url.searchParams.set('pageSize', '1');
  const json = await driveFetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const id = json?.files?.[0]?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * Тека за шляхом («Світанок/backups»): кожен сегмент знаходиться або
 * створюється. Повертає id останньої.
 * @param {Env} env
 * @param {string[]} path
 */
export async function ensureFolderPath(env, path) {
  /** @type {string | null} */
  let parent = null;
  for (const name of path) {
    const found = await findFolder(env, name, parent);
    if (found) {
      parent = found;
      continue;
    }
    const token = await tokenOrThrow(env);
    const created = await driveFetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        ...(parent ? { parents: [parent] } : {}),
      }),
    });
    if (typeof created?.id !== 'string') throw new Error(`Drive: теку «${name}» не створено`);
    parent = created.id;
  }
  if (!parent) throw new Error('Drive: порожній шлях теки');
  return parent;
}

/**
 * Markdown-файл у теку за шляхом - best-effort: null = не збережено (у лог
 * із префіксом), бо документ у чаті власник уже має (аналіз ідеї, результат
 * працівника).
 * @param {Env} env @param {string[]} folderPath @param {string} name @param {string} text @param {string} logPrefix
 */
export async function uploadMarkdown(env, folderPath, name, text, logPrefix) {
  try {
    const folderId = await ensureFolderPath(env, folderPath);
    const up = await uploadFile(env, {
      name,
      parentId: folderId,
      bytes: new TextEncoder().encode(text),
      mimeType: 'text/markdown',
    });
    return up.id;
  } catch (/** @type {any} */ e) {
    console.error(`${logPrefix}: копія в Drive не збережена`, e?.message);
    return null;
  }
}

/**
 * Завантажити файл (multipart: метадані + вміст) у теку.
 * @param {Env} env
 * @param {{ name: string, parentId: string, bytes: Uint8Array, mimeType?: string }} file
 * @returns {Promise<{ id: string, name: string, size: number }>}
 */
export async function uploadFile(env, file) {
  const token = await tokenOrThrow(env);
  const form = new FormData();
  form.set(
    'metadata',
    new Blob([JSON.stringify({ name: file.name, parents: [file.parentId] })], {
      type: 'application/json',
    }),
  );
  form.set('file', new Blob([file.bytes], { type: file.mimeType ?? 'application/octet-stream' }));
  const json = await driveFetch(`${DRIVE_UPLOAD}&fields=id,name,size`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (typeof json?.id !== 'string') throw new Error('Drive: файл завантажено без id');
  return { id: json.id, name: String(json.name ?? file.name), size: Number(json.size ?? 0) };
}
