import { useSyncExternalStore } from 'react';

export type Presentation = {
  calm: boolean;
  haptics: boolean;
  learning: boolean;
  newsPreview: boolean;
};
const DEFAULT: Presentation = { calm: false, haptics: true, learning: true, newsPreview: true };
const KEY = 'svitanok:presentation:v1';
let state: Presentation = DEFAULT;
try {
  const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  state = Object.fromEntries(
    Object.entries(DEFAULT).map(([key, value]) => [
      key,
      typeof v?.[key] === 'boolean' ? v[key] : value,
    ]),
  ) as Presentation;
} catch {
  /* Storage can be unavailable. */
}
const listeners = new Set<() => void>();
function apply() {
  document.documentElement.dataset.calm = String(state.calm);
}
if (typeof document !== 'undefined') apply();
export function presentation() {
  return state;
}
export function savePresentation(patch: Partial<Presentation>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* Current session still works. */
  }
  apply();
  listeners.forEach((fn) => fn());
}
export function usePresentation() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
