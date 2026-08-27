// Реєстр інструментів internal API (07-schema §4): name -> {args-схема,
// tainting, run}. Router (core/internal/router.mjs) звіряє args зі схемою ДО
// виконання, а після tainting-інструмента ставить sessions.tainted=1 - подвійний
// барʼєр 01 §4.2 починається саме тут, у ядрі.
//
// У PR-6 - лише читання (+ facts.set: запис у ВЛАСНУ D1, не назовні).
// drive.write (T1, запис у Google) свідомо ВІДСУТНІЙ до policy/proposals
// (PR-8): «лише ядро пише назовні, лише після ✅» - без ✅ нема запису.

import {
  runDataRead,
  runCalendarRead,
  runMailSearch,
  runMailRead,
  runDriveSearch,
  runGeoLast,
  runGeoGeocode,
} from './read.mjs';
import { runFactsGet } from './facts.mjs';
import { runMemorySearch } from '../memory.mjs';

/**
 * @typedef {{
 *   args: import('../internal/schemas.mjs').InternalSchema,
 *   tainting?: boolean,
 *   write?: { kind: string },
 *   run: (env: Env, args: any, nowMs: number) => Promise<{ result: unknown }>,
 * }} InternalToolDef
 */

/** @type {Record<string, InternalToolDef>} */
export const TOOLS = {
  'data.read': {
    args: {
      type: 'object',
      required: ['scope'],
      properties: { scope: { type: 'string', maxLength: 32 }, cap: { type: 'number' } },
    },
    run: (env, args, nowMs) => runDataRead(env, args, nowMs),
  },
  'calendar.read': {
    args: {
      type: 'object',
      required: ['days'],
      properties: { days: { type: 'number', minimum: 0, maximum: 7 } },
    },
    run: (env, args, nowMs) => runCalendarRead(env, args, nowMs),
  },
  'mail.search': {
    args: {
      type: 'object',
      required: ['q'],
      properties: { q: { type: 'string', maxLength: 120 } },
    },
    tainting: true,
    run: (env, args) => runMailSearch(env, args),
  },
  'mail.read': {
    args: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', maxLength: 128 } },
    },
    tainting: true,
    run: (env, args) => runMailRead(env, args),
  },
  'drive.search': {
    args: {
      type: 'object',
      required: ['q'],
      properties: { q: { type: 'string', maxLength: 120 } },
    },
    tainting: true,
    run: (env, args) => runDriveSearch(env, args),
  },
  'geo.last': {
    args: { type: 'object' },
    run: (env) => runGeoLast(env),
  },
  'geo.geocode': {
    args: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', maxLength: 200 } },
    },
    run: (env, args) => runGeoGeocode(env, args),
  },
  // ADR-038 (етап 2 PR-2): пошук у згортках власних розмов - НЕ tainting
  // (зовнішнього вмісту тут немає за побудовою: memory_chunks пише лише
  // /internal/session зі згорток мозку).
  'memory.search': {
    args: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', maxLength: 200 },
        limit: { type: 'number', minimum: 1, maximum: 10 },
      },
    },
    run: (env, args) => runMemorySearch(env, args),
  },
  'facts.get': {
    args: {
      type: 'object',
      properties: {
        kind: { type: 'string', maxLength: 32 },
        key: { type: 'string', maxLength: 128 },
      },
    },
    run: (env, args) => runFactsGet(env, args),
  },
  'facts.set': {
    args: {
      type: 'object',
      required: ['kind', 'key', 'value'],
      properties: {
        kind: { type: 'string', maxLength: 32 },
        key: { type: 'string', maxLength: 128 },
        source: { type: 'string', maxLength: 16 },
      },
    },
    // Write-інструмент: виконує НЕ run, а policy (PR-8) - T0 у чистій сесії
    // з «↩», у tainted - пропозиція T1. runFactsSet кличе executor policy.
    write: { kind: 'facts.set' },
    run: () => {
      throw new Error('facts.set виконується через policy, не напряму');
    },
  },
};
