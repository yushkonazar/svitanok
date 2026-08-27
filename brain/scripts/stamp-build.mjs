// @ts-check
// Штамп збірки: dist/build-info.json = {version, gitSha, builtAt}.
//
// /health віддає gitSha З ЦЬОГО ФАЙЛУ, а deploy-host.yml грепає в ньому щойно
// задеплоєний коміт (контракт 07 §3: ПОВНИЙ 40-hex sha). Штампуємо на збірці,
// бо тільки тут поруч і git-checkout, і майбутній dist: рантайм git не кличе.
// Немає git-репо чи dist/ - гучний провал збірки, не мовчазний "unknown".

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const brainDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = path.join(brainDir, 'dist');

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
console.log(`stamp-build: ${pkg.version} ${gitSha}`);
