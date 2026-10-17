import type { LeisureCommand } from '../../api/leisure.ts';

const KEY = 'svitanok-leisure-pending-v1';
// The original command survives a page reload until an acknowledgement arrives.
// Session storage contains no token and is cleared on success or known rejection.
export function readPendingLeisure(): LeisureCommand | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    return value &&
      typeof value.op === 'string' &&
      typeof value.commandId === 'string' &&
      value.commandId.length >= 8 &&
      value.payload &&
      typeof value.payload === 'object' &&
      !Array.isArray(value.payload) &&
      (value.id == null || typeof value.id === 'string')
      ? value
      : null;
  } catch {
    return null;
  }
}
export function keepPendingLeisure(command: LeisureCommand | null) {
  try {
    if (command) sessionStorage.setItem(KEY, JSON.stringify(command));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* Storage can be unavailable; the in-memory command still works. */
  }
}
