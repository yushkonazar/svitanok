#!/usr/bin/env node
// Non-destructive restore evidence: decrypt one backup, restore it into a
// freshly migrated in-memory SQLite database, then compare every backed-up
// row semantically. It never calls Wrangler or writes a Cloudflare resource.
//
//   BACKUP_ENC_KEY=... node scripts/restore-drill.mjs --file backup.enc

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BACKUP_FTS,
  BACKUP_TABLES,
  decryptBackup,
  restoreSql,
  summarizeBackup,
} from '../web/core/backup/core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'web', 'core', 'migrations');

/** @param {string[]} argv */
export function parseArgs(argv) {
  const index = argv.indexOf('--file');
  return { file: index >= 0 ? (argv[index + 1] ?? null) : null };
}

/** @param {Record<string, unknown>} row */
function stableRow(row) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(row)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value ?? null]),
    ),
  );
}

/** @param {Record<string, unknown>[]} rows */
function stableRows(rows) {
  return rows.map(stableRow).sort();
}

/** @param {string[]} columns @param {Record<string, unknown>} actual */
function projectRow(columns, actual) {
  return Object.fromEntries(columns.map((key) => [key, actual[key] ?? null]));
}

/** @param {import('../web/core/backup/core.mjs').BackupDocument} doc */
function expectedTables(doc) {
  const tables = /** @type {Record<string, Record<string, unknown>[]>} */ ({});
  for (const table of BACKUP_TABLES) tables[table] = [...(doc.d1[table] ?? [])];
  // Older backups can lack the counter introduced later. restoreSql deliberately
  // recreates it so the first post-restore idea write is safe.
  if (!tables.counters.some((row) => row.name === 'ideas')) {
    const numbers = tables.ideas
      .map((row) => Number(row.number))
      .filter((number) => Number.isFinite(number));
    tables.counters.push({ name: 'ideas', value: Math.max(0, ...numbers) });
  }
  return tables;
}

/**
 * @param {{file: string|null}} args
 * @param {{secret: string|undefined, log?: (line: string) => void}} deps
 */
export async function restoreDrill(args, deps) {
  if (!args.file) throw new Error('потрібен --file <шлях до .enc>');
  if (!deps.secret) throw new Error('BACKUP_ENC_KEY не задано в середовищі');
  const doc = await decryptBackup(deps.secret, new Uint8Array(readFileSync(args.file)));
  const db = new DatabaseSync(':memory:');
  try {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const migration of migrations)
      db.exec(readFileSync(join(MIGRATIONS_DIR, migration), 'utf8'));
    db.exec(restoreSql(doc));

    const expected = expectedTables(doc);
    for (const table of BACKUP_TABLES) {
      const actual = /** @type {Record<string, unknown>[]} */ (
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      );
      const wanted = expected[table] ?? [];
      if (actual.length !== wanted.length) {
        throw new Error(
          `restore drill: ${table}: очікується ${wanted.length} рядків, є ${actual.length}`,
        );
      }
      const columns = [...new Set(wanted.flatMap((row) => Object.keys(row)))].sort();
      const projected = actual.map((row) => projectRow(columns, row));
      const expectedRows = wanted.map((row) => projectRow(columns, row));
      if (JSON.stringify(stableRows(projected)) !== JSON.stringify(stableRows(expectedRows))) {
        throw new Error(`restore drill: ${table}: дані після відновлення відрізняються`);
      }
    }
    for (const [fts, spec] of Object.entries(BACKUP_FTS)) {
      const actual = /** @type {{count: number}|undefined} */ (
        db.prepare(`SELECT COUNT(*) AS count FROM ${fts}`).get()
      );
      const expectedCount = (doc.d1[spec.from] ?? []).length;
      if (Number(actual?.count ?? 0) !== expectedCount) {
        throw new Error(`restore drill: ${fts}: FTS не відповідає ${spec.from}`);
      }
    }
    const summary = summarizeBackup(doc);
    (deps.log ?? console.log)(
      `restore drill: чисте відновлення успішне; таблиць ${summary.tables}, рядків ${summary.rows}, ключів KV ${summary.kvKeys}`,
    );
    return { summary, migrations: migrations.length, verifiedTables: BACKUP_TABLES.length };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  restoreDrill(parseArgs(process.argv.slice(2)), {
    secret: process.env.BACKUP_ENC_KEY,
  }).catch((error) => {
    console.error(`restore drill: ${error?.message ?? error}`);
    process.exit(1);
  });
}
