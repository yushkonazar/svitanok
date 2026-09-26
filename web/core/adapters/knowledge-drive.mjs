// Єдиний шлях читання файла Drive для вузької бази знань. Він навмисно не
// містить search/list: у URL API завжди стоїть ОДИН уже названий file_id.
// Так `drive.readonly` не перетворюється на право масово індексувати Drive.

import { googleTokenInfo } from '../../google.mjs';
import { featureNotConnectedText, hasFeatureScope } from '../google-scopes.mjs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOCUMENT_MIME = 'application/vnd.google-apps.document';
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const REQUEST_TIMEOUT_MS = 30_000;
export const KNOWLEDGE_DRIVE_MAX_BYTES = 800_000;
export const KNOWLEDGE_DRIVE_MAX_CHARS = 200_000;

/** @param {unknown} value */
function fileId(value) {
  const out = String(value ?? '').trim();
  if (!DRIVE_FILE_ID_RE.test(out))
    throw new Error('база знань: file_id не схожий на id файла Drive');
  return out;
}

/** Назва з Drive — зовнішній metadata-текст, без контролів/біді та переносів.
 * @param {unknown} value */
function title(value) {
  const out = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim();
  if (!out || out.length > 200) throw new Error('база знань: некоректна назва файла Drive');
  return out;
}

/** @param {unknown} value @param {string} field @param {number} max */
function requiredText(value, field, max) {
  const out = String(value ?? '').trim();
  if (!out || out.length > max) throw new Error(`база знань: некоректне поле ${field} від Drive`);
  return out;
}

/** @param {string} mimeType */
function formatOf(mimeType) {
  if (mimeType === GOOGLE_DOCUMENT_MIME) return 'google-document';
  if (TEXT_MIMES.has(mimeType)) return 'plain-text';
  return null;
}

/** @param {Env} env */
async function tokenOrThrow(env) {
  const { token, scopes } = await googleTokenInfo(env);
  if (!token) throw new Error('Google OAuth недоступний (секрети або мережа)');
  if (!hasFeatureScope(scopes, 'drive_read'))
    throw new Error(featureNotConnectedText('drive_read'));
  return token;
}

/** @param {string} url @param {RequestInit} init */
async function request(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`база знань: Drive HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a streaming response with a hard byte ceiling before decoding it.
 * @param {Response} response @param {number} maxBytes */
async function cappedBytes(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`база знань: файл Drive більший за ${maxBytes} байт`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new Error(`база знань: файл Drive більший за ${maxBytes} байт`);
    return bytes;
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`база знань: файл Drive більший за ${maxBytes} байт`);
      }
      parts.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of parts) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Метадані РІВНО одного файла. Результат — зовнішній вміст: caller мусить
 * позначити ним тред як tainted до будь-якої наступної дії назовні.
 * @param {Env} env @param {{fileId: unknown}} input
 */
export async function inspectKnowledgeDriveFile(env, input) {
  const id = fileId(input.fileId);
  const token = await tokenOrThrow(env);
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(id)}`);
  url.searchParams.set(
    'fields',
    'id,name,mimeType,version,modifiedTime,size,trashed,capabilities(canDownload)',
  );
  url.searchParams.set('supportsAllDrives', 'true');
  const response = await request(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const raw = await response.json();
  if (raw?.trashed === true) throw new Error('база знань: файл Drive у кошику');
  const actualId = fileId(raw?.id);
  if (actualId !== id) throw new Error('база знань: Drive повернув інший file_id');
  const mimeType = requiredText(raw?.mimeType, 'mime_type', 120);
  const sourceVersion = requiredText(raw?.version ?? raw?.modifiedTime, 'source_version', 160);
  const rawSize = raw?.size == null ? null : Number(raw.size);
  if (rawSize != null && (!Number.isFinite(rawSize) || rawSize < 0)) {
    throw new Error('база знань: некоректний size від Drive');
  }
  if (rawSize != null && rawSize > KNOWLEDGE_DRIVE_MAX_BYTES) {
    throw new Error(`база знань: файл Drive більший за ${KNOWLEDGE_DRIVE_MAX_BYTES} байт`);
  }
  const format = formatOf(mimeType);
  return {
    file_id: actualId,
    title: title(raw?.name),
    mime_type: mimeType,
    source_version: sourceVersion,
    ...(rawSize == null ? {} : { size: Math.trunc(rawSize) }),
    importable: format != null && raw?.capabilities?.canDownload !== false,
    ...(format ? { format } : { reason: 'Підтримуються лише Google Docs, UTF-8 .txt та .md.' }),
  };
}

/**
 * Повторно звіряє metadata, а тоді повертає текст для ingestion. Очікувані
 * title/version/mime записуються в T1-пропозицію після inspect; якщо файл
 * змінився між inspect та ✅, байти навіть не починають завантажуватись.
 * @param {Env} env
 * @param {{fileId: unknown, title: unknown, sourceVersion: unknown, mimeType: unknown}} input
 */
export async function readKnowledgeDriveFile(env, input) {
  const expected = {
    file_id: fileId(input.fileId),
    title: title(input.title),
    source_version: requiredText(input.sourceVersion, 'source_version', 160),
    mime_type: requiredText(input.mimeType, 'mime_type', 120),
  };
  const meta = await inspectKnowledgeDriveFile(env, { fileId: expected.file_id });
  if (
    meta.title !== expected.title ||
    meta.source_version !== expected.source_version ||
    meta.mime_type !== expected.mime_type
  ) {
    throw new Error('база знань: файл Drive змінився після перевірки — переглянь його ще раз');
  }
  if (!meta.importable || !('format' in meta)) {
    const reason = 'reason' in meta ? meta.reason : '';
    throw new Error(`база знань: «${meta.title}» не можна імпортувати. ${reason}`.trim());
  }
  const format = meta.format;
  const token = await tokenOrThrow(env);
  const url = new URL(
    format === 'google-document'
      ? `${DRIVE_API}/files/${encodeURIComponent(meta.file_id)}/export`
      : `${DRIVE_API}/files/${encodeURIComponent(meta.file_id)}`,
  );
  if (format === 'google-document') url.searchParams.set('mimeType', 'text/plain');
  else url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  const response = await request(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      await cappedBytes(response, KNOWLEDGE_DRIVE_MAX_BYTES),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('база знань:')) throw error;
    throw new Error('база знань: файл Drive має бути UTF-8 текстом', { cause: error });
  }
  content = content.replace(/^\uFEFF/, '').trim();
  if (!content) throw new Error('база знань: у файлі Drive немає тексту');
  if (content.length > KNOWLEDGE_DRIVE_MAX_CHARS) {
    throw new Error(
      `база знань: текст файла Drive довший за ${KNOWLEDGE_DRIVE_MAX_CHARS} символів`,
    );
  }
  return {
    sourceType: 'drive',
    sourceRef: meta.file_id,
    title: meta.title,
    sourceVersion: meta.source_version,
    content,
  };
}
