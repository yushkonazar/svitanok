// Простий структурований логер (§3). Рівні: debug/info/warn/error.
// Секрети сюди НЕ потрапляють (URL логуються вже канонізованими, §8/§19.4).

import type { Logger } from './types.js';

export function createLogger(): Logger {
  return {
    debug: (msg, ...args) => console.debug(`[debug] ${msg}`, ...args),
    info: (msg, ...args) => console.log(`[info] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[warn] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[error] ${msg}`, ...args),
  };
}
