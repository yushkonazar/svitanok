#!/usr/bin/env node
// Відновлення з бекапу (05-ops §«Бекапи», етап 3 PR-6).
//
//   node scripts/restore.mjs --file <svitanok-YYYY-MM-DD.enc> --dry-run
//   node scripts/restore.mjs --file <…enc> --local            (локальна D1)
//   node scripts/restore.mjs --file <…enc> --remote --apply   (бойова D1)
//
// Ключ - BACKUP_ENC_KEY зі змінної середовища (той самий рядок, що в
// Cloudflare Secrets; у ключ AES його перетворює SHA-256 - як у Worker).
// --dry-run друкує, що зміниться (таблиці, рядки, ключі KV), нічого не
// пишучи. Без --dry-run скрипт збирає SQL (одна транзакція: DELETE + INSERT
// по таблицях, FTS перебудовується) у .workspace/tmp/restore-<дата>.sql і
// виконує `wrangler d1 execute` - у локальну D1 (--local) або, лише з
// явним --apply, у бойову (--remote). KV не пишеться автоматично: ключі
// лягають поруч у restore-<дата>-kv.json, а KV-put - окреме рішення
// власника (у KV живуть stats/state, які пишуть і Mini App, і крони).
//
// Мовчазний запуск не має нічого міняти: без --dry-run і без --local/--apply
// скрипт зупиняється з підказкою.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decryptBackup, restoreSql, summarizeBackup } from '../web/core/backup/core.mjs';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ file: string | null, dryRun: boolean, local: boolean, remote: boolean, apply: boolean }} */
  const out = { file: null, dryRun: false, local: false, remote: false, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') out.file = argv[i + 1] ?? null;
    if (a === '--dry-run') out.dryRun = true;
    if (a === '--local') out.local = true;
    if (a === '--remote') out.remote = true;
    if (a === '--apply') out.apply = true;
  }
  return out;
}

/**
 * Головна процедура - чиста щодо аргументів, щоб тест міг прогнати dry-run
 * без wrangler. `exec` - точка підміни (spawn wrangler).
 * @param {ReturnType<typeof parseArgs>} args
 * @param {{ secret: string | undefined, outDir: string, exec?: (cmd: string[]) => number, log?: (s: string) => void }} deps
 */
export async function restore(args, deps) {
  const log = deps.log ?? console.log;
  if (!args.file) throw new Error('потрібен --file <шлях до .enc>');
  if (!deps.secret) throw new Error('BACKUP_ENC_KEY не задано в середовищі');
  const bytes = new Uint8Array(readFileSync(args.file));
  const doc = await decryptBackup(deps.secret, bytes);
  const summary = summarizeBackup(doc);
  log(
    `Бекап від ${doc.created_at} (env=${doc.env}): таблиць ${summary.tables}, рядків ${summary.rows}, ключів KV ${summary.kvKeys}`,
  );
  log(`Непорожні: ${summary.nonEmpty.join(', ') || '(нічого)'}`);
  log(`KV: ${Object.keys(doc.kv).join(', ') || '(нічого)'}`);

  if (args.dryRun) {
    log('--dry-run: нічого не змінено.');
    return { mode: 'dry-run', summary };
  }
  if (!args.local && !(args.remote && args.apply)) {
    throw new Error('без --dry-run потрібен --local або --remote --apply');
  }
  mkdirSync(deps.outDir, { recursive: true });
  const stamp = doc.created_at.slice(0, 10);
  const sqlPath = join(deps.outDir, `restore-${stamp}.sql`);
  const kvPath = join(deps.outDir, `restore-${stamp}-kv.json`);
  writeFileSync(sqlPath, restoreSql(doc), 'utf8');
  writeFileSync(kvPath, JSON.stringify(doc.kv, null, 2), 'utf8');
  log(`SQL: ${sqlPath}\nKV (вручну): ${kvPath}`);

  const target = args.local ? '--local' : '--remote';
  // Без shell: аргументи йдуть масивом (шлях до SQL - наш, але звичка
  // важливіша); на Windows npx - це npx.cmd.
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const cmd = [
    npx,
    'wrangler',
    'd1',
    'execute',
    'svitanok',
    target,
    '--config',
    'web/wrangler.jsonc',
    '--file',
    sqlPath,
  ];
  const exec =
    deps.exec ??
    ((c) => {
      const r = spawnSync(c[0] ?? '', c.slice(1), { stdio: 'inherit' });
      return r.status ?? 1;
    });
  log(`Виконую: ${cmd.join(' ')}`);
  const code = exec(cmd);
  if (code !== 0) throw new Error(`wrangler d1 execute завершився з кодом ${code}`);
  log(`Відновлено в ${args.local ? 'локальну' : 'БОЙОВУ'} D1. KV - за файлом ${kvPath}.`);
  return { mode: target, summary, sqlPath, kvPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  restore(parseArgs(process.argv.slice(2)), {
    secret: process.env.BACKUP_ENC_KEY,
    outDir: join(process.cwd(), '.workspace', 'tmp'),
  }).catch((e) => {
    console.error(`restore: ${e?.message ?? e}`);
    process.exit(1);
  });
}
