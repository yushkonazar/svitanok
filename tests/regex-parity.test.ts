import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/* M2 — три копії USAGE_LIMIT_RE звіряються ДЖЕРЕЛОМ, а не лише поведінкою.
 *
 * Дублювання тут свідоме й лишається: `src/`, `host/` і `web/` — це ТРИ різні
 * деплої, які не шарять код за побудовою, і Worker мусить упізнати ліміт навіть
 * у сирому тексті, який прокидає СТАРІШИЙ хост. Витягати спільний модуль
 * означало б звʼязати те, що навмисно розвʼязане.
 *
 * Що вже було: спільний фікстур-набір (`usage-limit-fixtures.ts`) і паритетні
 * прогони в кожному з трьох *.test.ts. Чого бракувало: фікстури ловлять
 * розбіжність ЛИШЕ там, куди дотягується приклад. Копія, що відрослa новою
 * гілкою патерну (або втратила стару, як уже одного разу сталось), лишалася б
 * зеленою, доки хтось не додасть саме той текст.
 *
 * Тому тут звіряються самі ЛІТЕРАЛИ. Тест механічний і навмисно тупий: він не
 * знає, що патерн означає, — лише що всі три написані однаково.
 */

/** Витягти літерал `const NAME = /.../флаги;` (можливо з переносом рядка). */
function regexLiteral(file: string, name: string): string {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const m = new RegExp(`const ${name} =\\s*(/.*?/[a-z]*);`, 's').exec(src);
  if (!m) throw new Error(`${file}: не знайдено літерал ${name}`);
  return m[1]!;
}

describe('M2 — паритет дубльованих регулярок', () => {
  it('USAGE_LIMIT_RE однаковий у двох legacy Claude-деплоях', () => {
    const files = ['host/llm-host-core.mjs', 'web/agent-core.mjs'];
    const [first, ...rest] = files.map((f) => regexLiteral(f, 'USAGE_LIMIT_RE'));
    for (const [i, literal] of rest.entries()) {
      expect(literal, `${files[i + 1]} розійшовся з ${files[0]}`).toBe(first);
    }
  });

  it('RESET_EPOCH_RE однаковий у host і web', () => {
    // Ця пара живе лише у двох місцях: оркестратор час скидання не показує.
    const files = ['host/llm-host-core.mjs', 'web/agent-core.mjs'];
    const [a, b] = files.map((f) => regexLiteral(f, 'RESET_EPOCH_RE'));
    expect(b, `${files[1]} розійшовся з ${files[0]}`).toBe(a);
  });

  it('сам витягувач працює — інакше тест був би зелений на будь-чому', () => {
    // Гард проти найтихішого провалу: regexLiteral, що завжди віддає одне й те
    // саме (напр. порожній рядок), зробив би перевірки вище декоративними.
    expect(regexLiteral('web/agent-core.mjs', 'USAGE_LIMIT_RE')).toContain('usage limit reached');
    expect(() => regexLiteral('web/agent-core.mjs', 'НЕМА_ТАКОЇ')).toThrow(/не знайдено/);
  });
});
