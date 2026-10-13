import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { assertMemoryRecord, memorySemantics } from '../web/core/memory/semantics.mjs';
import {
  runFactsSet,
  runFactsGet,
  runFactsLedger,
  factWriteToken,
} from '../web/core/tools/facts.mjs';
import { executeMemoryCommand, readMemoryWorkspace } from '../web/core/memory/workspace.mjs';
import { listVehicles } from '../web/core/trips/cost.mjs';
const now = Date.parse('2026-10-13T08:00:00Z');
function setup() {
  return workerEnv({
    DB: d1FromSqlite(
      readdirSync('web/core/migrations')
        .filter((f) => f.endsWith('.sql'))
        .sort(),
      { atomicBatch: true },
    ).stub,
  });
}
const record = (type: string, relation: string, subject = 'Приклад') => ({
  schemaVersion: 2,
  type,
  domain: 'transport',
  subject,
  relation,
});
describe('structured personal memory', () => {
  it('rejects incompatible meanings, unknown versions and guessed vehicle properties', () => {
    expect(() => assertMemoryRecord(record('aspiration', 'owns'))).toThrow();
    expect(() =>
      assertMemoryRecord({
        ...record('resource', 'family'),
        properties: { inspectionPassed: true },
      }),
    ).toThrow();
    expect(() =>
      assertMemoryRecord({ ...record('resource', 'family'), schemaVersion: 3 }),
    ).toThrow();
    expect(memorySemantics('vehicle', 'car', 'Приклад')).toMatchObject({
      needsReview: true,
      type: 'fact',
    });
    expect(memorySemantics('setting', 'test_word', 'Приклад')).toMatchObject({ type: 'technical' });
  });
  it('reclassifies in place, keeps ledger history, and blocks a stale second edit', async () => {
    const env = setup();
    await runFactsSet(env, { kind: 'habit', key: 'dish', value: 'Салат у ресторані Приклад' }, now);
    const token = await factWriteToken(env, { kind: 'habit', key: 'dish' });
    const value = {
      schemaVersion: 2,
      type: 'preference',
      domain: 'food',
      subject: 'Салат у ресторані Приклад',
      relation: 'likes',
    };
    await executeMemoryCommand(
      env,
      { type: 'update', id: 'habit:dish', value, token, renew: true },
      now + 1000,
    );
    const current = (await runFactsGet(env, { kind: 'habit' })).result;
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      source: 'owner_assertion',
      semantics: { type: 'preference', structured: true },
    });
    expect((await runFactsLedger(env, { kind: 'habit', key: 'dish' })).result).toHaveLength(2);
    await expect(
      executeMemoryCommand(
        env,
        {
          type: 'update',
          id: 'habit:dish',
          value: { ...value, relation: 'dislikes' },
          token,
          renew: true,
        },
        now + 2000,
      ),
    ).rejects.toThrow(/уже змінився/);
    expect(
      (await readMemoryWorkspace(env, now + 3000, 0, { group: 'preference', search: 'САЛАТ' }))
        .entries,
    ).toHaveLength(1);
    expect(
      (await readMemoryWorkspace(env, now + 3000, 0, { group: 'resource', search: '' })).entries,
    ).toHaveLength(0);
  });
  it('only offers confirmed available resources for travel, never aspirations or hypotheses', async () => {
    const env = setup();
    await runFactsSet(
      env,
      { kind: 'vehicle', key: 'dream', value: record('aspiration', 'wants', 'Модель мрії') },
      now,
      { actor: 'owner' },
    );
    await runFactsSet(
      env,
      { kind: 'vehicle', key: 'family', value: record('resource', 'family', 'Сімейне авто') },
      now,
      { actor: 'owner' },
    );
    await runFactsSet(
      env,
      { kind: 'vehicle', key: 'guess', value: record('resource', 'owns', 'Припущення') },
      now,
    );
    expect(await listVehicles(env)).toEqual([
      { key: 'family', name: 'Сімейне авто · сімейне авто', per100: null, fuel: null },
    ]);
  });
});
