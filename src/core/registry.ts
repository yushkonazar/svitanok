// Реєстр модулів (§3, §5). kind керує порядком ВИКОНАННЯ (producers перші);
// priority — порядком ВІДОБРАЖЕННЯ (у render). Дві різні осі.

import type { Module } from './types.js';

export interface Partitioned<C> {
  producers: Module<C>[];
  consumers: Module<C>[];
}

/** Розділити модулі на producers/consumers, зберігаючи вхідний порядок. */
export function partitionModules<C>(modules: Module<C>[]): Partitioned<C> {
  return {
    producers: modules.filter((m) => m.kind === 'producer'),
    consumers: modules.filter((m) => m.kind === 'consumer'),
  };
}
