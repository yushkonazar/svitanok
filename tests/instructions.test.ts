// Інструкції (етап 2 PR-5): КОНТРАКТ-тест над справжніми файлами
// docs/assistant/** - front-matter, стелі, розділи, інструменти, тире. Саме
// цей тест робить «правка інструкції» безпечною операцією: помилку видно до
// того, як синк покладе текст у D1 і модель почне ним користуватись.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseInstruction,
  validateInstruction,
  instructionHash,
  loadInstruction,
  CANON_TOOLS,
  INSTRUCTION_KINDS,
} from '../web/core/instructions.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const DOCS = join(__dirname, '..', 'docs', 'assistant');

/** Усі .md рекурсивно, окрім README (опис механізму, не інструкція). */
function instructionFiles(dir: string = DOCS): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...instructionFiles(full));
    else if (entry.endsWith('.md') && entry !== 'README.md') out.push(full);
  }
  return out;
}

const files = instructionFiles().map((full) => ({
  path: relative(DOCS, full).replaceAll('\\', '/'),
  raw: readFileSync(full, 'utf8'),
}));

describe('docs/assistant - склад', () => {
  it('16 інструкцій: persona, 11 працівників, 3 чеклісти, профіль звіту', () => {
    expect(files).toHaveLength(16);
    const byKind = new Map<string, number>();
    for (const f of files) {
      const parsed = parseInstruction(f.raw);
      if (!parsed.ok) throw new Error(`${f.path}: ${parsed.error}`);
      const kind = String(parsed.front.kind);
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    expect(Object.fromEntries(byKind)).toEqual({
      persona: 1,
      agent: 11,
      checklist: 3,
      profile: 1,
    });
  });
});

describe('docs/assistant - правила README', () => {
  for (const file of files) {
    it(`${file.path}: чинна`, () => {
      expect(validateInstruction(file)).toEqual([]);
    });
  }
});

describe('validateInstruction - ловить дефекти', () => {
  const good = files.find((f) => f.path === 'persona.md')!;

  it('немає front-matter', () => {
    expect(validateInstruction({ path: 'x.md', raw: '# Просто текст' })).toEqual([
      'x.md: немає front-matter (---)',
    ]);
  });

  it('name ≠ імені файлу', () => {
    const errors = validateInstruction({ path: 'inshe.md', raw: good.raw });
    expect(errors.some((e) => e.includes('≠ імені файлу'))).toBe(true);
  });

  it('тіло понад max_chars', () => {
    const raw = good.raw.replace(/max_chars: \d+/, 'max_chars: 10');
    const errors = validateInstruction({ path: 'persona.md', raw });
    expect(errors.some((e) => e.includes('понад max_chars 10'))).toBe(true);
  });

  it('невідомий інструмент і persona з інструментами', () => {
    const raw = good.raw.replace('tools: []', 'tools: [calendar.raed]');
    const errors = validateInstruction({ path: 'persona.md', raw });
    expect(errors.some((e) => e.includes('невідомий інструмент «calendar.raed»'))).toBe(true);
    const withTool = good.raw.replace('tools: []', 'tools: [calendar.read]');
    expect(
      validateInstruction({ path: 'persona.md', raw: withTool }).some((e) =>
        e.includes('persona не задає інструментів'),
      ),
    ).toBe(true);
  });

  it('загублений розділ і довге тире', () => {
    const noSection = good.raw.replace('## Памʼять', '## Спогади');
    expect(
      validateInstruction({ path: 'persona.md', raw: noSection }).some((e) =>
        e.includes('бракує розділу «Памʼять»'),
      ),
    ).toBe(true);
    const emDash = good.raw.replace('## Тон', '## Тон — і настрій');
    expect(
      validateInstruction({ path: 'persona.md', raw: emDash }).some((e) =>
        e.includes('довге тире'),
      ),
    ).toBe(true);
  });

  it('kind поза переліком і крива дата updated', () => {
    const raw = good.raw
      .replace('kind: persona', 'kind: vibe')
      .replace(/updated: .*/, 'updated: вчора');
    const errors = validateInstruction({ path: 'persona.md', raw });
    expect(errors.some((e) => e.includes('kind «vibe» поза переліком'))).toBe(true);
    expect(errors.some((e) => e.includes('updated має бути YYYY-MM-DD'))).toBe(true);
  });
});

describe('instructionHash', () => {
  it('sha256 hex від тіла, стабільний і чутливий до символу', async () => {
    const a = await instructionHash('Текст інструкції');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await instructionHash('Текст інструкції')).toBe(a);
    expect(await instructionHash('Текст інструкціі')).not.toBe(a);
  });

  it('CRLF і LF дають ОДИН хеш (Windows-тред проти Linux-раннера)', async () => {
    const lf = 'Перший рядок\nДругий рядок\n';
    expect(await instructionHash(lf.replace(/\n/g, '\r\n'))).toBe(await instructionHash(lf));
  });

  it('парсер теж не залежить від переносів', () => {
    const file = files[0]!;
    const asCrlf = file.raw.replace(/\r?\n/g, '\r\n');
    const a = parseInstruction(file.raw);
    const b = parseInstruction(asCrlf);
    if (!a.ok || !b.ok) throw new Error('очікувався розбір');
    expect(b.body).toBe(a.body);
    expect(b.front).toEqual(a.front);
  });
});

describe('loadInstruction (D1)', () => {
  function envWithRow(over: { body?: string; hash?: string } = {}) {
    const d1 = d1FromSqlite(['0007_instructions_plans.sql']);
    return { d1, env: workerEnv({ DB: d1.stub }), over };
  }

  it('віддає тіло, коли хеш збігається', async () => {
    const { d1, env } = envWithRow();
    const body = 'Ти - Світанок.';
    const hash = await instructionHash(body);
    d1.db
      .prepare(
        `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
         VALUES ('persona', 'persona', ?, ?, 4500, '2026-08-28T00:00:00Z')`,
      )
      .run(hash, body);

    await expect(loadInstruction(env, 'persona')).resolves.toEqual({
      name: 'persona',
      kind: 'persona',
      body,
      hash,
    });
  });

  it('відсутній рядок - помилка, а не тихий фолбек', async () => {
    const { env } = envWithRow();
    await expect(loadInstruction(env, 'persona')).rejects.toThrow('синк не відпрацював');
  });

  it('розбіжність хешу з тілом - помилка (D1 пошкоджено)', async () => {
    const { d1, env } = envWithRow();
    d1.db
      .prepare(
        `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
         VALUES ('persona', 'persona', 'deadbeef', 'Тіло, якого хеш не описує', 4500, '2026-08-28T00:00:00Z')`,
      )
      .run();
    await expect(loadInstruction(env, 'persona')).rejects.toThrow('розійшовся з тілом');
  });
});

describe('CANON_TOOLS проти живого реєстру ядра', () => {
  it('усі імена реєстру входять у канонічний перелік 07 §4', async () => {
    const { TOOLS } = await import('../web/core/tools/index.mjs');
    for (const name of Object.keys(TOOLS)) expect(CANON_TOOLS).toContain(name);
  });

  it('перелік kind збігається з тим, що вживають файли', () => {
    for (const f of files) {
      const parsed = parseInstruction(f.raw);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(INSTRUCTION_KINDS).toContain(String(parsed.front.kind));
    }
  });
});
