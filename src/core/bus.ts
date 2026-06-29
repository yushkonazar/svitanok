// RunBus — transient канал producer->consumer У МЕЖАХ одного запуску (§4).
// In-memory, НЕ персиститься й НЕ комітиться (на відміну від StateStore).

import type { RunBus } from './types.js';

export function createRunBus(): RunBus {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      map.set(key, value);
    },
  };
}
