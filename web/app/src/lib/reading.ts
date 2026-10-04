import { useSyncExternalStore } from 'react';
const KEY = 'svitanok:reading:v1';
let read: string[] = [];
try {
  const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  if (Array.isArray(v)) read = v.filter((v): v is string => typeof v === 'string').slice(-500);
} catch {
  /* Browser storage can be unavailable. */
}
const listeners = new Set<() => void>();
export function markRead(id: string, value = true) {
  read = [...read.filter((v) => v !== id), ...(value ? [id] : [])].slice(-500);
  try {
    localStorage.setItem(KEY, JSON.stringify(read));
  } catch {
    /* Keep this session usable. */
  }
  listeners.forEach((fn) => fn());
}
export function useReading() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => read,
  );
}
