import type { StateStore } from '../../src/core/types.js';

/* In-memory StateStore для тестів модулів оркестратора.
 *
 * Вісім файлів мали БАЙТ-У-БАЙТ однакову копію цієї функції. Копії небезпечні
 * не самі по собі: щойно інтерфейс `StateStore` приростає методом, кожна з них
 * мусить приростати теж — і та, що відстала, дає не «помилку компіляції», а
 * тест, який мовчки перевіряє інший стор, ніж сусідній.
 *
 * ⚠️ `update` тут застосовує трансформацію ОДРАЗУ, як і файловий стор. Різниця
 * між `set` і `update` існує лише в KV-сторі й лише на flush (там значення
 * лягає на СВІЖИЙ блоб, а не на прочитаний на початку рану) — і перевіряється
 * вона в `tests/state-kv.test.ts`, де стор справжній.
 */
export function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    update: <T>(k: string, fn: (cur: T | undefined) => T) =>
      void (data[k] = fn(data[k] as T | undefined)),
    prune: () => {},
    flush: async () => {},
  };
}
