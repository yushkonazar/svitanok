// Колекції власника (07 §1 `collections`/`records`, §2 схема поля, §4
// `collections.*`/`records.*`, S-N4-1…5, етап 3 PR-5). Колекція - таблиця,
// яку власник створює діалогом: схема полів у fields_json, записи - JSON у
// data_json. Запит «покажи X де поле > n» компілює ЯДРО (compileWhere) у SQL
// по json_extract з біндингами - модель передає структурований фільтр і
// ніколи не пише SQL (ADR-011 у 02-decisions).
//
// Рівні: collections.create/update, records.create/update - T0 з «↩»;
// records.delete - T1; видалення колекції з усіма записами - T2 через
// forget (collections.delete - той самий kind); експорт - T1 (.csv
// документом до Sheets на етапі 7, S-N4-4).
//
// FTS (records_fts, ADR-036): data_text = назва колекції + усі значення;
// синхронізується кодом разом із записом у базову таблицю.

import { ftsQuery } from './ideas.mjs';

/** Типи полів - дослівно 07 §2. */
export const FIELD_TYPES = ['text', 'number', 'date', 'bool', 'choice', 'url', 'money'];
/** Оператори фільтра records.list.where. */
export const WHERE_OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'in', 'empty', 'not_empty'];
/** Стеля таблиці у відповіді (S-N4-3: «таблиця ≤ 20 рядків»). */
export const RECORDS_LIST_MAX = 20;
export const COLLECTIONS_LIST_MAX = 50;
/** Стелі схеми: полів у колекції і варіантів у choice. */
export const FIELDS_MAX = 24;
export const CHOICE_OPTIONS_MAX = 50;
/** Кап експорту: рядків у .csv (тіло документа йде в outbox; 128К - кап internal API не застосовний, бо документ будує ядро). */
export const EXPORT_ROWS_MAX = 5_000;

const FIELD_NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]{0,63}$/u;
/** Ключі, які records.list додає до кожного рядка поверх даних. */
const RESERVED_FIELD_NAMES = new Set(['id', '_updated']);
/** BOM для Excel - через код символу, не літерал: невидимий символ у
 *  джерелі лінтер (no-irregular-whitespace) і читач сприймають за сміття. */
const CSV_BOM = String.fromCharCode(0xfeff);

/**
 * @typedef {{ name: string, type: string, required?: boolean, options?: string[],
 *   currency?: string, default?: unknown }} FieldDef
 * @typedef {{ id: string, name: string, description: string | null, fields: FieldDef[],
 *   sort_by: string | null, created_at: string }} Collection
 */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - collections недоступні');
  return env.DB;
}

// ── Схема ──────────────────────────────────────────────────────────────────

/**
 * Перевірити й нормалізувати схему полів (07 §2). Помилки - словами для
 * моделі, яка пропонує схему через `ask` (S-N4-1).
 * @param {unknown} raw
 * @returns {FieldDef[]}
 */
export function normalizeFields(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('fields - непорожній список полів');
  if (raw.length > FIELDS_MAX) throw new Error(`полів не більше ${FIELDS_MAX}`);
  /** @type {FieldDef[]} */
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    const name = String(/** @type {any} */ (f)?.name ?? '').trim();
    const type = String(/** @type {any} */ (f)?.type ?? '').trim();
    if (!FIELD_NAME_RE.test(name))
      throw new Error(`назва поля «${name}» - літери, цифри, _, до 64`);
    const key = name.toLowerCase();
    // Службові ключі рядка у відповіді records.list: поле з таким імʼям
    // затерло б id запису, і модель не змогла б його оновити.
    if (RESERVED_FIELD_NAMES.has(key)) throw new Error(`назва поля «${name}» зарезервована`);
    if (seen.has(key)) throw new Error(`поле «${name}» повторюється`);
    seen.add(key);
    if (!FIELD_TYPES.includes(type)) {
      throw new Error(`тип поля «${name}» - один із ${FIELD_TYPES.join(' · ')}, не «${type}»`);
    }
    /** @type {FieldDef} */
    const def = { name, type };
    if (/** @type {any} */ (f).required === true) def.required = true;
    if (type === 'choice') {
      const options = /** @type {any} */ (f).options;
      if (!Array.isArray(options) || options.length === 0) {
        throw new Error(`поле «${name}» типу choice потребує options`);
      }
      if (options.length > CHOICE_OPTIONS_MAX)
        throw new Error(`options «${name}»: ≤ ${CHOICE_OPTIONS_MAX}`);
      def.options = options.map((o) => String(o).trim()).filter(Boolean);
    }
    if (type === 'money') {
      const cur = /** @type {any} */ (f).currency;
      if (cur != null) def.currency = String(cur).toUpperCase().slice(0, 3);
    }
    if (/** @type {any} */ (f).default !== undefined) {
      def.default = coerceValue(def, /** @type {any} */ (f).default);
    }
    out.push(def);
  }
  return out;
}

/**
 * Привести значення до типу поля або кинути зрозумілу помилку. null/'' -
 * порожньо (дозволено для необовʼязкових).
 * @param {FieldDef} field
 * @param {unknown} value
 * @returns {unknown}
 */
export function coerceValue(field, value) {
  if (value == null || value === '') return null;
  switch (field.type) {
    case 'text':
      return String(value).trim().slice(0, 2_000);
    case 'url': {
      const s = String(value).trim();
      if (!/^https?:\/\//i.test(s))
        throw new Error(`«${field.name}»: url має починатись з http(s)://`);
      return s.slice(0, 500);
    }
    case 'number':
    case 'money': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`«${field.name}»: очікую скінченне число`);
        return value;
      }
      // Валюта по краях («4,99 USD», «₴129») відкидається, але всередині має
      // лишитись САМЕ число: «1 OR 1» чи «багато» - помилка, а не 11 чи 0.
      const cleaned = String(value)
        .trim()
        .replace(/^[^\d\-+]+/, '')
        .replace(/[^\d.,]+$/, '');
      if (!/^[-+]?\d[\d ]*([.,]\d+)?$/.test(cleaned)) {
        throw new Error(`«${field.name}»: очікую число, не «${String(value)}»`);
      }
      return Number(cleaned.replace(/ /g, '').replace(',', '.'));
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['так', 'true', '1', 'yes', 'є'].includes(s)) return true;
      if (['ні', 'false', '0', 'no', 'нема', 'немає'].includes(s)) return false;
      throw new Error(`«${field.name}»: так/ні, не «${String(value)}»`);
    }
    case 'date': {
      const s = String(value).trim();
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      const ua = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
      const key = iso
        ? `${iso[1]}-${iso[2]}-${iso[3]}`
        : ua
          ? `${ua[3]}-${String(ua[2]).padStart(2, '0')}-${String(ua[1]).padStart(2, '0')}`
          : null;
      // Календарна перевірка: «2026-13-45» проходить регекс, а Date його
      // нормалізує в інший день - тож звіряємо, що дата повертається такою ж.
      const ms = key ? Date.parse(`${key}T00:00:00Z`) : Number.NaN;
      if (!key || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== key) {
        throw new Error(`«${field.name}»: дата як YYYY-MM-DD або DD.MM.YYYY, не «${s}»`);
      }
      return key;
    }
    case 'choice': {
      const s = String(value).trim();
      const options = field.options ?? [];
      const hit = options.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!hit) throw new Error(`«${field.name}»: одне з ${options.join(' · ')}, не «${s}»`);
      return hit;
    }
    default:
      throw new Error(`невідомий тип поля ${field.type}`);
  }
}

/**
 * Дані запису за схемою: невідомі поля - помилка (модель мусить брати імена
 * зі схеми), обовʼязкові - лише при створенні, дефолти - при створенні.
 * @param {FieldDef[]} fields
 * @param {unknown} data
 * @param {{ partial: boolean }} opts
 * @returns {Record<string, unknown>}
 */
export function coerceRecord(fields, data, opts) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('data - обʼєкт полів');
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [rawKey, value] of Object.entries(/** @type {Record<string, unknown>} */ (data))) {
    const field = byName.get(rawKey.trim().toLowerCase());
    if (!field) {
      throw new Error(
        `поля «${rawKey}» у схемі немає (є: ${fields.map((f) => f.name).join(', ')})`,
      );
    }
    out[field.name] = coerceValue(field, value);
  }
  if (!opts.partial) {
    for (const f of fields) {
      if (out[f.name] == null && f.default !== undefined) out[f.name] = f.default;
      if (f.required && out[f.name] == null) throw new Error(`поле «${f.name}» обовʼязкове`);
    }
  }
  return out;
}

// ── Колекції ───────────────────────────────────────────────────────────────

/**
 * Колекція за id або назвою (назва - без урахування регістру).
 * @param {Env} env
 * @param {unknown} ref
 * @returns {Promise<Collection | null>}
 */
export async function findCollection(env, ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  const { results } = await db(env)
    .prepare('SELECT * FROM collections WHERE id = ? OR name = ? LIMIT 1')
    .bind(s, s)
    .all();
  let row = /** @type {any} */ (results?.[0]);
  if (!row) {
    const all = (await db(env).prepare('SELECT * FROM collections').bind().all()).results ?? [];
    row = /** @type {any[]} */ (all).find((r) => String(r.name).toLowerCase() === s.toLowerCase());
  }
  return row ? rowToCollection(row) : null;
}

/** @param {any} row @returns {Collection} */
function rowToCollection(row) {
  /** @type {FieldDef[]} */
  let fields;
  try {
    fields = JSON.parse(String(row.fields_json));
  } catch {
    fields = [];
  }
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ?? null,
    fields,
    sort_by: row.sort_by ?? null,
    created_at: String(row.created_at),
  };
}

/**
 * collections.create (S-N4-1): назва унікальна, схема за 07 §2.
 * @param {Env} env
 * @param {{ name: string, description?: string, fields: unknown, sort_by?: string }} args
 * @param {number} nowMs
 */
export async function runCollectionsCreate(env, args, nowMs) {
  const name = String(args.name ?? '')
    .trim()
    .slice(0, 64);
  if (!name) throw new Error('name не може бути порожнім');
  if (await findCollection(env, name)) throw new Error(`колекція «${name}» уже є`);
  const fields = normalizeFields(args.fields);
  const sortBy = normalizeSortBy(fields, args.sort_by);
  const id = crypto.randomUUID();
  await db(env)
    .prepare(
      `INSERT INTO collections (id, name, description, fields_json, sort_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      name,
      args.description == null ? null : String(args.description).slice(0, 500),
      JSON.stringify(fields),
      sortBy,
      new Date(nowMs).toISOString(),
    )
    .run();
  return { result: { id, name, fields: fields.map((f) => f.name), sort_by: sortBy } };
}

/**
 * collections.update: опис, схема (полностью), сортування. Записи не
 * перевіряються заново: старі значення лишаються як є, нові поля - порожні.
 * @param {Env} env
 * @param {{ collection: unknown, name?: string, description?: string, fields?: unknown, sort_by?: string }} args
 */
export async function runCollectionsUpdate(env, args) {
  const col = await findCollection(env, args.collection);
  if (!col) throw new Error(`колекції «${String(args.collection)}» немає`);
  const next = {
    name: args.name != null ? String(args.name).trim().slice(0, 64) : col.name,
    description:
      args.description !== undefined
        ? args.description == null
          ? null
          : String(args.description).slice(0, 500)
        : col.description,
    fields: args.fields !== undefined ? normalizeFields(args.fields) : col.fields,
    sort_by: col.sort_by,
  };
  if (!next.name) throw new Error('name не може бути порожнім');
  if (next.name !== col.name) {
    const clash = await findCollection(env, next.name);
    if (clash && clash.id !== col.id) throw new Error(`колекція «${next.name}» уже є`);
  }
  // Явний sort_by звіряється; успадкований, чиє поле зникло зі схеми, -
  // просто скидається (зміна схеми не має падати через старе сортування).
  next.sort_by =
    args.sort_by !== undefined
      ? normalizeSortBy(next.fields, args.sort_by)
      : next.fields.some((f) => f.name === col.sort_by)
        ? col.sort_by
        : null;
  await db(env)
    .prepare(
      'UPDATE collections SET name = ?, description = ?, fields_json = ?, sort_by = ? WHERE id = ?',
    )
    .bind(next.name, next.description, JSON.stringify(next.fields), next.sort_by, col.id)
    .run();
  if (next.name !== col.name) await reindexCollection(env, { ...col, name: next.name });
  return {
    result: { id: col.id, name: next.name, fields: next.fields.map((f) => f.name) },
    prev: {
      id: col.id,
      name: col.name,
      description: col.description,
      fields: col.fields,
      sort_by: col.sort_by,
    },
  };
}

/** Відкат update: покласти назад увесь попередній рядок. @param {Env} env @param {any} prev */
export async function restoreCollection(env, prev) {
  await db(env)
    .prepare(
      'UPDATE collections SET name = ?, description = ?, fields_json = ?, sort_by = ? WHERE id = ?',
    )
    .bind(prev.name, prev.description, JSON.stringify(prev.fields), prev.sort_by, prev.id)
    .run();
  const col = await findCollection(env, prev.id);
  if (col) await reindexCollection(env, col);
}

/**
 * collections.list: назви, опис, поля, кількість записів.
 * @param {Env} env
 */
export async function runCollectionsList(env) {
  const { results } = await db(env)
    .prepare(
      `SELECT c.id, c.name, c.description, c.fields_json, c.sort_by,
              (SELECT COUNT(*) FROM records r WHERE r.collection_id = c.id) AS records
       FROM collections c ORDER BY c.name LIMIT ${COLLECTIONS_LIST_MAX}`,
    )
    .bind()
    .all();
  return {
    result: /** @type {any[]} */ (results ?? []).map((r) => {
      const col = rowToCollection(r);
      return {
        id: col.id,
        name: col.name,
        description: col.description,
        fields: col.fields,
        sort_by: col.sort_by,
        records: Number(r.records) || 0,
      };
    }),
  };
}

/**
 * Видалити колекцію з усіма записами (виконавець forget target=collection,
 * T2). Повертає, що саме стерто, - для рядка «Стерто: …».
 * @param {Env} env
 * @param {unknown} ref
 */
export async function deleteCollection(env, ref) {
  const col = await findCollection(env, ref);
  if (!col) throw new Error(`колекції «${String(ref)}» немає`);
  const count = /** @type {any} */ (
    await db(env)
      .prepare('SELECT COUNT(*) AS n FROM records WHERE collection_id = ?')
      .bind(col.id)
      .first()
  );
  await db(env).batch([
    db(env)
      .prepare(
        'DELETE FROM records_fts WHERE id IN (SELECT id FROM records WHERE collection_id = ?)',
      )
      .bind(col.id),
    db(env).prepare('DELETE FROM records WHERE collection_id = ?').bind(col.id),
    db(env).prepare('DELETE FROM collections WHERE id = ?').bind(col.id),
  ]);
  return { name: col.name, records: Number(count?.n) || 0 };
}

// ── Записи ─────────────────────────────────────────────────────────────────

/**
 * records.create (S-N4-2): парсинг у поля за схемою.
 * @param {Env} env
 * @param {{ collection: unknown, data: unknown }} args
 * @param {number} nowMs
 */
export async function runRecordsCreate(env, args, nowMs) {
  const col = await findCollection(env, args.collection);
  if (!col) throw new Error(`колекції «${String(args.collection)}» немає`);
  const data = coerceRecord(col.fields, args.data, { partial: false });
  const id = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(
      'INSERT INTO records (id, collection_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, col.id, JSON.stringify(data), iso, iso)
    .run();
  await ftsReplace(env, id, col.name, data);
  return { result: { id, collection: col.name, data } };
}

/**
 * records.update: часткова правка; знімок ДО правки для «↩».
 * @param {Env} env
 * @param {{ collection: unknown, id: string, data: unknown }} args
 * @param {number} nowMs
 */
export async function runRecordsUpdate(env, args, nowMs) {
  const { col, row } = await findRecord(env, args.collection, args.id);
  const patch = coerceRecord(col.fields, args.data, { partial: true });
  if (Object.keys(patch).length === 0) throw new Error('нічого оновлювати');
  const before = parseData(row.data_json);
  const data = { ...before, ...patch };
  await db(env)
    .prepare('UPDATE records SET data_json = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(data), new Date(nowMs).toISOString(), row.id)
    .run();
  await ftsReplace(env, row.id, col.name, data);
  return { result: { id: row.id, collection: col.name, data }, prev: { id: row.id, data: before } };
}

/** Відкат update: повернути data_json цілком. @param {Env} env @param {{ id: string, data: Record<string, unknown> }} prev @param {number} nowMs */
export async function restoreRecord(env, prev, nowMs) {
  const rec = /** @type {any} */ (
    await db(env)
      .prepare(
        'SELECT r.id, c.name FROM records r JOIN collections c ON c.id = r.collection_id WHERE r.id = ?',
      )
      .bind(prev.id)
      .first()
  );
  if (!rec) throw new Error(`запису ${prev.id} уже немає`);
  await db(env)
    .prepare('UPDATE records SET data_json = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(prev.data), new Date(nowMs).toISOString(), prev.id)
    .run();
  await ftsReplace(env, prev.id, String(rec.name), prev.data);
}

/**
 * records.list (S-N4-3): фільтр компілює ядро; сортування - sort_by колекції
 * або задане поле; ≤ 20 рядків.
 * @param {Env} env
 * @param {{ collection: unknown, where?: unknown, sort?: string, desc?: boolean, limit?: number }} args
 */
export async function runRecordsList(env, args) {
  const col = await findCollection(env, args.collection);
  if (!col) throw new Error(`колекції «${String(args.collection)}» немає`);
  const compiled = compileWhere(col.fields, args.where);
  const sortField = args.sort != null ? normalizeSortBy(col.fields, args.sort) : col.sort_by;
  const limit = Math.min(
    Math.max(Math.trunc(Number(args.limit ?? RECORDS_LIST_MAX)) || RECORDS_LIST_MAX, 1),
    RECORDS_LIST_MAX,
  );
  /** @type {unknown[]} */
  const binds = [col.id, ...compiled.binds];
  let order = 'ORDER BY created_at DESC';
  if (sortField) {
    const f = /** @type {FieldDef} */ (col.fields.find((x) => x.name === sortField));
    order = `ORDER BY ${sortExpr(f)} ${args.desc ? 'DESC' : 'ASC'}, created_at DESC`;
    binds.push(`$.${sortField}`);
  }
  const { results } = await db(env)
    .prepare(
      `SELECT id, data_json, created_at, updated_at FROM records
       WHERE collection_id = ? ${compiled.sql ? `AND ${compiled.sql}` : ''} ${order} LIMIT ${limit + 1}`,
    )
    .bind(...binds)
    .all();
  const rows = /** @type {any[]} */ (results ?? []);
  /** @type {Record<string, unknown>[]} */
  const items = rows
    .slice(0, limit)
    .map((r) => ({ id: r.id, ...parseData(r.data_json), _updated: r.updated_at }));
  return {
    result: {
      collection: col.name,
      fields: col.fields.map((f) => f.name),
      items,
      more: rows.length > limit,
    },
  };
}

/**
 * records.search: FTS по всіх значеннях (опційно в одній колекції).
 * @param {Env} env
 * @param {{ q: string, collection?: unknown }} args
 */
export async function runRecordsSearch(env, args) {
  const match = ftsQuery(args.q);
  if (!match) throw new Error('q має містити хоч одне слово');
  /** @type {unknown[]} */
  const binds = [match];
  let filter = '';
  if (args.collection != null) {
    const col = await findCollection(env, args.collection);
    if (!col) throw new Error(`колекції «${String(args.collection)}» немає`);
    filter = 'AND r.collection_id = ?';
    binds.push(col.id);
  }
  const { results } = await db(env)
    .prepare(
      `SELECT r.id, r.data_json, c.name AS collection FROM records_fts f
       JOIN records r ON r.id = f.id JOIN collections c ON c.id = r.collection_id
       WHERE records_fts MATCH ? ${filter} ORDER BY rank LIMIT ${RECORDS_LIST_MAX}`,
    )
    .bind(...binds)
    .all();
  /** @type {Record<string, unknown>[]} */
  const items = /** @type {any[]} */ (results ?? []).map((r) => ({
    id: r.id,
    collection: r.collection,
    ...parseData(r.data_json),
  }));
  return { result: items };
}

/**
 * records.delete (T1): один запис.
 * @param {Env} env
 * @param {{ collection: unknown, id: string }} args
 */
export async function runRecordsDelete(env, args) {
  const { col, row } = await findRecord(env, args.collection, args.id);
  await db(env).batch([
    db(env).prepare('DELETE FROM records_fts WHERE id = ?').bind(row.id),
    db(env).prepare('DELETE FROM records WHERE id = ?').bind(row.id),
  ]);
  return {
    result: { deleted: true, id: row.id, collection: col.name, data: parseData(row.data_json) },
  };
}

/**
 * Експорт колекції у CSV (S-N4-4, T1; до Sheets на етапі 7): BOM для Excel,
 * поля за схемою, лапки подвоєні.
 * @param {Env} env
 * @param {unknown} ref
 */
export async function exportCollectionCsv(env, ref) {
  const col = await findCollection(env, ref);
  if (!col) throw new Error(`колекції «${String(ref)}» немає`);
  const { results } = await db(env)
    .prepare(
      `SELECT data_json FROM records WHERE collection_id = ? ORDER BY created_at LIMIT ${EXPORT_ROWS_MAX}`,
    )
    .bind(col.id)
    .all();
  const names = col.fields.map((f) => f.name);
  const lines = [names.map(csvCell).join(',')];
  for (const r of /** @type {any[]} */ (results ?? [])) {
    const data = parseData(r.data_json);
    lines.push(names.map((n) => csvCell(data[n])).join(','));
  }
  return {
    filename: `${col.name.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.csv`,
    content: `${CSV_BOM}${lines.join('\r\n')}\r\n`,
    rows: lines.length - 1,
  };
}

// ── Компілятор фільтра ─────────────────────────────────────────────────────

/**
 * where → SQL-фрагмент із біндингами. Імена полів - лише зі схеми (інакше
 * помилка), шлях json_extract - біндингом, значення - біндингами з
 * приведенням до типу поля; числові порівняння через CAST.
 * @param {FieldDef[]} fields
 * @param {unknown} where
 * @returns {{ sql: string, binds: unknown[] }}
 */
export function compileWhere(fields, where) {
  if (where == null) return { sql: '', binds: [] };
  if (!Array.isArray(where)) throw new Error('where - список умов {field, op, value}');
  if (where.length > 8) throw new Error('умов у where не більше 8');
  /** @type {string[]} */
  const parts = [];
  /** @type {unknown[]} */
  const binds = [];
  for (const raw of where) {
    const c = /** @type {{ field?: unknown, op?: unknown, value?: unknown }} */ (raw ?? {});
    const fname = String(c.field ?? '').trim();
    const field = fields.find((f) => f.name.toLowerCase() === fname.toLowerCase());
    if (!field) throw new Error(`поля «${fname}» у схемі немає`);
    const op = String(c.op ?? '=').trim();
    if (!WHERE_OPS.includes(op))
      throw new Error(`оператор «${op}» - один із ${WHERE_OPS.join(' ')}`);
    const path = `$.${field.name}`;
    const numeric = field.type === 'number' || field.type === 'money';
    const expr = numeric
      ? 'CAST(json_extract(data_json, ?) AS REAL)'
      : 'json_extract(data_json, ?)';

    if (op === 'empty' || op === 'not_empty') {
      parts.push(
        op === 'empty'
          ? `(json_extract(data_json, ?) IS NULL OR json_extract(data_json, ?) = '')`
          : `(json_extract(data_json, ?) IS NOT NULL AND json_extract(data_json, ?) != '')`,
      );
      binds.push(path, path);
      continue;
    }
    if (op === 'contains') {
      parts.push(`json_extract(data_json, ?) LIKE ? ESCAPE '\\'`);
      binds.push(path, `%${escapeLike(String(c.value ?? ''))}%`);
      continue;
    }
    if (op === 'in') {
      const values = Array.isArray(c.value) ? c.value : [c.value];
      if (values.length === 0 || values.length > 20) throw new Error('in: від 1 до 20 значень');
      parts.push(`${expr} IN (${values.map(() => '?').join(', ')})`);
      binds.push(path, ...values.map((v) => sqlValue(field, v)));
      continue;
    }
    parts.push(`${expr} ${op} ?`);
    binds.push(path, sqlValue(field, c.value));
  }
  return { sql: parts.join(' AND '), binds };
}

/** Значення для порівняння в SQL: bool → 1/0, решта - як coerceValue.
 *  @param {FieldDef} field @param {unknown} v */
function sqlValue(field, v) {
  const coerced = coerceValue(field, v);
  if (coerced == null) throw new Error(`«${field.name}»: значення для порівняння порожнє`);
  if (typeof coerced === 'boolean') return coerced ? 1 : 0;
  return coerced;
}

/** @param {FieldDef} f */
function sortExpr(f) {
  return f.type === 'number' || f.type === 'money'
    ? 'CAST(json_extract(data_json, ?) AS REAL)'
    : 'json_extract(data_json, ?)';
}

/** @param {string} s */
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ── Внутрішнє ──────────────────────────────────────────────────────────────

/** @param {Env} env @param {unknown} colRef @param {unknown} id */
async function findRecord(env, colRef, id) {
  const col = await findCollection(env, colRef);
  if (!col) throw new Error(`колекції «${String(colRef)}» немає`);
  const row = /** @type {any} */ (
    await db(env)
      .prepare('SELECT id, data_json FROM records WHERE id = ? AND collection_id = ?')
      .bind(String(id ?? ''), col.id)
      .first()
  );
  if (!row) throw new Error(`запису «${String(id)}» у «${col.name}» немає`);
  return { col, row };
}

/** @param {FieldDef[]} fields @param {unknown} raw */
function normalizeSortBy(fields, raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const f = fields.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (!f) throw new Error(`sort_by «${s}» - не поле схеми`);
  return f.name;
}

/** @param {string} raw @returns {Record<string, unknown>} */
function parseData(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** @param {Env} env @param {string} id @param {string} collectionName @param {Record<string, unknown>} data */
async function ftsReplace(env, id, collectionName, data) {
  const text = [collectionName, ...Object.values(data).map((v) => (v == null ? '' : String(v)))]
    .filter(Boolean)
    .join(' ');
  await db(env).batch([
    db(env).prepare('DELETE FROM records_fts WHERE id = ?').bind(id),
    db(env).prepare('INSERT INTO records_fts (id, data_text) VALUES (?, ?)').bind(id, text),
  ]);
}

/** Перебудувати FTS усіх записів колекції (після перейменування). @param {Env} env @param {Collection} col */
async function reindexCollection(env, col) {
  const { results } = await db(env)
    .prepare('SELECT id, data_json FROM records WHERE collection_id = ?')
    .bind(col.id)
    .all();
  for (const r of /** @type {any[]} */ (results ?? [])) {
    await ftsReplace(env, String(r.id), col.name, parseData(String(r.data_json)));
  }
}

/** @param {unknown} v */
function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'boolean' ? (v ? 'так' : 'ні') : String(v);
  // Клітинка, що починається з = + - @ (і табуляції/CR перед ними), в Excel -
  // формула: дані йдуть у чужий інтерпретатор, тож екрануємо апострофом.
  if (/^[\t\r]*[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
