// Бекап (05-ops §«Бекапи», етап 3 PR-6) - чиста частина: що саме входить у
// знімок, як він шифрується і як з нього збирається SQL для відновлення.
// Без привʼязок і мережі - той самий модуль читає і Worker (задача нд 03:00),
// і scripts/restore.mjs у Node (WebCrypto є в обох).
//
// Формат файлу .enc: 4 байти магії «SVB1» + 12 байт IV + AES-256-GCM
// (шифротекст із тегом). Ключ - SHA-256 від рядка BACKUP_ENC_KEY: секрет
// у Cloudflare - довільний рядок, а GCM потребує рівно 32 байти; хеш робить
// це детермінованим і незалежним від того, як власник його згенерував.
// Ротації ключа немає (R16): втрата ключа = бекапи нечитабельні.

import { recordFtsText } from '../tools/collections.mjs';

/** Магія формату - версія 1. */
export const BACKUP_MAGIC = 'SVB1';
/** Версія документа всередині (структура JSON). */
export const BACKUP_DOC_VERSION = 1;

/**
 * Таблиці D1 у знімку - усе з міграцій 0001-0010, крім FTS (віртуальні,
 * перебудовуються з базових) і migrations_meta (не читається ніким).
 * Порядок - порядок відновлення (без FK у схемі порядок не критичний, але
 * стабільний порядок робить diff двох бекапів читабельним).
 */
export const BACKUP_TABLES = [
  'facts',
  'fact_ledger',
  'sessions',
  'memory_chunks',
  'memory_projection_versions',
  'reminders',
  'proposals',
  'chains',
  'outbox',
  'runs',
  'run_steps',
  'quota_counters',
  'places',
  'ideas',
  'idea_events',
  'wishes',
  'price_points',
  'trips',
  'transactions',
  'subscriptions',
  'merchant_rules',
  'inbox_messages',
  'inbox_digests',
  'collections',
  'records',
  'instructions',
  'instruction_history',
  'reports',
  'style_corpus',
  'day_plans',
  'plan_items',
  'voice_pending',
  'counters',
];

/** FTS-таблиці, які restore перебудовує з базових (ADR-036: standalone). */
export const BACKUP_FTS = {
  ideas_fts: { from: 'ideas', columns: ['id', 'title', 'body_md'] },
  records_fts: { from: 'records', columns: ['id', 'data_text'] },
  inbox_fts: { from: 'inbox_messages', columns: ['id', 'text'] },
};

/** KV-ключі, яких у бекапі НЕ буде: кеш OAuth-токена - секрет, і він
 *  короткоживучий. Решта KV - дані власника (stats, state, архіви, levers…). */
export const BACKUP_KV_EXCLUDE = new Set(['googleToken']);

/**
 * @typedef {{
 *   version: number,
 *   created_at: string,
 *   env: string,
 *   d1: Record<string, Record<string, unknown>[]>,
 *   kv: Record<string, string>,
 * }} BackupDocument
 */

/**
 * Зібрати документ бекапу з уже прочитаних рядків і KV.
 * @param {{ createdMs: number, envName: string, tables: Record<string, Record<string, unknown>[]>, kv: Record<string, string> }} input
 * @returns {BackupDocument}
 */
export function buildBackupDocument(input) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const d1 = {};
  for (const name of BACKUP_TABLES) d1[name] = input.tables[name] ?? [];
  /** @type {Record<string, string>} */
  const kv = {};
  for (const [k, v] of Object.entries(input.kv)) {
    if (!BACKUP_KV_EXCLUDE.has(k)) kv[k] = v;
  }
  return {
    version: BACKUP_DOC_VERSION,
    created_at: new Date(input.createdMs).toISOString(),
    env: input.envName,
    d1,
    kv,
  };
}

/** Підсумок для повідомлення/логу: рядків по таблицях, ключів KV. @param {BackupDocument} doc */
export function summarizeBackup(doc) {
  const rows = Object.values(doc.d1).reduce((a, t) => a + t.length, 0);
  const nonEmpty = Object.entries(doc.d1)
    .filter(([, t]) => t.length > 0)
    .map(([name, t]) => `${name}=${t.length}`);
  return { tables: Object.keys(doc.d1).length, rows, kvKeys: Object.keys(doc.kv).length, nonEmpty };
}

// ── Крипто ─────────────────────────────────────────────────────────────────

/** @param {string} secret */
async function deriveKey(secret) {
  if (!secret || secret.trim().length < 16) {
    throw new Error('BACKUP_ENC_KEY порожній або коротший за 16 символів');
  }
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret.trim()));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Зашифрувати документ у байти формату SVB1.
 * @param {string} secret - BACKUP_ENC_KEY
 * @param {BackupDocument} doc
 * @returns {Promise<Uint8Array>}
 */
export async function encryptBackup(secret, doc) {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(doc));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const magic = new TextEncoder().encode(BACKUP_MAGIC);
  const out = new Uint8Array(magic.length + iv.length + cipher.length);
  out.set(magic, 0);
  out.set(iv, magic.length);
  out.set(cipher, magic.length + iv.length);
  return out;
}

/**
 * Розшифрувати байти формату SVB1 у документ. Чужий формат або чужий ключ -
 * явна помилка (GCM не віддає сміття мовчки).
 * @param {string} secret
 * @param {Uint8Array} bytes
 * @returns {Promise<BackupDocument>}
 */
export async function decryptBackup(secret, bytes) {
  const magic = new TextDecoder().decode(bytes.slice(0, 4));
  if (magic !== BACKUP_MAGIC) throw new Error(`не файл бекапу Світанку (магія «${magic}»)`);
  if (bytes.length < 4 + 12 + 16) throw new Error('файл бекапу закороткий');
  const key = await deriveKey(secret);
  const iv = bytes.slice(4, 16);
  const cipher = bytes.slice(16);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  } catch {
    throw new Error('розшифрувати не вдалося: чужий ключ або пошкоджений файл');
  }
  const doc = JSON.parse(new TextDecoder().decode(plain));
  if (doc?.version !== BACKUP_DOC_VERSION || typeof doc.d1 !== 'object') {
    throw new Error(`невідома версія документа бекапу (${String(doc?.version)})`);
  }
  return /** @type {BackupDocument} */ (doc);
}

/** sha256 hex байтів - відбиток файлу для facts.setting.last_backup. @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── SQL для відновлення ────────────────────────────────────────────────────

/**
 * SQL-скрипт відновлення: одна транзакція, кожна таблиця - DELETE + INSERT
 * рядками, FTS перебудовується з базових таблиць. Значення - літералами з
 * екрануванням (скрипт іде у `wrangler d1 execute --file`, біндингів там
 * немає): рядки в одинарних лапках із подвоєнням, числа як є, null як NULL.
 * Імена таблиць і колонок - лише з документа, звірені з BACKUP_TABLES і
 * регексом ідентифікатора, тож рядок даних не може стати кодом.
 * @param {BackupDocument} doc
 * @returns {string}
 */
export function restoreSql(doc) {
  /** @type {string[]} */
  const lines = ['BEGIN TRANSACTION;'];
  for (const table of BACKUP_TABLES) {
    const rows = doc.d1[table] ?? [];
    lines.push(`DELETE FROM ${table};`);
    for (const row of rows) {
      const cols = Object.keys(row).filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
      if (cols.length === 0) continue;
      const values = cols.map((c) => sqlLiteral(row[c]));
      lines.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values.join(', ')});`);
    }
  }
  // Бекап до міграції 0011 (ideas без number, без counters): номери - з
  // rowid, лічильник - з максимуму; інакше відновлені ідеї були б «#null»,
  // а create падав би з хибним «міграція не застосована» (ревʼю 05.09).
  lines.push('UPDATE ideas SET number = rowid WHERE number IS NULL;');
  // OR IGNORE, не WHERE NOT EXISTS: агрегат MAX() віддає рядок навіть із
  // хибним WHERE, і INSERT падав би на PK, коли лічильник уже відновлено.
  lines.push(
    `INSERT OR IGNORE INTO counters (name, value) SELECT 'ideas', COALESCE(MAX(number), 0) FROM ideas;`,
  );
  for (const [fts, spec] of Object.entries(BACKUP_FTS)) {
    lines.push(`DELETE FROM ${fts};`);
    if (fts === 'records_fts') {
      // data_text рахується тією самою формулою, що при записі
      // (recordFtsText): назва колекції + значення, а не сирий JSON із
      // ключами - інакше пошук після відновлення знаходив би імена полів.
      const names = new Map(
        (doc.d1.collections ?? []).map((c) => [String(c.id), String(c.name ?? '')]),
      );
      for (const r of doc.d1.records ?? []) {
        const text = recordFtsText(
          names.get(String(r.collection_id)) ?? '',
          parseJsonObject(r.data_json),
        );
        lines.push(
          `INSERT INTO records_fts (id, data_text) VALUES (${sqlLiteral(r.id)}, ${sqlLiteral(text)});`,
        );
      }
      continue;
    }
    const cols = spec.columns.join(', ');
    lines.push(`INSERT INTO ${fts} (${cols}) SELECT ${cols} FROM ${spec.from};`);
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

/** data_json запису → обʼєкт; биття - порожній обʼєкт (як parseData у collections). @param {unknown} raw */
function parseJsonObject(raw) {
  try {
    const v = JSON.parse(String(raw ?? ''));
    return v && typeof v === 'object' && !Array.isArray(v)
      ? /** @type {Record<string, unknown>} */ (v)
      : {};
  } catch {
    return {};
  }
}

/** @param {unknown} v */
function sqlLiteral(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}
