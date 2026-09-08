// СПІЛЬНИЙ D1-стаб над node:sqlite (той самий мотив, що init-data.ts: копія,
// що розійшлась, доводить не те). До цього файлу шим жив у ~10 копіях по
// tests/*, і вони ВЖЕ дрейфували: частина без meta.changes (через що драйн
// outbox мовчки не слав - «Fix x2» у памʼяті проєкту), частина без first().
// Контракт тут повний: run → {meta:{changes}}, all → {results}, first → row|null.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface D1Bound {
  run: () => Promise<{ meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[] }>;
  first: () => Promise<unknown>;
  /** Один прогін для batch: і рядки, і meta - як у справжньої D1Result.
   *  ⚠️ Саме ОДИН: викликати all() і run() поспіль означало б виконати
   *  твердження двічі, і `INSERT … ON CONFLICT DO NOTHING` віддав би
   *  changes=0 на другому заході. */
  once: () => Promise<{ results: unknown[]; meta: { changes: number } }>;
}

export interface D1Stub {
  /** Сира база - для сідів і прямих SELECT-звірок у тестах. */
  db: DatabaseSync;
  /** Обʼєкт, який підставляється в env.DB. */
  stub: {
    prepare: (sql: string) => { bind: (...args: unknown[]) => D1Bound };
    /** D1 виконує batch однією транзакцією; тут послідовно - для тестів
     *  важливо, що ВСІ твердження відпрацювали, а не як саме згруповані. */
    batch: (statements: D1Bound[]) => Promise<{ results: unknown[]; meta: { changes: number } }[]>;
  };
}

/** In-memory D1 зі СПРАВЖНІМИ міграціями (імена файлів з web/core/migrations). */
export function d1FromSqlite(migrations: string[]): D1Stub {
  const db = new DatabaseSync(':memory:');
  for (const file of migrations) {
    db.exec(readFileSync(join(__dirname, '..', '..', 'web', 'core', 'migrations', file), 'utf8'));
  }
  return {
    db,
    stub: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            // @ts-expect-error node:sqlite приймає біндинги варіативно
            const info = db.prepare(sql).run(...args);
            // Драйн outbox звіряє meta.changes (claim конкурентного драйну).
            return { meta: { changes: Number(info.changes) } };
          },
          all: async () => ({
            // @ts-expect-error те саме
            results: db.prepare(sql).all(...args),
          }),
          first: async () => {
            // @ts-expect-error те саме
            return db.prepare(sql).get(...args) ?? null;
          },
          once: async () => {
            const st = db.prepare(sql);
            // Читання - рядки без changes; RETURNING - і рядки, і changes за
            // їхньою кількістю (саме так його рахує D1); решта - лише changes.
            if (/^\s*(select|with)\b/i.test(sql)) {
              // @ts-expect-error те саме
              return { results: st.all(...args), meta: { changes: 0 } };
            }
            if (/\breturning\b/i.test(sql)) {
              // @ts-expect-error те саме
              const rows = st.all(...args);
              return { results: rows, meta: { changes: rows.length } };
            }
            // @ts-expect-error те саме
            const info = st.run(...args);
            return { results: [], meta: { changes: Number(info.changes) } };
          },
        }),
      }),
      // ⚠️ Кожен рядок несе Й `results`, Й `meta.changes` - як справжня D1
      // (D1Result[]). Доти batch віддавав лише `results`, і код, що рахує
      // записане по `meta.changes`, у тестах бачив нуль, а в проді - правду.
      batch: async (statements: D1Bound[]) => {
        const out = [];
        for (const st of statements) out.push(await st.once());
        return out;
      },
    },
  };
}
