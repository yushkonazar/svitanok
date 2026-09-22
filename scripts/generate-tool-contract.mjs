// Генерований публічний контракт інструментів. Джерело істини — реєстр ядра;
// функції виконання навмисно не потрапляють у документацію чи модельний контракт.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { TOOLS } from '../web/core/tools/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const contractPath = resolve(root, 'docs/generated/tool-contract.json');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

/** @returns {{ contract_version: 1, tools: Record<string, unknown> }} */
export function buildToolContract() {
  return {
    contract_version: 1,
    tools: Object.fromEntries(
      Object.entries(TOOLS)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, definition]) => [
          name,
          {
            args: stable(definition.args),
            tainting:
              definition.tainting === true
                ? 'always'
                : typeof definition.tainting === 'function'
                  ? 'conditional'
                  : 'never',
            execution: definition.write
              ? { route: 'policy', ...stable(definition.write) }
              : { route: 'core' },
          },
        ]),
    ),
  };
}

export async function renderToolContract() {
  return format(JSON.stringify(buildToolContract()), { parser: 'json' });
}

async function main() {
  const expected = await renderToolContract();
  if (process.argv.includes('--write')) {
    await mkdir(dirname(contractPath), { recursive: true });
    await writeFile(contractPath, expected, 'utf8');
    return;
  }

  const actual = await readFile(contractPath, 'utf8').catch(() => '');
  if (actual !== expected) {
    throw new Error(
      'docs/generated/tool-contract.json is stale. Run npm run contract:tools:write.',
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
