// StateStore — довговічний стан між запусками (state.json, гілка `state` §4.3).
// Захищений парсинг: биття JSON -> фолбек на порожній стан (§8). Втрата
// lastSentDate -> можливий дубль (прийнятно за at-least-once); втрата shownNews
// -> тимчасовий повтор новин (прийнятно).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { StateStore, Logger } from './types.js';

type StateData = Record<string, unknown>;

/** Пруна: мутує дані стану на місці (видаляє старі записи). Реєструються модулями. */
export type Pruner = (data: Record<string, unknown>) => void;

export interface StateStoreOptions {
  path?: string;
  log?: Logger;
  pruners?: Pruner[];
}

export function createStateStore(opts: StateStoreOptions = {}): StateStore {
  const path = opts.path ?? 'state.json';
  const pruners = opts.pruners ?? [];
  let data: StateData = {};

  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') data = parsed as StateData;
    } catch {
      opts.log?.warn('state.json биття — фолбек на порожній стан (§8)');
      data = {};
    }
  }

  let dirty = false;

  return {
    get<T>(key: string): T | undefined {
      return data[key] as T | undefined;
    },
    set<T>(key: string, value: T): void {
      data[key] = value;
      dirty = true;
    },
    // Файловий стор — єдиний писар свого файлу, тож трансформація застосовується
    // одразу й нічим не відрізняється від set. Метод існує заради спільного
    // інтерфейсу з KV-стором, де різниця саме на flush.
    update<T>(key: string, fn: (current: T | undefined) => T): void {
      data[key] = fn(data[key] as T | undefined);
      dirty = true;
    },
    prune(): void {
      if (pruners.length === 0) return;
      for (const p of pruners) p(data);
      dirty = true;
    },
    async flush(): Promise<void> {
      if (!dirty) return;
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      dirty = false;
    },
  };
}
