import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/* Механічний інваріант модулів Worker'а (Фаза 5).
 *
 * ПРИЧИНА. Під час модуляризації двічі трапилась та сама помилка: іменований
 * імпорт із НЕ ТОГО модуля (`buildAgendaCallbackData` з reminders-core замість
 * calendar-core; `addDaysToDateKey` з calendar-core замість reminders-core).
 * ESLint такого не бачить — синтаксис валідний, `no-undef` задоволений, — і
 * значення просто стає `undefined`. Помилка вилазить аж у рантаймі, у момент
 * виклику: «X is not a function» усередині обробки апдейту.
 *
 * Обидва рази врятували інтеграційні тести, але це щастя, а не метод: імпорт у
 * рідкісній гілці (крон раз на добу, гілка помилки) так само тихо доїхав би до
 * прода. Тому тут — пряма звірка: КОЖЕН іменований імпорт між нашими модулями
 * мусить існувати серед експортів цільового модуля.
 *
 * Зовнішні/вбудовані модулі (`cloudflare:workers`, `node:*`) не перевіряємо —
 * їх резолвить рантайм, а не ми. */

const WEB_DIR = new URL('../web/', import.meta.url);

/** Файли Worker'а верхнього рівня (без web/app — то окремий пакет React). */
const moduleFiles = readdirSync(WEB_DIR)
  .filter((f) => f.endsWith('.mjs') || f === 'worker.js')
  .sort();

/** `import { a, b as c } from './x.mjs'` -> [{from, names}] (лише відносні шляхи). */
function parseNamedImports(src: string): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const names = m[1]!
      .split(',')
      .map((raw) =>
        raw
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter(Boolean);
    out.push({ from: m[2]!, names });
  }
  return out;
}

describe('імпорти між модулями Worker’а', () => {
  it('знайдено всі модулі (зріз не зʼїхав)', () => {
    expect(moduleFiles.length).toBeGreaterThan(10);
    expect(moduleFiles).toContain('worker.js');
  });

  it('КОЖЕН іменований імпорт існує серед експортів цільового модуля', async () => {
    const problems: string[] = [];

    for (const file of moduleFiles) {
      const src = readFileSync(new URL(file, WEB_DIR), 'utf8');
      for (const { from, names } of parseNamedImports(src)) {
        const target = await import(new URL(from, WEB_DIR).href);
        const exported = new Set(Object.keys(target));
        for (const name of names) {
          if (!exported.has(name)) problems.push(`${file}: '${name}' немає в ${from}`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
