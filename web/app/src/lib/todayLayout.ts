import { useSyncExternalStore } from 'react';

export const TODAY_BLOCKS = [
  { id: 'weather', label: 'Погода' },
  { id: 'currency', label: 'Валюти' },
  { id: 'fact', label: 'Факт дня' },
  { id: 'stoic', label: 'Цитата дня' },
  { id: 'onthisday', label: 'День на мапі історії' },
] as const;
export type TodayBlockId = (typeof TODAY_BLOCKS)[number]['id'];
export const DEFAULT_TODAY_ORDER = TODAY_BLOCKS.map((block) => block.id);
const KEY = 'svitanok:today-order:v1';

/** Keep a complete permutation when old, partial or damaged preferences are restored. */
export function normalizeTodayOrder(value: unknown): TodayBlockId[] {
  const known = (id: unknown): id is TodayBlockId =>
    DEFAULT_TODAY_ORDER.includes(id as TodayBlockId);
  return [
    ...new Set([...(Array.isArray(value) ? value.filter(known) : []), ...DEFAULT_TODAY_ORDER]),
  ];
}
function readOrder() {
  try {
    return normalizeTodayOrder(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return [...DEFAULT_TODAY_ORDER];
  }
}
let order = readOrder();
const listeners = new Set<() => void>();
function publish(next: TodayBlockId[]) {
  if (next.join() === order.join()) return;
  order = next;
  listeners.forEach((fn) => fn());
}
export function saveTodayOrder(value: readonly TodayBlockId[]) {
  const next = normalizeTodayOrder(value);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* The order still works for this session. */
  }
  publish(next);
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) publish(readOrder());
  });
export function useTodayOrder() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => order,
  );
}
