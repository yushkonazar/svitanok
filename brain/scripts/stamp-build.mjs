// @ts-check
// Штамп збірки: dist/build-info.json = {version, gitSha, builtAt}.
//
// /health віддає gitSha З ЦЬОГО ФАЙЛУ, а deploy-host.yml грепає в ньому щойно
// задеплоєний коміт (контракт 07 §3: ПОВНИЙ 40-hex sha). Штампуємо на збірці,
// бо тільки тут поруч і git-checkout, і майбутній dist: рантайм git не кличе.
// Немає git-репо чи dist/ - гучний провал збірки, не мовчазний "unknown".

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const brainDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.resolve(brainDir, '..');
const distDir = path.join(brainDir, 'dist');

/** Stable digest of source files that must be compatible with this brain build.
 * Paths join the bytes so renaming a contract is a meaningful release change. */
function digestFiles(root, files) {
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(path.join(root, ...file.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

if (!existsSync(distDir)) {
  console.error('stamp-build: немає dist/ - спершу tsc -p tsconfig.build.json');
  process.exit(1);
}

const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: brainDir,
  encoding: 'utf8',
}).trim();
if (!/^[0-9a-f]{40}$/.test(gitSha)) {
  console.error(`stamp-build: git rev-parse дав не 40-hex sha: "${gitSha}"`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(brainDir, 'package.json'), 'utf8'));
const info = { version: pkg.version, gitSha, builtAt: new Date().toISOString() };
writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify(info) + '\n');
const migrationsDir = path.join(repoDir, 'web', 'core', 'migrations');
const migrations = readdirSync(migrationsDir)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .map((file) => {
    const source = readFileSync(path.join(migrationsDir, file), 'utf8');
    const phase = source.match(/^-- release-phase: (expand|contract)$/m)?.[1];
    if (!phase) throw new Error(`stamp-build: ${file} has no release-phase header`);
    return { path: `web/core/migrations/${file}`, phase };
  });
const migrationFiles = migrations.map((migration) => migration.path);
const instructionDir = path.join(repoDir, 'docs', 'assistant');
const instructionFiles = readdirSync(instructionDir, { recursive: true })
  .filter((file) => typeof file === 'string' && file.endsWith('.md'))
  .map((file) => `docs/assistant/${file.replaceAll('\\', '/')}`);
const workerFiles = readdirSync(path.join(repoDir, 'web'), { recursive: true })
  .filter(
    (file) =>
      typeof file === 'string' &&
      !file.startsWith(`app${path.sep}`) &&
      !file.startsWith(`public${path.sep}`) &&
      (/\.(?:mjs|js)$/u.test(file) || file.endsWith('.d.ts') || file === 'wrangler.jsonc'),
  )
  .map((file) => `web/${file.replaceAll('\\', '/')}`);

// Release manifest is deliberately source-derived and lives beside the binary.
// It does not claim a migration was applied; it gives deploy/smoke tooling a
// verifiable compatibility set. New migrations are expand-only by default;
// destructive contract work requires a separate release plan after a soak.
const manifest = {
  schema: 1,
  release: info,
  compatibility: {
    d1: {
      phases: [...new Set(migrations.map((migration) => migration.phase))],
      migrations,
      digest: digestFiles(repoDir, migrationFiles),
    },
    worker: {
      sourceDigest: digestFiles(repoDir, workerFiles),
      wranglerDigest: digestFiles(repoDir, ['web/wrangler.jsonc']),
      toolSchemaDigest: digestFiles(repoDir, ['brain/src/tools/schemas.ts']),
    },
    instructions: { digest: digestFiles(repoDir, instructionFiles) },
  },
};
writeFileSync(
  path.join(distDir, 'release-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(`stamp-build: ${pkg.version} ${gitSha}`);
