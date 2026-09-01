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
 *   write?: { kind?: string, kindFrom?: string },
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
      // minLength: порожній q підставляв дефолт «вхідні за тиждень», і на
      // «знайди лист від Steam» власник діставав список свіжих розсилок -
      // тиха підміна пошуку переглядом (приймання 01.09). Тепер це чесна
      // помилка контракту, і модель мусить сказати, ЩО шукає.
      properties: { q: { type: 'string', minLength: 2, maxLength: 120 } },
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
  // Нагадування (PR-6). Час приходить ПРИРОДНИМ текстом: рахує його parser
  // ядра, не модель - інакше вона сама переводила б київські години й
  // помилялася тихо. Усі три - write, тобто йдуть через policy.
  'reminders.create': {
    args: {
      type: 'object',
      required: ['when'],
      properties: {
        when: { type: 'string', maxLength: 120 },
        text: { type: 'string', maxLength: 200 },
      },
    },
    write: { kind: 'reminders.create' },
    run: () => {
      throw new Error('reminders.create виконується через policy, не напряму');
    },
  },
  'reminders.update': {
    args: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', maxLength: 64 },
        when: { type: 'string', maxLength: 120 },
        text: { type: 'string', maxLength: 200 },
      },
    },
    write: { kind: 'reminders.update' },
    run: () => {
      throw new Error('reminders.update виконується через policy, не напряму');
    },
  },
  'reminders.cancel': {
    args: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', maxLength: 64 } },
    },
    write: { kind: 'reminders.cancel' },
    run: () => {
      throw new Error('reminders.cancel виконується через policy, не напряму');
    },
  },
  // record (PR-6): чотири види локальних записів одним інструментом. Слот
  // чек-іна і позиції у списках рахує КОД - модель дає лише kind і payload.
  record: {
    args: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', maxLength: 16 },
        payload: { type: 'object' },
      },
    },
    write: { kind: 'record' },
    run: () => {
      throw new Error('record виконується через policy, не напряму');
    },
  },
  // proposals.create (07 §4): єдиний шлях запису НАЗОВНІ - календар, контакти,
  // Drive, Tasks, налаштування, експорт. Сам інструмент дією не є: він
  // просить policy створити пропозицію на дію `kind`, і рівень (T1/T2) бере
  // ACTION_LEVELS саме за ним. Виконавців для цих kind-ів ще немає (адаптери
  // Google - пізніші етапи), тож після ✅ власник дістане чесне «виконавця ще
  // немає», а не тишу.
  'proposals.create': {
    args: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', maxLength: 32 },
        payload: { type: 'object' },
      },
    },
    write: { kindFrom: 'kind' },
    run: () => {
      throw new Error('proposals.create виконується через policy, не напряму');
    },
  },
  // chain.start - ЗАГЛУШКА до етапу 5 (Workflows). Інструмент присутній, щоб
  // модель знала межу («ланцюг почнеться пізніше»), а не вигадувала обхід;
  // виконавця немає навмисно, тож policy відповість no-executor.
  'chain.start': {
    args: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', maxLength: 32 },
        payload: { type: 'object' },
      },
    },
    write: { kind: 'chain.start' },
    run: () => {
      throw new Error('chain.start виконується через policy, не напряму');
    },
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
