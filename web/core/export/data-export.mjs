// Експорт даних власника (S-0-6, 07 §4 `data.export`, етап 7 PR-4): усі
// таблиці D1 і ключі KV → JSON-файли в одному ZIP → Drive «Світанок/export/»
// → посилання в чат.
//
// ⚠️ СУПЕРЕЧНІСТЬ КАНОНУ, НАЗВАНА ВГОЛОС. 04-scenarios S-0-6 каже про
// `data.export` «T1», а 07 §4 і таблиця рівнів (policy/core.mjs
// ACTION_LEVELS) - «T2». Тут T2, як у 07 і в коді: експорт складає в один
// файл ВСЕ, що система знає про власника, і кладе його в хмару. Ціна помилки
// несиметрична - один зайвий ✅ проти повного дампа, який виїхав за межу
// системи, - тож із двох записів канону обрано суворіший. Рядок у 04 треба
// виправити.
//
// ⚠️ СЕКРЕТИ В ЕКСПОРТ НЕ ПОТРАПЛЯЮТЬ. Два барʼєри: кеш OAuth-токена не
// входить у знімок узагалі (EXPORT_KV_EXCLUDE), а перед пакуванням кожен
// файл проходить чистку за ТОЧНИМИ значеннями секретів оточення - на випадок,
// якщо ключ колись потрапив у чат, факт чи згортку сесії. Тест доводить це
// на env із упізнаваними значеннями.

import { dumpTables, dumpKv } from '../backup/task.mjs';
import {
  assistantHistorySnapshot,
  mutableStateSnapshot,
  sentMessagesSnapshot,
} from '../../kv-store.mjs';
import { BACKUP_TABLES, BACKUP_KV_EXCLUDE } from '../backup/core.mjs';
import { ensureFolderPath, uploadFile } from '../adapters/drive.mjs';
import { buildZip } from './zip.mjs';
import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';

/** Тека експортів у Drive (S-0-6). */
export const EXPORT_FOLDER = ['Світанок', 'export'];

/** KV-ключі, яких в експорті немає: кеш access-токена Google - це секрет. */
export const EXPORT_KV_EXCLUDE = new Set([...BACKUP_KV_EXCLUDE, 'googleToken']);

/**
 * Імена змінних оточення, чиї ЗНАЧЕННЯ не сміють опинитись у файлі. Список
 * іменний (не «усе, що схоже на токен»): точний збіг не дає хибних спрацювань
 * на власних даних, а саме вони - сенс експорту.
 */
export const SECRET_ENV_NAMES = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_CLIENT_ID',
  'MAPS_API_KEY',
  'GEMINI_API_KEY',
  'DEEPGRAM_API_KEY',
  'ITAD_API_KEY',
  'MONO_TOKEN',
  'MONO_WEBHOOK_SECRET',
  'WEATHER_API_KEY',
  'NEWSDATA_API_KEY',
  'BRAIN_ACCESS_CLIENT_ID',
  'BRAIN_ACCESS_CLIENT_SECRET',
  'INTERNAL_HMAC_KEY',
  'INTERNAL_HMAC_KEY_NEXT',
  'OPENAI_API_KEY',
  'BACKUP_ENC_KEY',
  'GH_DISPATCH_TOKEN',
  'REPO_READ_PAT',
  // Легасі-хост ще живий (agent-runtime.mjs) - його секрет теж не має поїхати.
  'LLM_HOST_SECRET',
];

/** Коротші за це не шукаємо: випадковий збіг зіпсував би дані власника. */
export const SECRET_MIN_LENGTH = 12;
export const REDACTED = '«секрет прибрано»';

/**
 * Значення секретів, за якими чистимо. Порядок - від довшого: інакше коротший
 * секрет, що є префіксом довшого, розрізав би його на шматки й лишив хвіст.
 * @param {Env} env
 */
export function secretValues(env) {
  const seen = new Set();
  for (const name of SECRET_ENV_NAMES) {
    const value = String(/** @type {any} */ (env)[name] ?? '').trim();
    if (value.length >= SECRET_MIN_LENGTH) seen.add(value);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** @param {string} text @param {string[]} secrets */
export function redactSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

/**
 * Зібрати файли експорту (без мережі - щоб їх можна було перевірити цілком).
 * @param {{ tables: Record<string, Record<string, unknown>[]>, kv: Record<string, string>,
 *   secrets: string[], nowMs: number }} input
 * @returns {{ name: string, bytes: Uint8Array }[]}
 */
export function buildExportFiles(input) {
  const enc = new TextEncoder();
  /** @type {{ name: string, bytes: Uint8Array }[]} */
  const files = [];
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of BACKUP_TABLES) {
    const rows = input.tables[table] ?? [];
    counts[table] = rows.length;
    files.push({
      name: `d1/${table}.json`,
      bytes: enc.encode(redactSecrets(JSON.stringify(rows, null, 2), input.secrets)),
    });
  }
  /** @type {Record<string, string>} */
  const kv = {};
  for (const [key, value] of Object.entries(input.kv)) {
    if (!EXPORT_KV_EXCLUDE.has(key)) kv[key] = value;
  }
  files.push({
    name: 'kv.json',
    bytes: enc.encode(redactSecrets(JSON.stringify(kv, null, 2), input.secrets)),
  });
  files.push({
    name: 'README.txt',
    bytes: enc.encode(
      [
        'Експорт даних Світанку.',
        `Створено: ${new Date(input.nowMs).toISOString()}`,
        `Таблиць: ${BACKUP_TABLES.length}, рядків: ${Object.values(counts).reduce((a, b) => a + b, 0)}, ключів KV: ${Object.keys(kv).length}`,
        '',
        'd1/<таблиця>.json - усі рядки таблиці як є.',
        'kv.json - ключі KV (кеш токена Google не входить).',
        'Секретів тут немає: значення ключів і токенів вирізані.',
        '',
        'Рядки за таблицями:',
        ...Object.entries(counts).map(([t, n]) => `  ${t}: ${n}`),
      ].join('\n'),
    ),
  });
  return files;
}

/** Мітка в імені файла - київські дата й час: власник шукає експорт за своїм
 *  днем, а не за UTC. @param {number} nowMs */
export function exportStamp(nowMs) {
  const now = new Date(nowMs);
  const minute = kyivMinuteOfDay(now);
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${kyivDateKey(now)}-${hh}${mm}`;
}

/**
 * Повний експорт: читання → файли → ZIP → Drive. Кидає при будь-якому збої -
 * це дія після ✅, і тихе «готово» без файла тут неприпустиме.
 * @param {Env} env @param {number} nowMs
 * @returns {Promise<{ file_id: string, name: string, bytes: number, files: number }>}
 */
export async function runDataExport(env, nowMs) {
  if (!env.DB) throw new Error('привʼязки DB немає - експорт неможливий');
  const [tables, kv, mutable, sentMessages, assistantHistory] = await Promise.all([
    dumpTables(env),
    dumpKv(env),
    mutableStateSnapshot(env),
    sentMessagesSnapshot(env),
    assistantHistorySnapshot(env),
  ]);
  if (mutable) {
    kv.state = JSON.stringify(mutable.state);
    kv.stats = JSON.stringify(mutable.stats);
    kv.settings = JSON.stringify(mutable.settings);
  }
  if (sentMessages) kv.sentMessages = JSON.stringify(sentMessages);
  if (assistantHistory) kv.assistantHistory = JSON.stringify(assistantHistory);
  const files = buildExportFiles({ tables, kv, secrets: secretValues(env), nowMs });
  const zip = await buildZip(files, { dateMs: nowMs });
  const name = `svitanok-export-${exportStamp(nowMs)}.zip`;
  const folderId = await ensureFolderPath(env, EXPORT_FOLDER);
  const uploaded = await uploadFile(env, {
    name,
    parentId: folderId,
    bytes: zip,
    mimeType: 'application/zip',
  });
  return { file_id: uploaded.id, name, bytes: zip.length, files: files.length };
}
