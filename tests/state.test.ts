import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../src/core/state.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'svitanok-state-'));
  path = join(dir, 'state.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('state — персист між запусками', () => {
  it('set/flush пише, новий store читає', async () => {
    const s1 = createStateStore({ path });
    s1.set('lastSentDate', '2026-06-29');
    await s1.flush();

    const s2 = createStateStore({ path });
    expect(s2.get<string>('lastSentDate')).toBe('2026-06-29');
  });

  it('flush без змін не падає', async () => {
    const s = createStateStore({ path });
    await expect(s.flush()).resolves.toBeUndefined();
  });
});

describe('state — захищений парсинг (§8)', () => {
  it('биття JSON -> порожній стан, не виняток', () => {
    writeFileSync(path, '{ broken json ', 'utf8');
    const s = createStateStore({ path });
    expect(s.get('lastSentDate')).toBeUndefined();
  });

  it('відсутній файл -> порожній стан', () => {
    const s = createStateStore({ path: join(dir, 'nope.json') });
    expect(s.get('x')).toBeUndefined();
  });
});

describe('state — prune', () => {
  it('запускає зареєстровані pruner-и', async () => {
    const prune = (data: Record<string, unknown>) => {
      delete data['old'];
    };
    const s = createStateStore({ path, pruners: [prune] });
    s.set('old', 1);
    s.set('keep', 2);
    s.prune();
    await s.flush();

    const s2 = createStateStore({ path });
    expect(s2.get('old')).toBeUndefined();
    expect(s2.get('keep')).toBe(2);
  });
});
