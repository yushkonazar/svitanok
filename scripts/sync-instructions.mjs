// Синк інструкцій docs/assistant/** → D1 `instructions` (01 §3.10, ADR-016).
// Запускає sync-instructions.yml після push у main; локально - з --dry-run.
//
// Чому REST API, а не `wrangler d1 execute`: тіло інструкції - довільний
// markdown із лапками, апострофами й переносами, і склеювати з нього SQL
// означало б екранувати текст руками. D1 REST приймає params окремо від sql -
// дані не змішуються з кодом (те саме правило, що для D1-біндингу в ядрі).
//
// Ідемпотентний: рядок пишеться, лише коли хеш ТІЛА змінився; історія
// (instruction_history) отримує запис тією ж транзакцією - у batch.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseInstruction,
  validateInstruction,
  instructionHash,
} from '../web/core/instructions.mjs';

const DOCS = 'docs/assistant';
const API = 'https://api.cloudflare.com/client/v4';

/**
 * Id бази - з wrangler.jsonc, не з env workflow: два місця для одного
 * значення означають розсинхрон при першій же зміні бази. Регекс, а не
 * JSON.parse, бо файл - JSONC (коментарі + висячі коми), а вирізати «//»
 * наївно не можна: у ньому є URL зі слешами.
 */
export function readDatabaseId(raw) {
  const m = /"database_id"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(raw);
  if (!m) throw new Error('не знайшов database_id у web/wrangler.jsonc');
  return /** @type {string} */ (m[1]);
}

/** @param {string} dir */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return entry.endsWith('.md') && entry !== 'README.md' ? [full] : [];
  });
}

/**
 * Один запит до D1 REST. Кидає з ПРИЧИНОЮ - мовчазний збій синку означав би
 * прод на старій персоні без жодного сліду.
 * @param {{ accountId: string, dbId: string, token: string }} cf
 * @param {{ sql: string, params?: unknown[] }[]} statements
 */
async function d1Query(cf, statements) {
  const res = await fetch(`${API}/accounts/${cf.accountId}/d1/database/${cf.dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cf.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(statements.length === 1 ? statements[0] : { batch: statements }),
  });
  const body = /** @type {any} */ (await res.json().catch(() => null));
  if (!res.ok || !body?.success) {
    const why =
      body?.errors?.map((/** @type {any} */ e) => e.message).join('; ') ?? `HTTP ${res.status}`;
    throw new Error(`D1 API: ${why}`);
  }
  return body.result;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cf = {
    accountId: (process.env.CF_ACCOUNT_ID ?? '').trim(),
    dbId: readDatabaseId(readFileSync('web/wrangler.jsonc', 'utf8')),
    token: (process.env.CF_API_TOKEN ?? '').trim(),
  };
  if (!dryRun && (!cf.accountId || !cf.token)) {
    throw new Error('бракує CF_ACCOUNT_ID / CF_API_TOKEN');
  }

  const files = walk(DOCS).map((full) => ({
    path: relative(DOCS, full).replaceAll('\\', '/'),
    raw: readFileSync(full, 'utf8'),
  }));
  if (files.length === 0) throw new Error(`у ${DOCS} немає інструкцій`);

  // Валідація ПЕРЕД будь-яким записом: у D1 не має потрапити те, що не
  // проходить CI-тест, навіть якщо синк запустили вручну.
  const problems = files.flatMap((f) => validateInstruction(f));
  if (problems.length > 0) {
    throw new Error(`інструкції не пройшли перевірку:\n  ${problems.join('\n  ')}`);
  }

  /** @type {{ name: string, kind: string, body: string, hash: string, maxChars: number }[]} */
  const parsed = [];
  for (const f of files) {
    const p = parseInstruction(f.raw);
    if (!p.ok) throw new Error(`${f.path}: ${p.error}`);
    parsed.push({
      name: String(p.front.name),
      kind: String(p.front.kind),
      body: p.body,
      hash: await instructionHash(p.body),
      maxChars: Number(p.front.max_chars),
    });
  }

  if (dryRun) {
    for (const i of parsed) {
      console.log(
        `${i.name.padEnd(20)} ${i.kind.padEnd(10)} ${String(i.body.length).padStart(6)} симв.  ${i.hash.slice(0, 12)}`,
      );
    }
    console.log(`\n${parsed.length} інструкцій готові до синку (dry-run, нічого не записано)`);
    return;
  }

  const existing = new Map();
  for (const row of (await d1Query(cf, [{ sql: 'SELECT name, version_hash FROM instructions' }]))[0]
    ?.results ?? []) {
    existing.set(row.name, row.version_hash);
  }

  const at = new Date().toISOString();
  let written = 0;
  for (const i of parsed) {
    if (existing.get(i.name) === i.hash) continue;
    await d1Query(cf, [
      {
        sql: `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (name) DO UPDATE SET
                kind = excluded.kind, version_hash = excluded.version_hash,
                body_md = excluded.body_md, max_chars = excluded.max_chars,
                deployed_at = excluded.deployed_at`,
        // ⚠️ params D1 REST - масив РЯДКІВ (VERIFIED у схемі API): число тут
        // валить запит валідацією тіла, і в D1 не потрапляє жодна інструкція.
        params: [i.name, i.kind, i.hash, i.body, String(i.maxChars), at],
      },
      {
        sql: `INSERT INTO instruction_history (name, version_hash, body_md, deployed_at)
              VALUES (?, ?, ?, ?)`,
        params: [i.name, i.hash, i.body, at],
      },
    ]);
    written += 1;
    console.log(`оновлено: ${i.name} (${i.hash.slice(0, 12)})`);
  }

  // Парність ПІСЛЯ запису - те, що 01 §3.10 називає тестом парності. Читаємо
  // ТІЛА, а не хеші: звірка хеша з хешем не помітила б пошкодженого тіла при
  // цілому version_hash, а саме таке пошкодження ламає кожен прогін chat -
  // рантайм ядра рахує sha256(body_md) і не визнає рядок (ревʼю PR-5).
  const after = new Map();
  for (const row of (await d1Query(cf, [{ sql: 'SELECT name, body_md FROM instructions' }]))[0]
    ?.results ?? []) {
    after.set(row.name, await instructionHash(String(row.body_md ?? '')));
  }
  const mismatched = parsed.filter((i) => after.get(i.name) !== i.hash);
  if (mismatched.length > 0) {
    throw new Error(`після синку розійшлись: ${mismatched.map((i) => i.name).join(', ')}`);
  }
  const orphans = [...after.keys()].filter((name) => !parsed.some((i) => i.name === name));
  if (orphans.length > 0) {
    console.log(`⚠️ у D1 є інструкції без файлу в репо: ${orphans.join(', ')}`);
  }

  console.log(
    `\nсинк завершено: ${written} оновлено, ${parsed.length - written} без змін, парність ${parsed.length}/${parsed.length}`,
  );
}

// Лише прямий запуск: тест імпортує readDatabaseId, і main() тут стартував би
// синк просто від імпорту.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
