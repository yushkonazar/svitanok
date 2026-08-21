import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* Рекурсивний обхід файлів репозиторію для тестів-звірок.
 *
 * Винесено, бо ходили ДВА майже однакові обходи — `tsFiles` у
 * workflow-env-parity і `mjsFiles` у limit-comment-parity, — і вони вже встигли
 * розійтись: один пропускав node_modules, другий ні. Тести-звірки читають дерево
 * саме тому, що перелік не можна тримати руками; мати два переліки способів
 * читати дерево — та сама помилка на поверх нижче.
 */

/** Каталоги, які не є вихідним кодом: залежності й артефакти збірки.
 *
 *  ⚠️ `public` тут не для краси: `web/public/app/assets/*.js` — це зібраний
 *  бандл дашборда, який лежить у git. Без цього рядка звірка щоразу читала б
 *  мінімізований файл на сотні кілобайт. */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'public']);

export type WalkOptions = {
  /** Розширення з крапкою, напр. ['.ts', '.tsx']. */
  exts: string[];
  /** Додаткові каталоги до пропуску (понад IGNORED_DIRS). */
  ignoreDirs?: string[];
};

/**
 * Усі файли з потрібними розширеннями під `dir`, рекурсивно.
 *
 * Пропускаємо залежності, артефакти збірки й усе, що починається з крапки
 * (`.wrangler/tmp` після `wrangler dev` — не код, але з розширенням .mjs).
 */
export function walkFiles(dir: string, opts: WalkOptions): string[] {
  const ignored = opts.ignoreDirs ? new Set([...IGNORED_DIRS, ...opts.ignoreDirs]) : IGNORED_DIRS;
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.') || ignored.has(name)) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walkFiles(full, opts);
    return opts.exts.some((ext) => name.endsWith(ext)) ? [full] : [];
  });
}
