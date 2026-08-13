import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

/* ⚠️ ГРАБЛІ, ЩО ВКУСИЛИ ВДРУГЕ.
 *
 * Кореневі тести покривають чисту логіку з `web/app/src` — це навмисно: без
 * DOM воно швидше, і місце йому в кореневому раннері. Але корінь і web/app
 * мають ОКРЕМІ node_modules, і кореневий `npm ci` не ставить залежностей
 * дашборда. Тож щойно такий модуль імпортує пакет, якого в корені немає,
 * кореневий `tsc` падає — і падає ЛИШЕ В CI.
 *
 * Локально це невидимо: тека web/app/node_modules уже існує, резолвер її
 * знаходить, усе зелене. Перший раз так сталося з d3 (тест довелось переносити
 * у harness), другий — з react у svgButton.ts.
 *
 * Тест іде транзитивно за відносними імпортами від кожного кореневого тесту й
 * перевіряє КОЖЕН пакетний імпорт на резолвність із кореня. Це дешевша й
 * надійніша відповідь, ніж памʼятати правило. */

const ROOT = resolve(__dirname, '..');
const requireFromRoot = createRequire(join(ROOT, 'package.json'));

/** Пакетні імпорти (не відносні, не рантаймові) і відносні шляхи з файлу. */
function parseImports(file: string): { bare: string[]; rel: string[] } {
  const src = readFileSync(file, 'utf8');
  const bare: string[] = [];
  const rel: string[] = [];
  // Дві форми: `… from 'x'` і побічний `import 'x'` (без from). Друга рідкісна,
  // але лишати її поза увагою означало б дірку саме там, куди найлегше
  // випадково покласти залежність — «просто підключити стилі/поліфіл».
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  ];
  for (const m of patterns.flatMap((re) => [...src.matchAll(re)])) {
    const spec = m[1]!;
    if (spec.startsWith('.')) rel.push(spec);
    // Специфікатори зі схемою (node:, cloudflare:, bun:) дає РАНТАЙМ, а не
    // npm — з кореня вони не резолвляться за визначенням і резолвитись не
    // мусять. `cloudflare:workers` у vitest підміняється заглушкою
    // (vitest.config.ts alias -> tests/stubs), саме тому воркер узагалі
    // імпортується в Node.
    else if (!/^[a-z][a-z0-9.+-]*:/.test(spec)) bare.push(spec);
  }
  return { bare, rel };
}

/** Транзитивне замикання за ВІДНОСНИМИ імпортами. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let parsed;
    try {
      parsed = parseImports(file);
    } catch {
      continue; // не файл або не читається — не наша справа
    }
    for (const r of parsed.rel) {
      // Кодова база пише розширення явно (.ts/.mjs) — вгадувати не треба.
      queue.push(resolve(dirname(file), r));
    }
  }
  return seen;
}

const rootTests = readdirSync(join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(ROOT, 'tests', f));

describe('кореневі тести не тягнуть залежностей, яких у корені немає', () => {
  it('знайшов кореневі тести (інакше тест був би порожньою обіцянкою)', () => {
    expect(rootTests.length).toBeGreaterThan(10);
  });

  it.each(rootTests.map((f) => [f.split(/[\\/]/).pop()!, f]))(
    '%s — кожен пакетний імпорт резолвиться з кореня',
    (_name, file) => {
      const missing: string[] = [];
      for (const f of closure(file)) {
        let bare: string[];
        try {
          bare = parseImports(f).bare;
        } catch {
          continue;
        }
        for (const pkg of bare) {
          try {
            requireFromRoot.resolve(pkg);
          } catch {
            missing.push(`${pkg} (з ${f.replace(ROOT, '.')})`);
          }
        }
      }
      // Порожній масив читабельніший за toBe(0): у падінні одразу видно, ЩО саме.
      expect(missing).toEqual([]);
    },
  );
});
