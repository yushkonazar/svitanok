// Памʼять «тред чекає слово» (виправлення security-ревʼю етапу 7).
//
// Слово T2 - другий фактор власника, і воно мусить адресувати РІВНО ту
// пропозицію, про яку ядро щойно спитало. Тут перевіряється сам примітив:
// чуже слово не підходить, запис споживається один раз, прострочене вікно
// не діє.

import { describe, it, expect } from 'vitest';
import { rememberT2, takeT2, T2_PENDING_TTL_MS } from '../web/core/policy/t2-word.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const NOW = Date.parse('2026-09-08T09:00:00.000Z');

function makeEnv() {
  const store = new Map<string, string>();
  return { env: workerEnv({ BRIEFING: memoryKv(store) }), store };
}

describe('t2-word', () => {
  it('запамʼятане слово резолвить свою пропозицію', async () => {
    const { env } = makeEnv();
    await rememberT2(env, 'dm', { id: 'p1', word: 'ЗГОДЕН' }, NOW);
    expect(await takeT2(env, 'dm', 'згоден', NOW + 1000)).toBe('p1');
  });

  it('ЧУЖЕ слово не підходить, і запис лишається чекати правильного', async () => {
    const { env } = makeEnv();
    await rememberT2(env, 'dm', { id: 'p1', word: 'ЗГОДЕН' }, NOW);
    expect(await takeT2(env, 'dm', 'ВИКОНАТИ', NOW + 1000)).toBeNull();
    expect(await takeT2(env, 'dm', 'ЗГОДЕН', NOW + 2000)).toBe('p1');
  });

  it('запис споживається РАЗ: другий напис нічого не виконує', async () => {
    const { env } = makeEnv();
    await rememberT2(env, 'dm', { id: 'p1', word: 'ЗГОДЕН' }, NOW);
    expect(await takeT2(env, 'dm', 'ЗГОДЕН', NOW + 1000)).toBe('p1');
    expect(await takeT2(env, 'dm', 'ЗГОДЕН', NOW + 2000)).toBeNull();
  });

  it('після вікна TTL слово вже не діє', async () => {
    const { env } = makeEnv();
    await rememberT2(env, 'dm', { id: 'p1', word: 'ЗГОДЕН' }, NOW);
    expect(await takeT2(env, 'dm', 'ЗГОДЕН', NOW + T2_PENDING_TTL_MS)).toBeNull();
  });

  it('треди не перетинаються; прострочені записи прибираються', async () => {
    const { env, store } = makeEnv();
    await rememberT2(env, 'dm', { id: 'p1', word: 'ЗГОДЕН' }, NOW);
    await rememberT2(env, '99', { id: 'p2', word: 'ВИКОНАТИ' }, NOW + T2_PENDING_TTL_MS + 1);
    // Перший тред прострочений - його запис прибрано разом із записом другого.
    expect(Object.keys(JSON.parse(store.get('t2Pending') ?? '{}'))).toEqual(['99']);
    expect(await takeT2(env, '99', 'ВИКОНАТИ', NOW + T2_PENDING_TTL_MS + 2)).toBe('p2');
  });

  it('битий стан - не виняток, а «нічого не чекали»', async () => {
    const { env, store } = makeEnv();
    store.set('t2Pending', '{зламано');
    expect(await takeT2(env, 'dm', 'ЗГОДЕН', NOW)).toBeNull();
  });
});
