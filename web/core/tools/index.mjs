// Реєстр інструментів internal API (07-schema §4): name -> {args-схема,
// tainting, run}. Router (core/internal/router.mjs) звіряє args зі схемою ДО
// виконання, а після tainting-інструмента ставить sessions.tainted (epoch-ms
// читання, діє TAINT_TTL_MS) - подвійний
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
import { runPlacesSearch, runPlacesDetails, runRoutesEta } from './places.mjs';
import { runWishesList, runWishesSearch } from './wishes.mjs';
import { runRunsQuery } from './runs.mjs';
import { runIdeasList, runIdeasSearch } from './ideas.mjs';
import { runCollectionsList, runRecordsList, runRecordsSearch } from './collections.mjs';
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
      properties: {
        scope: { type: 'string', maxLength: 32 },
        cap: { type: 'number' },
        // period (07 §4: «30d», «12w») - звужує сирі серії у weekly (етап 3).
        period: { type: 'string', maxLength: 16 },
      },
    },
    run: (env, args, nowMs) => runDataRead(env, args, nowMs),
  },
  // runs.query (етап 3 PR-2): телеметрія власних прогонів + квоти місяця -
  // блок СИСТЕМА тижневого звіту. Власні таблиці ядра, не tainting.
  'runs.query': {
    args: {
      type: 'object',
      properties: { period: { type: 'string', maxLength: 16 } },
    },
    run: (env, args, nowMs) => runRunsQuery(env, args, nowMs),
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
    run: (env, _args, nowMs) => runGeoLast(env, nowMs),
  },
  'geo.geocode': {
    args: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', maxLength: 200 } },
    },
    run: (env, args, nowMs) => runGeoGeocode(env, args, nowMs),
  },
  // Google Maps (етап 5 PR-1, ADR-011): заклади - зовнішній текст (tainting),
  // маршрут - числа. Квоти рахує адаптер; 100 % - чесна відмова/кеш (S-1-14).
  'places.search': {
    args: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120 },
        city: { type: 'string', maxLength: 60 },
        near: {
          type: 'object',
          required: ['lat', 'lon'],
          properties: { lat: { type: 'number' }, lon: { type: 'number' } },
        },
        limit: { type: 'number', minimum: 1, maximum: 8 },
      },
    },
    tainting: true,
    run: (env, args, nowMs) => runPlacesSearch(env, args, nowMs),
  },
  'places.details': {
    args: {
      type: 'object',
      required: ['place_id'],
      properties: { place_id: { type: 'string', minLength: 1, maxLength: 300 } },
    },
    tainting: true,
    run: (env, args, nowMs) => runPlacesDetails(env, args, nowMs),
  },
  'routes.eta': {
    args: {
      type: 'object',
      required: ['from', 'to', 'mode'],
      properties: {
        from: { type: 'string', minLength: 1, maxLength: 300 },
        to: { type: 'string', minLength: 1, maxLength: 300 },
        mode: { type: 'string', minLength: 3, maxLength: 8 },
        depart_at: { type: 'string', maxLength: 40 },
      },
    },
    run: (env, args, nowMs) => runRoutesEta(env, args, nowMs),
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
  // chain.start / chain.cancel (07 §4, етап 5): T0 через policy; виконавці -
  // chains/table.mjs (table), chains/price.mjs (price), chains/trip.mjs (trip).
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
  'chain.cancel': {
    args: {
      type: 'object',
      properties: {
        chain_id: { type: 'string', maxLength: 64 },
        kind: { type: 'string', maxLength: 32 },
        trip_id: { type: 'string', maxLength: 120 },
      },
    },
    write: { kind: 'chain.cancel' },
    run: () => {
      throw new Error('chain.cancel виконується через policy, не напряму');
    },
  },
  // Ідеї (етап 3 PR-4, 07 §4 `ideas.*`): list/search - читання власної бази;
  // create/update/analyze - T0 через policy («↩»), delete - T1. Номер ідеї
  // для власника - `number` з лічильника («ідея #12», міграція 0011); id
  // приймає і номер, і ulid.
  'ideas.list': {
    args: {
      type: 'object',
      properties: {
        domain: { type: 'string', maxLength: 16 },
        status: { type: 'string', maxLength: 16 },
        limit: { type: 'number', minimum: 1, maximum: 10 },
      },
    },
    run: (env, args) => runIdeasList(env, args),
  },
  'ideas.search': {
    args: {
      type: 'object',
      required: ['q'],
      properties: { q: { type: 'string', minLength: 2, maxLength: 120 } },
    },
    run: (env, args) => runIdeasSearch(env, args),
  },
  'ideas.create': {
    args: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        body_md: { type: 'string', maxLength: 20_000 },
        domain: { type: 'string', maxLength: 16 },
        priority: { type: 'number', minimum: 1, maximum: 3 },
        effort: { type: 'string', maxLength: 1 },
        tags: { type: 'array', items: { type: 'string', maxLength: 32 } },
        next_action: { type: 'string', maxLength: 300 },
      },
    },
    write: { kind: 'ideas.create' },
    run: () => {
      throw new Error('ideas.create виконується через policy, не напряму');
    },
  },
  'ideas.update': {
    args: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', maxLength: 64 },
        title: { type: 'string', maxLength: 200 },
        body_md: { type: 'string', maxLength: 20_000 },
        domain: { type: 'string', maxLength: 16 },
        status: { type: 'string', maxLength: 16 },
        priority: { type: 'number', minimum: 1, maximum: 3 },
        effort: { type: 'string', maxLength: 1 },
        next_action: { type: 'string', maxLength: 300 },
        tags: { type: 'array', items: { type: 'string', maxLength: 32 } },
        analysis_md: { type: 'string', maxLength: 20_000 },
        plan_md: { type: 'string', maxLength: 20_000 },
      },
    },
    write: { kind: 'ideas.update' },
    run: () => {
      throw new Error('ideas.update виконується через policy, не напряму');
    },
  },
  'ideas.analyze': {
    args: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', maxLength: 64 },
        mode: { type: 'string', maxLength: 8 },
        // mode=code (етап 4): репо з переліку і force - повторний прогін попри кеш.
        repo: { type: 'string', maxLength: 32 },
        force: { type: 'boolean' },
      },
    },
    write: { kind: 'ideas.analyze' },
    run: () => {
      throw new Error('ideas.analyze виконується через policy, не напряму');
    },
  },
  'ideas.delete': {
    args: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', maxLength: 64 } },
    },
    write: { kind: 'ideas.delete' },
    run: () => {
      throw new Error('ideas.delete виконується через policy, не напряму');
    },
  },
  // Колекції (етап 3 PR-5, 07 §2/§4): list/search - читання; create/update -
  // T0 з «↩»; records.delete - T1; видалення колекції з записами - T2 через
  // forget (collections.delete = той самий kind, той самий шлях зі словом).
  // Фільтр records.list - структурний, компілює ядро (модель SQL не пише).
  'collections.list': {
    args: { type: 'object' },
    run: (env) => runCollectionsList(env),
  },
  'collections.create': {
    args: {
      type: 'object',
      required: ['name', 'fields'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        description: { type: 'string', maxLength: 500 },
        fields: { type: 'array', items: { type: 'object' } },
        sort_by: { type: 'string', maxLength: 64 },
      },
    },
    write: { kind: 'collections.create' },
    run: () => {
      throw new Error('collections.create виконується через policy, не напряму');
    },
  },
  'collections.update': {
    args: {
      type: 'object',
      required: ['collection'],
      properties: {
        collection: { type: 'string', maxLength: 64 },
        name: { type: 'string', maxLength: 64 },
        description: { type: 'string', maxLength: 500 },
        fields: { type: 'array', items: { type: 'object' } },
        sort_by: { type: 'string', maxLength: 64 },
      },
    },
    write: { kind: 'collections.update' },
    run: () => {
      throw new Error('collections.update виконується через policy, не напряму');
    },
  },
  'collections.delete': {
    args: {
      type: 'object',
      required: ['collection'],
      properties: { collection: { type: 'string', maxLength: 64 } },
    },
    write: { kind: 'forget' },
    run: () => {
      throw new Error('collections.delete виконується через policy (forget, T2), не напряму');
    },
  },
  'records.create': {
    args: {
      type: 'object',
      required: ['collection', 'data'],
      properties: {
        collection: { type: 'string', maxLength: 64 },
        data: { type: 'object' },
      },
    },
    write: { kind: 'records.create' },
    run: () => {
      throw new Error('records.create виконується через policy, не напряму');
    },
  },
  'records.update': {
    args: {
      type: 'object',
      required: ['collection', 'id', 'data'],
      properties: {
        collection: { type: 'string', maxLength: 64 },
        id: { type: 'string', maxLength: 64 },
        data: { type: 'object' },
      },
    },
    write: { kind: 'records.update' },
    run: () => {
      throw new Error('records.update виконується через policy, не напряму');
    },
  },
  'records.list': {
    args: {
      type: 'object',
      required: ['collection'],
      properties: {
        collection: { type: 'string', maxLength: 64 },
        where: { type: 'array', items: { type: 'object' } },
        sort: { type: 'string', maxLength: 64 },
        desc: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    run: (env, args) => runRecordsList(env, args),
  },
  'records.search': {
    args: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', minLength: 2, maxLength: 120 },
        collection: { type: 'string', maxLength: 64 },
      },
    },
    run: (env, args) => runRecordsSearch(env, args),
  },
  'records.delete': {
    args: {
      type: 'object',
      required: ['collection', 'id'],
      properties: {
        collection: { type: 'string', maxLength: 64 },
        id: { type: 'string', maxLength: 64 },
      },
    },
    write: { kind: 'records.delete' },
    run: () => {
      throw new Error('records.delete виконується через policy, не напряму');
    },
  },
  // План дня v2 (етап 3 PR-8, 07 §4 plan.*): усі write через policy (T0),
  // розкладку рахує ядро.
  'plan.intent': {
    args: {
      type: 'object',
      required: ['items'],
      properties: {
        date: { type: 'string', maxLength: 16 },
        items: { type: 'array', items: { type: 'object' } },
      },
    },
    write: { kind: 'plan.intent' },
    run: () => {
      throw new Error('plan.intent виконується через policy, не напряму');
    },
  },
  'plan.draft': {
    args: { type: 'object', properties: { date: { type: 'string', maxLength: 16 } } },
    write: { kind: 'plan.draft' },
    run: () => {
      throw new Error('plan.draft виконується через policy, не напряму');
    },
  },
  'plan.accept': {
    args: {
      type: 'object',
      properties: { date: { type: 'string', maxLength: 16 }, calendar: { type: 'boolean' } },
    },
    write: { kind: 'plan.accept' },
    run: () => {
      throw new Error('plan.accept виконується через policy, не напряму');
    },
  },
  'plan.update': {
    args: {
      type: 'object',
      properties: {
        date: { type: 'string', maxLength: 16 },
        done: { type: 'array', items: { type: 'string', maxLength: 80 } },
        moves: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'to'],
            properties: {
              id: { type: 'string', maxLength: 80 },
              to: { type: 'string', maxLength: 5 },
            },
          },
        },
        drop: { type: 'array', items: { type: 'string', maxLength: 80 } },
      },
    },
    write: { kind: 'plan.update' },
    run: () => {
      throw new Error('plan.update виконується через policy, не напряму');
    },
  },
  'plan.review': {
    args: {
      type: 'object',
      properties: {
        date: { type: 'string', maxLength: 16 },
        // id/назви пунктів для переносу; ["all"] - усі відкриті.
        carry: { type: 'array', items: { type: 'string', maxLength: 80 } },
      },
    },
    write: { kind: 'plan.review' },
    run: () => {
      throw new Error('plan.review виконується через policy, не напряму');
    },
  },
  // Бажання (етап 5 PR-3, 07 §4 wishes.*): list/search - читання; create/update
  // - T0 з «↩»; delete - T1. Ціни - в основних одиницях (3 299), код множить.
  'wishes.list': {
    args: {
      type: 'object',
      properties: {
        type: { type: 'string', maxLength: 16 },
        status: { type: 'string', maxLength: 16 },
        limit: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    run: (env, args) => runWishesList(env, args),
  },
  'wishes.search': {
    args: {
      type: 'object',
      required: ['q'],
      properties: { q: { type: 'string', minLength: 2, maxLength: 120 } },
    },
    run: (env, args) => runWishesSearch(env, args),
  },
  'wishes.create': {
    args: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        type: { type: 'string', maxLength: 16 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        url: { type: 'string', maxLength: 500 },
        target_price: { type: 'number', minimum: 0 },
        currency: { type: 'string', maxLength: 3 },
        steam_appid: { type: 'number', minimum: 1 },
      },
    },
    write: { kind: 'wishes.create' },
    run: () => {
      throw new Error('wishes.create виконується через policy, не напряму');
    },
  },
  // S-5-2: імпорт публічного wishlist Steam. steam_id - або з аргументів,
  // або з facts.setting.steam_id; повтор нічого не дублює.
  'wishes.import': {
    args: {
      type: 'object',
      properties: {
        source: { type: 'string', maxLength: 16 },
        steam_id: { type: 'string', maxLength: 20 },
        limit: { type: 'number', minimum: 1, maximum: 200 },
      },
    },
    write: { kind: 'wishes.import' },
    // Результат несе назви ігор зі Steam - це зовнішній вміст, тож тред
    // позначається (роутер робить це і на write-шляху).
    tainting: true,
    run: () => {
      throw new Error('wishes.import виконується через policy, не напряму');
    },
  },
  'wishes.update': {
    args: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', maxLength: 200 },
        title: { type: 'string', maxLength: 200 },
        url: { type: 'string', maxLength: 500 },
        target_price: { type: 'number', minimum: 0 },
        currency: { type: 'string', maxLength: 3 },
        status: { type: 'string', maxLength: 16 },
      },
    },
    write: { kind: 'wishes.update' },
    run: () => {
      throw new Error('wishes.update виконується через policy, не напряму');
    },
  },
  'wishes.delete': {
    args: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', maxLength: 200 } },
    },
    write: { kind: 'wishes.delete' },
    run: () => {
      throw new Error('wishes.delete виконується через policy, не напряму');
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
