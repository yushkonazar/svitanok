// Ідеї (етап 3 PR-4, S-3-1/2/6/7): CRUD на справжніх міграціях 0004 (ideas,
// idea_events) + 0008 (ideas_fts) у node:sqlite; номер = rowid; FTS-синк;
// події; analyze(plan) → статус «в аналізі», code → чесна відмова; policy:
// create/update/analyze T0 з «↩», delete T1.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runIdeasCreate,
  runIdeasUpdate,
  runIdeasList,
  runIdeasSearch,
  runIdeasDelete,
  runIdeasAnalyze,
  findIdea,
  ftsQuery,
  IDEA_STATUSES,
  IDEAS_LIST_MAX,
} from '../web/core/tools/ideas.mjs';
import {
  applyPolicy,
  resolveUndo,
  resolveProposal,
  EXECUTORS,
} from '../web/core/policy/proposals.mjs';
import { ACTION_LEVELS } from '../web/core/policy/core.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { validateAgainst } from '../web/core/internal/schemas.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-03T10:00:00.000Z');
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0004_ideas_travel.sql',
  '0008_fts.sql',
  '0011_ideas_number.sql',
];

let d1: ReturnType<typeof d1FromSqlite>;
let env: Env;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  d1 = d1FromSqlite(MIGRATIONS);
  env = workerEnv({ DB: d1.stub });
});

const count = (sql: string) => (d1.db.prepare(sql).get() as { n: number }).n;

describe('ideas.create / findIdea (S-3-1)', () => {
  // Приймання 05.09, B5: після видалення останньої ідеї нова знову ставала
  // «#1» (rowid повторюється) - номер тепер з монотонного лічильника.
  it('номер не повторюється після видалення останньої ідеї; без лічильника - гучна помилка', async () => {
    const first = await runIdeasCreate(env, { title: 'Перша' }, NOW);
    expect(first.result.number).toBe(1);
    await runIdeasDelete(env, { id: '1' });
    const second = await runIdeasCreate(env, { title: 'Друга' }, NOW + 1);
    expect(second.result.number).toBe(2);
    expect(await findIdea(env, '#1')).toBeNull();
    expect((await findIdea(env, '2'))?.title).toBe('Друга');
    expect(d1.db.prepare(`SELECT value FROM counters WHERE name = 'ideas'`).get()).toEqual({
      value: 2,
    });
    d1.db.prepare(`DELETE FROM counters`).run();
    await expect(runIdeasCreate(env, { title: 'Третя' }, NOW + 2)).rejects.toThrow('міграція 0011');
  });

  it('записує ідею: статус «нова», priority 2, domain «інше» за замовчуванням; номер з лічильника; подія created; FTS', async () => {
    const { result } = await runIdeasCreate(env, { title: 'Експорт колекцій у Sheets' }, NOW);
    expect(result).toMatchObject({ number: 1, status: 'нова', priority: 2, domain: 'інше' });
    const second = await runIdeasCreate(
      env,
      { title: 'Друга', domain: 'svitanok', priority: 1, effort: 'M', tags: ['ui', 'export'] },
      NOW + 1000,
    );
    expect(second.result.number).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM idea_events WHERE kind = 'created'")).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM ideas_fts')).toBe(2);
    // За номером і за id - той самий рядок.
    const byNumber = await findIdea(env, '#2');
    const byId = await findIdea(env, second.result.id);
    expect(byNumber?.id).toBe(byId?.id);
    expect(byNumber?.tags_json).toBe('["ui","export"]');
  });

  it('порожній title, чужий domain, priority поза 1-3, effort поза S|M|L - помилки', async () => {
    await expect(runIdeasCreate(env, { title: '  ' }, NOW)).rejects.toThrow(/title/);
    await expect(runIdeasCreate(env, { title: 'x', domain: 'космос' }, NOW)).rejects.toThrow(
      /domain/,
    );
    await expect(runIdeasCreate(env, { title: 'x', priority: 7 }, NOW)).rejects.toThrow(/priority/);
    await expect(runIdeasCreate(env, { title: 'x', effort: 'XL' }, NOW)).rejects.toThrow(/effort/);
    expect(count('SELECT COUNT(*) AS n FROM ideas')).toBe(0);
  });
});

describe('ideas.update / list / search / delete', () => {
  it('update: часткова правка, знімок ДО правки, подія status з переходом, FTS оновлено', async () => {
    const { result: created } = await runIdeasCreate(
      env,
      { title: 'Стара назва', body_md: 'тіло' },
      NOW,
    );
    const { result, prev } = await runIdeasUpdate(
      env,
      { id: String(created.number), status: 'у роботі', title: 'Нова назва', priority: 1 },
      NOW + 5000,
    );
    expect(result.updated.sort()).toEqual(['priority', 'status', 'title']);
    expect(prev).toEqual({
      id: created.id,
      fields: { status: 'нова', title: 'Стара назва', priority: 2 },
    });
    const row = d1.db.prepare('SELECT title, status, priority FROM ideas').get();
    expect(row).toEqual({ title: 'Нова назва', status: 'у роботі', priority: 1 });
    const ev = d1.db.prepare(`SELECT note FROM idea_events WHERE kind = 'status'`).get() as {
      note: string;
    };
    expect(ev.note).toBe('нова → у роботі');
    expect((await runIdeasSearch(env, { q: 'нова назва' })).result).toHaveLength(1);
    expect((await runIdeasSearch(env, { q: 'стара' })).result).toHaveLength(0);
  });

  it('update: невідомий статус/нічого оновлювати/неіснуюча ідея - помилки; «погоджено» ставить plan_approved_at', async () => {
    const { result: created } = await runIdeasCreate(env, { title: 'x' }, NOW);
    await expect(runIdeasUpdate(env, { id: created.id, status: 'готово' }, NOW)).rejects.toThrow(
      /status/,
    );
    await expect(runIdeasUpdate(env, { id: created.id, foo: 1 }, NOW)).rejects.toThrow(/нічого/);
    await expect(runIdeasUpdate(env, { id: '999', status: 'нова' }, NOW)).rejects.toThrow(/немає/);
    await runIdeasUpdate(env, { id: created.id, status: 'погоджено' }, NOW + 1);
    const row = d1.db.prepare('SELECT plan_approved_at FROM ideas').get() as {
      plan_approved_at: string;
    };
    expect(row.plan_approved_at).toBe(new Date(NOW + 1).toISOString());
  });

  it('list (S-3-6): ≤ 10, свіжі першими, без зроблених/відхилених; фільтр domain і status', async () => {
    for (let i = 1; i <= 12; i += 1) {
      await runIdeasCreate(
        env,
        { title: `Ідея ${i}`, domain: i % 2 ? 'svitanok' : 'побут' },
        NOW + i,
      );
    }
    await runIdeasUpdate(env, { id: '1', status: 'зроблено' }, NOW + 100);
    const all = (await runIdeasList(env, {})).result as { number: number }[];
    expect(all).toHaveLength(IDEAS_LIST_MAX);
    // Найсвіжіша за updated_at - остання створена; №1 щойно «зроблено» і
    // без фільтра статусу її в списку немає.
    expect(all[0]?.number).toBe(12);
    const numbers = all.map((r) => r.number);
    expect(numbers).not.toContain(1);
    const svitanok = (await runIdeasList(env, { domain: 'svitanok' })).result as {
      domain: string;
    }[];
    expect(svitanok.every((r) => r.domain === 'svitanok')).toBe(true);
    const done = (await runIdeasList(env, { status: 'зроблено' })).result as { number: number }[];
    expect(done.map((r) => r.number)).toEqual([1]);
    await expect(runIdeasList(env, { domain: 'марс' })).rejects.toThrow(/domain/);
  });

  it('search: слова в лапках (AND), оператори FTS - літерали; порожній q - помилка', async () => {
    expect(ftsQuery('експорт OR колекцій')).toBe('"експорт" "OR" "колекцій"');
    expect(ftsQuery('  a"b   ')).toBe('"ab"');
    expect(ftsQuery('')).toBe('');
    await runIdeasCreate(env, { title: 'Експорт колекцій', body_md: 'у Google Sheets' }, NOW);
    await runIdeasCreate(env, { title: 'Інше', body_md: 'нічого спільного' }, NOW);
    expect((await runIdeasSearch(env, { q: 'sheets' })).result).toHaveLength(1);
    expect((await runIdeasSearch(env, { q: 'експорт NEAR' })).result).toHaveLength(0);
    await expect(runIdeasSearch(env, { q: '   ' })).rejects.toThrow(/слово/);
  });

  it('delete: рядок, події і FTS зникають; неіснуюча - помилка', async () => {
    const { result: created } = await runIdeasCreate(env, { title: 'Зайва' }, NOW);
    const { result } = await runIdeasDelete(env, { id: String(created.number) });
    expect(result).toMatchObject({ deleted: true, number: 1, title: 'Зайва' });
    expect(count('SELECT COUNT(*) AS n FROM ideas')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM idea_events')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM ideas_fts')).toBe(0);
    await expect(runIdeasDelete(env, { id: '1' })).rejects.toThrow(/немає/);
  });
});

describe('ideas.analyze (S-3-2)', () => {
  it('plan: статус «в аналізі», подія analysis, ідея й інструкція моделі у відповіді, prev зі старим статусом', async () => {
    const { result: created } = await runIdeasCreate(env, { title: 'A', body_md: 'суть' }, NOW);
    const { result, prev } = await runIdeasAnalyze(env, { id: created.id, mode: 'plan' }, NOW + 1);
    expect(result).toMatchObject({
      number: 1,
      title: 'A',
      body_md: 'суть',
      instruction: expect.stringContaining('ideas.update'),
    });
    expect(prev).toEqual({ id: created.id, status: 'нова' });
    expect((d1.db.prepare('SELECT status FROM ideas').get() as { status: string }).status).toBe(
      'в аналізі',
    );
    expect(count("SELECT COUNT(*) AS n FROM idea_events WHERE kind = 'analysis'")).toBe(1);
  });

  // mode=code (етап 4 PR-2) - core/ideas/analysis.mjs; тут лише межі входу:
  // без repo (domain не svitanok) - питання; чуже repo - S-3-8; без
  // REPO_READ_PAT - явна відмова; статус не чіпається.
  it('code: repo/PAT перевіряються ДО будь-якої зміни; чужий mode - помилка', async () => {
    const { result: created } = await runIdeasCreate(env, { title: 'A' }, NOW);
    await expect(runIdeasAnalyze(env, { id: created.id, mode: 'code' }, NOW)).rejects.toThrow(
      /вкажи repo/,
    );
    await expect(
      runIdeasAnalyze(env, { id: created.id, mode: 'code', repo: 'other' }, NOW),
    ).rejects.toThrow(/Доступ є лише до svitanok, portfolio, moviehouse, modern-blog/);
    await expect(
      runIdeasAnalyze(env, { id: created.id, mode: 'code', repo: 'svitanok' }, NOW),
    ).rejects.toThrow(/REPO_READ_PAT/);
    await expect(runIdeasAnalyze(env, { id: created.id, mode: 'магія' }, NOW)).rejects.toThrow(
      /mode/,
    );
    expect((d1.db.prepare('SELECT status FROM ideas').get() as { status: string }).status).toBe(
      'нова',
    );
  });
});

describe('policy: рівні й виконавці ідей', () => {
  it('create/update/analyze - T0, delete - T1; усі мають виконавців; реєстр і статуси канонічні', () => {
    expect(ACTION_LEVELS['ideas.create']).toBe('T0');
    expect(ACTION_LEVELS['ideas.update']).toBe('T0');
    expect(ACTION_LEVELS['ideas.analyze']).toBe('T0');
    expect(ACTION_LEVELS['ideas.delete']).toBe('T1');
    for (const k of ['ideas.create', 'ideas.update', 'ideas.analyze', 'ideas.delete']) {
      expect(EXECUTORS[k]).toBeDefined();
      expect(TOOLS[k]?.write?.kind).toBe(k);
    }
    expect(TOOLS['ideas.list']?.write).toBeUndefined();
    expect(IDEA_STATUSES).toHaveLength(8);
    expect(validateAgainst(TOOLS['ideas.create']!.args, { title: 'x', tags: ['a'] }).ok).toBe(true);
    expect(validateAgainst(TOOLS['ideas.create']!.args, { title: 'x', tags: 'a' }).ok).toBe(false);
  });

  it('T0 create з «↩»: undo видаляє ідею; T0 update з «↩»: undo повертає поля як були', async () => {
    const created = await applyPolicy(
      env,
      { kind: 'ideas.create', payload: { title: 'Ідея', domain: 'svitanok' }, tainted: false },
      NOW,
    );
    if (created.mode !== 'executed' || !created.undo) throw new Error('очікувався T0 з undo');
    expect(created.result).toMatchObject({ number: 1, domain: 'svitanok' });

    const updated = await applyPolicy(
      env,
      { kind: 'ideas.update', payload: { id: '1', status: 'у роботі' }, tainted: false },
      NOW + 1,
    );
    if (updated.mode !== 'executed' || !updated.undo) throw new Error('очікувався T0 з undo');
    expect(await resolveUndo(env, updated.undo.id, NOW + 2)).toEqual({
      ok: true,
      status: 'undone',
    });
    expect((d1.db.prepare('SELECT status FROM ideas').get() as { status: string }).status).toBe(
      'нова',
    );

    expect(await resolveUndo(env, created.undo.id, NOW + 3)).toEqual({
      ok: true,
      status: 'undone',
    });
    expect(count('SELECT COUNT(*) AS n FROM ideas')).toBe(0);
  });

  it('analyze T0 з «↩» повертає статус; delete - пропозиція T1, ✅ виконує', async () => {
    await runIdeasCreate(env, { title: 'Ідея' }, NOW);
    const analyzed = await applyPolicy(
      env,
      { kind: 'ideas.analyze', payload: { id: '1', mode: 'plan' }, tainted: false },
      NOW,
    );
    if (analyzed.mode !== 'executed' || !analyzed.undo) throw new Error('очікувався T0 з undo');
    await resolveUndo(env, analyzed.undo.id, NOW + 1);
    expect((d1.db.prepare('SELECT status FROM ideas').get() as { status: string }).status).toBe(
      'нова',
    );

    const del = await applyPolicy(
      env,
      { kind: 'ideas.delete', payload: { id: '1' }, tainted: false },
      NOW,
    );
    if (del.mode !== 'proposed') throw new Error('очікувалась пропозиція T1');
    expect(del.proposal.level).toBe('T1');
    expect(count('SELECT COUNT(*) AS n FROM ideas')).toBe(1);
    const ok = await resolveProposal(env, { id: del.proposal.id, choice: 'ok' }, NOW + 1);
    expect(ok).toMatchObject({ ok: true, status: 'approved', executed: true });
    expect(count('SELECT COUNT(*) AS n FROM ideas')).toBe(0);
  });

  it('undo update повертає tags (масив ↔ tags_json) і поле, що було NULL; title: null - помилка, не назва «null»', async () => {
    await runIdeasCreate(env, { title: 'Ідея', tags: ['a', 'b'] }, NOW);
    const updated = await applyPolicy(
      env,
      {
        kind: 'ideas.update',
        payload: { id: '1', tags: ['c'], next_action: 'подзвонити' },
        tainted: false,
      },
      NOW + 1,
    );
    if (updated.mode !== 'executed' || !updated.undo) throw new Error('очікувався T0 з undo');
    expect(await resolveUndo(env, updated.undo.id, NOW + 2)).toEqual({
      ok: true,
      status: 'undone',
    });
    const row = d1.db.prepare('SELECT tags_json, next_action FROM ideas').get() as {
      tags_json: string;
      next_action: string | null;
    };
    expect(row).toEqual({ tags_json: '["a","b"]', next_action: null });
    await expect(runIdeasUpdate(env, { id: '1', title: null }, NOW)).rejects.toThrow(/title/);
  });

  it('tainted-сесія: create виконується з «↩» (звуження 08.09)', async () => {
    // Ідея - запис у ВЛАСНІЙ базі; інʼєкція з листа тут коштує один рядок,
    // який знімається тапом. Барʼєр лишився для дій назовні (policy.test.ts).
    const out = await applyPolicy(
      env,
      { kind: 'ideas.create', payload: { title: 'З листа' }, tainted: true },
      NOW,
    );
    expect(out.mode).toBe('executed');
    expect(count('SELECT COUNT(*) AS n FROM ideas')).toBe(1);
  });
});
