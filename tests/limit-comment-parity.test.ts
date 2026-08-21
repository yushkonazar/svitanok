import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MAX_PROMPT_LEN, MAX_SYSTEM_PROMPT_LEN, MAX_SCHEMA_LEN } from '../host/llm-host-core.mjs';

/* Коментар не має називати число межі — лише саму константу.
 *
 * ⚠️ ПРИВІД. 11.08.2026 ліміти хоста підняли (2000/3000/6000 -> 4000/5000/24000),
 * але СІМ коментарів у web/ лишились зі старими числами, причому різними для
 * однієї константи: MAX_PROMPT_LEN зустрічався і як 4000, і як 6000. Читач (і
 * я сам, і план у .workspace) вірив копії, а не оригіналу: у Roadmap так і
 * лишилось записано «системний промпт обмежений 3000» — тобто вигаданий блокер
 * пережив своє скасування на 11 днів.
 *
 * Тихо тому, що код був ПРАВИЛЬНИЙ: межі імпортуються з host/llm-host-core.mjs,
 * тести звіряються з нею ж, продакшн працює. Протухає лише проза, а її ніщо не
 * виконує.
 *
 * Тест забороняє сам ФОРМАТ `MAX_X=1234` у коментарі для цих трьох імен: копії
 * числа не існує -> нічому протухати. Історичну довідку писати словами
 * («межу відтоді підняли»), а не цифрою.
 */

const ROOT = join(__dirname, '..');
const DIRS = ['web', 'host'];

/** Константи з єдиним джерелом правди — саме їх копії й розʼїхались. */
const GUARDED: Record<string, number> = {
  MAX_PROMPT_LEN,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_SCHEMA_LEN,
};

/** Усі .mjs під dir, рекурсивно; службові каталоги збірки пропускаємо. */
function mjsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return mjsFiles(full);
    return name.endsWith('.mjs') ? [full] : [];
  });
}

/** Рядок є коментарем: `//`, `/*` або продовження блока `*`. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

type Hit = { where: string; name: string; cited: string };

function citedLimits(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of DIRS) {
    for (const file of mjsFiles(join(ROOT, dir))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!isCommentLine(line)) return;
        for (const m of line.matchAll(/\b(MAX_[A-Z0-9_]+)\s*=\s*([0-9][0-9_]*)/g)) {
          const name = m[1]!;
          if (!(name in GUARDED)) continue;
          hits.push({
            where: `${relative(ROOT, file).split(sep).join('/')}:${i + 1}`,
            name,
            cited: m[2]!,
          });
        }
      });
    }
  }
  return hits;
}

describe('коментарі не дублюють числа лімітів хоста', () => {
  it('сканер справді читає файли (інакше тест зелений через порожній вхід)', () => {
    const files = DIRS.flatMap((d) => mjsFiles(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('llm-host-core.mjs'))).toBe(true);
  });

  it('сканер бачить формат, який ловить (перевірка самого детектора)', () => {
    const line = ' * хост відхиляє промпт, довший за MAX_PROMPT_LEN=6000 (стара копія)';
    expect(isCommentLine(line)).toBe(true);
    const m = [...line.matchAll(/\b(MAX_[A-Z0-9_]+)\s*=\s*([0-9][0-9_]*)/g)];
    expect(m[0]?.[1]).toBe('MAX_PROMPT_LEN');
    expect(m[0]?.[2]).toBe('6000');
  });

  it('жоден коментар у web/ і host/ не називає число замість константи', () => {
    const hits = citedLimits();
    const report = hits.map((h) => `${h.where}: ${h.name}=${h.cited}`).join('\n');
    expect(report).toBe('');
  });

  it('джерело правди лишається одне — усі три межі числові й ненульові', () => {
    for (const [name, value] of Object.entries(GUARDED)) {
      expect(Number.isFinite(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
    }
  });
});
