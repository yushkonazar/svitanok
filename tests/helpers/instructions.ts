// Сід інструкцій для тестів, що ганяють прогони: без рядка в D1
// startClaimedRun чесно відмовляється (PR-5), тож кожен такий тест мусить
// покласти persona і quick - рівно те, що в проді робить sync-instructions.
//
// Хеш синхронний (ядро рахує через crypto.subtle, тобто async): інакше сід
// тягнув би await у два десятки місць. Парність із ядром перевіряє
// tests/instructions.test.ts.

import { DatabaseSync } from 'node:sqlite';
import { instructionHash as syncInstructionHash } from '../../brain/src/instructions.js';
import { d1FromSqlite, type D1Stub } from './d1.js';

export const TEST_PERSONA = 'Ти - Світанок, секретар власника. Коротко, українською.';
export const TEST_QUICK = 'Ти - швидка смуга. Тривіальне - одним рядком.';

// Синхронний хеш беремо з МОЗКУ (node:crypto), а не пишемо третій: він уже
// синхронний, уже в парності з ядром і вже імпортується тестами (ревʼю PR-5).
export { syncInstructionHash };

/** Покласти persona і quick із коректними хешами (потрібна міграція 0007). */
export function seedInstructions(db: DatabaseSync): void {
  for (const [name, kind, body] of [
    ['persona', 'persona', TEST_PERSONA],
    ['quick', 'agent', TEST_QUICK],
  ] as const) {
    db.prepare(
      `INSERT INTO instructions (name, kind, version_hash, body_md, max_chars, deployed_at)
       VALUES (?, ?, ?, ?, 9000, '2026-08-28T00:00:00Z')
       ON CONFLICT (name) DO UPDATE SET version_hash = excluded.version_hash, body_md = excluded.body_md`,
    ).run(name, kind, syncInstructionHash(body), body);
  }
}

/**
 * D1 для тестів прогонів: задані міграції + `instructions` + сід персони.
 * @param migrations - без 0007, він додається сам
 */
export function d1WithInstructions(migrations: string[]): D1Stub {
  const d1 = d1FromSqlite([...migrations, '0007_instructions_plans.sql']);
  seedInstructions(d1.db);
  return d1;
}
