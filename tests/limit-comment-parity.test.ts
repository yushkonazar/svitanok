import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MAX_PROMPT_LEN, MAX_SYSTEM_PROMPT_LEN, MAX_SCHEMA_LEN } from '../host/llm-host-core.mjs';
import { walkFiles } from './helpers/repo-files.js';

/* Число межі має жити в одному місці — коментар називає константу, не цифру.
 *
 * ⚠️ ПРИВІД. 11.08.2026 ліміти хоста підняли (2000/3000/6000 -> 4000/5000/24000),
 * але сім коментарів у web/ лишились зі старими числами, причому різними для
 * однієї константи: MAX_PROMPT_LEN зустрічався і як 4000, і як 6000. Читач вірив
 * копії, а не оригіналу: у роадмепі так і лишилось записано «системний промпт
 * обмежений 3000» — тобто вигаданий блокер пережив своє скасування на 11 днів.
 *
 * Тихо тому, що код був ПРАВИЛЬНИЙ: межі імпортуються з host/llm-host-core.mjs,
 * тести звіряються з нею ж, продакшн працює. Протухає лише проза, а її ніщо не
 * виконує.
 *
 * Тест забороняє сам ФОРМАТ `MAX_X = 1234` усюди, крім оголошення самої
 * константи: копії числа не існує -> нічому протухати. Історичну довідку писати
 * абсолютом («тодішні 2000»), а не відносно чинного значення — «удвічі менша»
 * протухає так само тихо, тільки ще й непомітно для цього тесту.
 */

const ROOT = join(__dirname, '..');

/** Де шукати. Це весь код, що деплоїться (див. coverage.include у
 *  vitest.config.ts), плюс дашборд — стара версія тесту дивилась лише на
 *  web/*.mjs і не побачила б ту саму копію в src/ чи web/app/src/. */
const DIRS = ['web', 'host', 'src'];
const EXTS = ['.mjs', '.js', '.ts', '.tsx'];

/** Константи з єдиним джерелом правди — саме їх копії й розʼїхались.
 *  Map, а не обʼєкт: ключ приходить зі сканера, а `in` на обʼєкті ходить
 *  прототипом (та сама причина, що у FEATURE_MAP в api-levers.mjs). */
const GUARDED = new Map<string, number>([
  ['MAX_PROMPT_LEN', MAX_PROMPT_LEN],
  ['MAX_SYSTEM_PROMPT_LEN', MAX_SYSTEM_PROMPT_LEN],
  ['MAX_SCHEMA_LEN', MAX_SCHEMA_LEN],
]);

/**
 * `MAX_ЩОСЬ = 1234` — байдуже, у коментарі, у хвості рядка з кодом чи з
 * переносом посередині.
 *
 * `\s*` між частинами навмисно пропускає й переніс рядка, а `[/*]+` — маркери
 * `//` та `*`, якими продовжується коментар. Так ловиться те, що перша версія
 * пропускала: розрив, який prettier робить із довгого українського речення.
 * Проміжний ТЕКСТ розрив не мостить — між назвою і `=` не має бути нічого,
 * крім пробілів і маркерів, тож `MAX_FOO` в одному абзаці й `= 5` у наступному
 * рядку коду не склеюються.
 */
const CITATION = /\b(MAX_[A-Z0-9_]+)\s*(?:[/*]+\s*)?=\s*(?:[/*]+\s*)?([0-9][0-9_]*)/g;

export type Citation = { name: string; cited: string; line: number };

/** Номер рядка (з 1) за зміщенням у тексті. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Знайти в тексті всі копії чисел ГЛЯДОВАНИХ меж.
 *
 * Оголошення самої константи — не копія, а джерело; воно єдине має право
 * називати число. Тому рядок виду `export const MAX_X = 24_000;` пропускаємо.
 *
 * Експортується, щоб перевірка детектора била в САМ детектор, а не в свою
 * копію регекса — інакше зламаний регекс лишав би обидва тести зеленими.
 */
export function citationsIn(text: string): Citation[] {
  const lines = text.split('\n');
  const hits: Citation[] = [];
  for (const m of text.matchAll(CITATION)) {
    const name = m[1]!;
    if (!GUARDED.has(name)) continue;
    const line = lineOf(text, m.index);
    const decl = new RegExp(`^\\s*(export\\s+)?(const|let|var)\\s+${name}\\b`);
    if (decl.test(lines[line - 1] ?? '')) continue;
    hits.push({ name, cited: m[2]!, line });
  }
  return hits;
}

function scanRepo(): string[] {
  const found: string[] = [];
  for (const dir of DIRS) {
    for (const file of walkFiles(join(ROOT, dir), { exts: EXTS })) {
      const rel = relative(ROOT, file).split(sep).join('/');
      for (const hit of citationsIn(readFileSync(file, 'utf8'))) {
        found.push(`${rel}:${hit.line}: ${hit.name}=${hit.cited}`);
      }
    }
  }
  return found;
}

describe('число межі хоста не копіюється в прозу', () => {
  it('сканер справді читає файли (інакше тест зелений через порожній вхід)', () => {
    const files = DIRS.flatMap((d) => walkFiles(join(ROOT, d), { exts: EXTS }));
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('llm-host-core.mjs'))).toBe(true);
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
  });

  it.each([
    [' * хост відхиляє промпт, довший за MAX_PROMPT_LEN=6000', 'у суцільному коментарі'],
    ['const x = 1; // запас під MAX_PROMPT_LEN = 6000', 'у хвості рядка з кодом'],
    ['// межа MAX_PROMPT_LEN =\n// 6000 символів', 'з переносом після знака'],
    ['/* MAX_PROMPT_LEN\n   * = 6000 */', 'з переносом перед знаком'],
  ])('детектор ловить копію %#: %s', (text) => {
    const hits = citationsIn(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe('MAX_PROMPT_LEN');
    expect(hits[0]!.cited).toBe('6000');
  });

  it.each([
    ['export const MAX_PROMPT_LEN = 24_000;', 'оголошення джерела правди'],
    ['const MAX_TOKEN_LEN = 4000;', 'межа поза списком глядованих'],
    ['if (prompt.length > MAX_PROMPT_LEN) return null;', 'звичайне вживання константи'],
    ['clipAgentTranscript(text, (max = MAX_PROMPT_LEN));', 'константа праворуч від знака'],
  ])('детектор мовчить на %#: %s', (text) => {
    expect(citationsIn(text)).toEqual([]);
  });

  it('номер рядка вказує на початок копії, а не на початок файлу', () => {
    const text = 'рядок 1\nрядок 2\n// межа MAX_SCHEMA_LEN=4000\n';
    expect(citationsIn(text)[0]?.line).toBe(3);
  });

  it('жоден файл у web/, host/ і src/ не називає число замість константи', () => {
    expect(scanRepo().join('\n')).toBe('');
  });
});
