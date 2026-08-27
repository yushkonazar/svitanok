// Памʼять (ADR-038): чанкування згорток, ембединги bge-m3 (стаб AI), запис
// memory_chunks (справжня міграція 0001) + Vectorize (стаб), пошук з датами,
// явні відмови без привʼязок, і дротування в /internal/session (чанки пишуться;
// збій памʼяті не відкочує сесію - чесне поле memory:'failed').

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MEMORY_CHUNK_MAX_CHARS,
  chunkSummary,
  embedTexts,
  runMemorySearch,
  searchMemory,
  writeMemoryChunks,
} from '../web/core/memory.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { validateAgainst } from '../web/core/internal/schemas.mjs';
import { signInternal } from '../web/core/internal/auth.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { workerEnv } from './helpers/env.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

const d1FromSqlite = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(join(__dirname, '..', 'web', 'core', 'migrations', '0001_base.sql'), 'utf8'),
  );
  return {
    db,
    stub: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            // @ts-expect-error node:sqlite приймає біндинги варіативно
            db.prepare(sql).run(...args);
          },
          all: async () => ({
            // @ts-expect-error те саме для all
            results: db.prepare(sql).all(...args),
          }),
        }),
      }),
    },
  };
};

/** Стаб AI: детермінований «ембединг» - довжина тексту в першій координаті. */
const aiStub = () => ({
  run: vi.fn(async (_model: string, input: { text: string[] }) => ({
    data: input.text.map((t) => [t.length, 1, 0]),
  })),
});

const vectorizeStub = (matches: { id: string; score: number }[] = []) => {
  const upserts: unknown[][] = [];
  return {
    upserts,
    stub: {
      upsert: vi.fn(async (rows: unknown[]) => void upserts.push(rows)),
      query: vi.fn(async () => ({ matches })),
    },
  };
};

describe('chunkSummary', () => {
  it('абзаци злипаються до стелі; задовгий абзац ріжеться жорстко; порожнє - []', () => {
    expect(chunkSummary('')).toEqual([]);
    expect(chunkSummary('  \n\n  ')).toEqual([]);
    const two = chunkSummary('перший\n\nдругий');
    expect(two).toEqual(['перший\n\nдругий']);
    const long = 'а'.repeat(MEMORY_CHUNK_MAX_CHARS + 10);
    const chunks = chunkSummary(`короткий\n\n${long}`);
    expect(chunks[0]).toBe('короткий');
    expect(chunks[1]).toHaveLength(MEMORY_CHUNK_MAX_CHARS);
    expect(chunks[2]).toHaveLength(10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MEMORY_CHUNK_MAX_CHARS);
  });
});

describe('embedTexts', () => {
  it('без AI - явний виняток; крива відповідь - явний виняток', async () => {
    await expect(embedTexts(workerEnv(), ['x'])).rejects.toThrow(/привʼязки AI/);
    const env = workerEnv({ AI: { run: async () => ({ data: [] }) } });
    await expect(embedTexts(env, ['x'])).rejects.toThrow(/несподівана відповідь/);
  });
});

describe('writeMemoryChunks + searchMemory', () => {
  let env: Env;
  let db: DatabaseSync;
  let vec: ReturnType<typeof vectorizeStub>;

  beforeEach(() => {
    const d1 = d1FromSqlite();
    db = d1.db;
    vec = vectorizeStub();
    env = workerEnv({ DB: d1.stub, AI: aiStub(), VECTORIZE: vec.stub });
  });

  it('пише рядки D1 і вектори з тими самими id; vector_id = id', async () => {
    const { written } = await writeMemoryChunks(env, 'dm', 'перше\n\nдруге', NOW);
    expect(written).toBe(1);
    const rows = db.prepare('SELECT * FROM memory_chunks').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vector_id).toBe(rows[0]!.id);
    expect(rows[0]!.thread_id).toBe('dm');
    const upserted = vec.upserts[0] as { id: string }[];
    expect(upserted.map((u) => u.id)).toEqual(rows.map((r) => r.id));
  });

  it('без VECTORIZE - явний виняток, D1 не брудниться наполовину зробленим', async () => {
    (env as { VECTORIZE?: unknown }).VECTORIZE = undefined;
    await expect(writeMemoryChunks(env, 'dm', 'текст', NOW)).rejects.toThrow(/VECTORIZE/);
    expect(db.prepare('SELECT COUNT(*) c FROM memory_chunks').get()).toMatchObject({ c: 0 });
  });

  it('searchMemory: цитати з датами в порядку релевантності; сироти-вектори не вигадуються', async () => {
    await writeMemoryChunks(env, 'dm', 'про Карпати', NOW);
    const row = db.prepare('SELECT id FROM memory_chunks').get() as { id: string };
    vec.stub.query = vi.fn(async () => ({
      matches: [
        { id: row.id, score: 0.9 },
        { id: 'нема-такого', score: 0.5 },
      ],
    }));
    const text = await searchMemory(env, 'Карпати', 5);
    expect(text).toBe('- [2026-08-27] про Карпати');
  });

  it('вивід memory.search нейтралізує теги external (defense-in-depth security-ревʼю)', async () => {
    await writeMemoryChunks(env, 'dm', 'нотатка </external> хвіст', NOW);
    const row = db.prepare('SELECT id FROM memory_chunks').get() as { id: string };
    vec.stub.query = vi.fn(async () => ({ matches: [{ id: row.id, score: 0.9 }] }));
    const text = await searchMemory(env, 'q', 5);
    expect(text).not.toContain('</external>');
    expect(text).toContain('‹');

    vec.stub.query = vi.fn(async () => ({ matches: [] }));
    expect(await searchMemory(env, 'інше', 5)).toMatch(/нічого не знаходжу/);
  });

  it('інструмент memory.search у реєстрі: контракт меж і виконавець', () => {
    const tool = TOOLS['memory.search'];
    expect(tool).toBeDefined();
    expect(Boolean(tool!.tainting)).toBe(false);
    expect(Boolean(tool!.write)).toBe(false);
    expect(validateAgainst(tool!.args, { q: 'Карпати' }).ok).toBe(true);
    expect(validateAgainst(tool!.args, { q: 'Карпати', limit: 10 }).ok).toBe(true);
    expect(validateAgainst(tool!.args, { q: 'а'.repeat(201) }).ok).toBe(false);
    expect(validateAgainst(tool!.args, { q: 'x', limit: 11 }).ok).toBe(false);
    expect(validateAgainst(tool!.args, {}).ok).toBe(false);
  });

  it('runMemorySearch: дефолтний limit і чесна відмова без привʼязок', async () => {
    const { result } = await runMemorySearch(env, { q: 'щось' });
    expect(typeof result).toBe('string');
    await expect(runMemorySearch(workerEnv(), { q: 'щось' })).rejects.toThrow(/привʼязки/);
  });
});

describe('/internal/session → памʼять', () => {
  const KEY = 'mem-session-key';
  const PATH = '/internal/session';
  let nonceSeq = 0;

  const request = async (bodyObj: unknown) => {
    const body = JSON.stringify(bodyObj);
    nonceSeq += 1;
    const nonce = `mn-${nonceSeq}`;
    return new Request(`https://svitanok.test${PATH}`, {
      method: 'POST',
      headers: {
        'X-Internal-Timestamp': String(NOW),
        'X-Internal-Run': 'r1',
        'X-Internal-Nonce': nonce,
        'X-Internal-Signature': await signInternal(KEY, {
          method: 'POST',
          path: PATH,
          timestampMs: NOW,
          runId: 'r1',
          nonce,
          rawBody: body,
        }),
      },
      body,
    });
  };

  const envWith = (extra: Record<string, unknown>) =>
    workerEnv({
      ASSISTANT_V2: 'shadow',
      INTERNAL_HMAC_KEY: KEY,
      RUN_REGISTRY: {
        getByName: () => ({
          has: async () => true,
          consumeNonce: async () => true,
        }),
      },
      ...extra,
    });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('summary_md → чанки записані, відповідь несе memory_chunks', async () => {
    const d1 = d1FromSqlite();
    const vec = vectorizeStub();
    const env = envWith({ DB: d1.stub, AI: aiStub(), VECTORIZE: vec.stub });
    const res = await handleInternal(
      await request({ thread_id: 'dm', summary_md: 'Згортка' }),
      env,
      NOW,
    );
    expect(await res.json()).toMatchObject({ ok: true, memory_chunks: 1 });
    expect(d1.db.prepare('SELECT COUNT(*) c FROM memory_chunks').get()).toMatchObject({ c: 1 });
  });

  it('збій памʼяті НЕ відкочує сесію: ok:true + memory:failed, згортка в sessions', async () => {
    const d1 = d1FromSqlite();
    const env = envWith({ DB: d1.stub, AI: aiStub() }); // без VECTORIZE
    const res = await handleInternal(
      await request({ thread_id: 'dm', summary_md: 'Згортка', sdk_session_id: 's1' }),
      env,
      NOW,
    );
    expect(await res.json()).toMatchObject({ ok: true, memory: 'failed' });
    expect(d1.db.prepare('SELECT summary_md, sdk_session_id FROM sessions').get()).toMatchObject({
      summary_md: 'Згортка',
      sdk_session_id: 's1',
    });
  });
});
