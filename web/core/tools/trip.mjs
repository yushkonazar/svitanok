// Адаптивна анкета поїздки. Чернетка живе окремо від TripChain: бриф не
// бронює, не змінює календар і не запускає супровід без вибору власника.

import { TRIP_MODES, TRIP_PURPOSES } from '../chains/trip.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
import { listVehicles, fuelPrice } from '../trips/cost.mjs';
import { runFactsGet } from './facts.mjs';
import { tripBriefCard, TRIP_FIELD_LABELS } from './trip-card.mjs';
import { tripExpenseSummary } from './trip-expenses.mjs';
import { tripWorkspaceView } from './trip-workspace.mjs';
import { tripZone, tripLocalParts } from '../trips/time.mjs';
import { enrichTripGeography } from '../trips/geography.mjs';

const DRAFT_TTL_MS = 365 * 86_400_000;
/** Registry uses 'dm', Telegram callbacks use null for the same private chat.
 * @param {{chatId?:number|string|null,threadId?:number|string|null}} ctx */
export function tripScopeKey(ctx) {
  return ctx.chatId == null
    ? null
    : `${ctx.chatId}:${ctx.threadId == null || ctx.threadId === 'dm' ? '' : ctx.threadId}`;
}
const QUESTION_LIMIT = 4;
const MODES = [...TRIP_MODES, 'compare'];
/** @type {Record<string, string[]>} */
const ENUMS = {
  mode: MODES,
  return_type: ['round_trip', 'one_way', 'undecided'],
  budget_type: ['limit', 'flexible', 'no_limit'],
  lodging_needed: ['yes', 'no', 'undecided'],
  ticket_status: ['booked', 'not_booked', 'undecided'],
  return_meaning: ['home_arrival', 'destination_departure', 'undecided'],
  budget_scope: ['person', 'transport_group', 'whole_group'],
  travel_pace: ['relaxed', 'balanced', 'busy'],
  support_level: ['plan', 'reminders', 'companion'],
  lodging_layout: ['apartment', 'separate_rooms', 'shared_room', 'undecided'],
};
/** @type {Record<string, number>} */
const TEXT_FIELDS = {
  to: 120,
  from_city: 80,
  country: 80,
  purpose: 120,
  participants: 160,
  depart_at: 60,
  vehicle_key: 64,
  vehicle_description: 120,
  departure_window: 100,
  return_window: 100,
  departure_airport: 100,
  arrival_airport: 100,
  baggage: 120,
  route_profile: 160,
  legs: 300,
  budget_currency: 8,
  interests: 300,
  constraints: 300,
  trip_priorities: 200,
  lodging_preference: 160,
  arrival_window: 100,
  citizenship: 120,
  documents_status: 160,
  parking_preference: 120,
  flight_transfers: 120,
  equipment: 160,
  food_preference: 160,
  travel_pace: 120,
  timezone: 80,
  departure_timezone: 80,
  country_code: 2,
  destination_choice: 20,
  origin_choice: 20,
  home_preparation: 300,
  connectivity: 200,
  accessibility: 250,
  pets: 200,
  driving_preferences: 250,
  transit_countries: 200,
};
/** @type {Record<string,number>} */
const COUNT_FIELDS = {
  transport_count: 100,
  destination_count: 100,
  lodging_count: 100,
  return_count: 100,
  lodging_rooms: 50,
  children_count: 50,
  walking_minutes: 720,
};
const DATE_FIELDS = ['date_from', 'date_to', 'arrival_date', 'lodging_from', 'lodging_to'];

/** @param {unknown} value */
function validDate(value) {
  const date = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? date : null;
}

/** Прибираємо невідомі поля й не зберігаємо вільний текст без обмеження. @param {any} patch */
export function normalizeTripAnswers(patch) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const [field, raw] of Object.entries(patch)) {
    if (raw === null) {
      if (
        field in TEXT_FIELDS ||
        field in ENUMS ||
        [
          ...DATE_FIELDS,
          ...Object.keys(COUNT_FIELDS),
          'international',
          'budget_total',
          'optional_skipped',
        ].includes(field)
      )
        out[field] = null;
      continue;
    }
    if (
      field in COUNT_FIELDS &&
      Number.isInteger(raw) &&
      raw >= (field === 'children_count' ? 0 : 1) &&
      raw <= (COUNT_FIELDS[field] ?? 0)
    ) {
      out[field] = raw;
    } else if (field in ENUMS && ENUMS[field]?.includes(raw)) {
      out[field] = raw;
    } else if (field in TEXT_FIELDS && typeof raw === 'string') {
      const value = raw.trim().slice(0, TEXT_FIELDS[field] ?? 0);
      if (value && (field === 'timezone' || field === 'departure_timezone')) tripZone(value);
      if (value) out[field] = value;
    } else if (DATE_FIELDS.includes(field)) {
      const date = validDate(raw);
      if (date) out[field] = date;
    } else if (field === 'international' && typeof raw === 'boolean') {
      out[field] = raw;
    } else if (field === 'optional_skipped' && typeof raw === 'boolean') {
      out[field] = raw;
    } else if (
      field === 'budget_total' &&
      typeof raw === 'number' &&
      Number.isFinite(raw) &&
      raw > 0 &&
      raw <= 100_000_000
    ) {
      out[field] = Math.round(raw);
    }
  }
  return out;
}

/** @param {any} args */
function answerPatch(args) {
  // Старі виклики {to,date_from,purpose} залишаються чинними.
  const raw = {
    ...Object.fromEntries(
      ['to', 'date_from', 'purpose']
        .filter((key) => Object.hasOwn(args, key))
        .map((key) => [key, args[key]]),
    ),
    ...(args.answers && typeof args.answers === 'object' ? args.answers : {}),
  };
  const patch = normalizeTripAnswers(raw);
  for (const [key, value] of Object.entries(raw)) {
    if (
      value != null &&
      (key in TEXT_FIELDS ||
        key in ENUMS ||
        [...DATE_FIELDS, ...Object.keys(COUNT_FIELDS), 'international', 'budget_total'].includes(
          key,
        )) &&
      !Object.hasOwn(patch, key)
    ) {
      throw new Error(
        'Одна з деталей поїздки некоректна. Уточни дату, суму або обраний варіант — попередні дані не змінював.',
      );
    }
  }
  return patch;
}

/** @param {Env} env @param {string} scope @param {string | null} requestedId @param {string | null} to @param {number} nowMs */
export async function loadDraft(env, scope, requestedId, to, nowMs) {
  const database = env.DB;
  if (!database) throw new Error('Сховище чернеток поїздок недоступне');
  const cutoff = new Date(nowMs - DRAFT_TTL_MS).toISOString();
  if (requestedId) {
    const row = await database
      .prepare(
        "SELECT * FROM trip_briefs WHERE id = ? AND scope_key = ? AND status IN ('draft','paused','started') AND updated_at >= ?",
      )
      .bind(requestedId, scope, cutoff)
      .first();
    if (!row) throw new Error('Чернетку поїздки не знайдено в цьому чаті або вона застаріла');
    return row;
  }
  const { results } = await database
    .prepare(
      "SELECT * FROM trip_briefs WHERE scope_key = ? AND (status = 'draft' OR (? = 1 AND status = 'paused')) AND updated_at >= ? ORDER BY updated_at DESC LIMIT 100",
    )
    .bind(scope, to ? 1 : 0, cutoff)
    .all();
  if (!to) return results?.[0] ?? null;
  return (
    (results ?? []).find(
      (candidate) =>
        String(JSON.parse(String(candidate.answers_json ?? '{}')).to ?? '').toLocaleLowerCase(
          'uk',
        ) === to.toLocaleLowerCase('uk'),
    ) ?? null
  );
}

/** @param {Env} env @param {any} row @param {string} scope @param {Record<string, any>} answers @param {number} nowMs */
async function saveDraft(env, row, scope, answers, nowMs) {
  const database = env.DB;
  if (!database) throw new Error('Сховище чернеток поїздок недоступне');
  const at = new Date(nowMs).toISOString();
  const serialized = JSON.stringify(answers);
  if (row) {
    const changes = await database.batch([
      database
        .prepare(
          "UPDATE trip_briefs SET answers_json = ?, updated_at = ?,status='draft' WHERE id = ? AND scope_key = ? AND answers_json = ?",
        )
        .bind(serialized, at, row.id, scope, row.answers_json),
      database
        .prepare(
          "UPDATE trip_briefs SET status='paused' WHERE scope_key=? AND id<>? AND status='draft' AND EXISTS(SELECT 1 FROM trip_briefs current WHERE current.id=? AND current.answers_json=?)",
        )
        .bind(scope, row.id, row.id, serialized),
    ]);
    if (Number(changes[0]?.meta?.changes ?? 0) !== 1)
      throw new Error('Бриф змінився паралельно — повтори останню відповідь');
    return String(row.id);
  }
  const id = crypto.randomUUID();
  await database.batch([
    database
      .prepare(
        "INSERT INTO trip_briefs (id, scope_key, answers_json, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)",
      )
      .bind(id, scope, serialized, at, at),
    database
      .prepare(
        "UPDATE trip_briefs SET status='paused' WHERE scope_key=? AND id<>? AND status='draft'",
      )
      .bind(scope, id),
  ]);
  return id;
}

/** @param {Record<string, any>} a @param {{known:boolean,city:string|null}} home @param {any[]} vehicles @param {number} nowMs */
export function tripQuestions(a, home, vehicles, nowMs) {
  /** @type {{field:string,question:string,options?:string[],default?:string,optional?:boolean}[]} */
  const ask = [];
  /** @param {string} field @param {string} question @param {string[] | undefined} options @param {boolean} optional */
  const add = (field, question, options = undefined, optional = false) => {
    if (a[field] == null && !(a._skipped ?? []).includes(field) && ask.length < QUESTION_LIMIT)
      ask.push({
        field,
        question,
        ...(options && a._free_field !== field ? { options } : {}),
        ...(optional ? { optional: true } : {}),
      });
  };
  const today = kyivDateKey(new Date(nowMs));
  for (const [geoKey, field] of /** @type {[string,string][]} */ ([
    ['destination', 'destination_choice'],
    ['origin', 'origin_choice'],
  ])) {
    const geo = a._geo?.[geoKey];
    if (geo?.status === 'ambiguous')
      return {
        phase: 'scope',
        ask: [
          {
            field,
            question: 'Яке саме місто маєш на увазі?',
            optional: false,
            options: geo.candidates.map((/** @type {any} */ p) => p.id),
            labels: geo.candidates.map((/** @type {any} */ p) =>
              `${p.name}, ${p.country}${p.region ? `, ${p.region}` : ''}`.slice(0, 40),
            ),
          },
        ],
        warnings: [],
        readyForResearch: false,
      };
  }
  /** @type {string[]} */
  const warnings = [];
  if (a.date_from && a.date_from < today) warnings.push('Дата виїзду вже минула — уточни дату.');
  if (a.date_to && a.date_from && a.date_to < a.date_from)
    warnings.push('Дата повернення раніше за виїзд — уточни дати.');
  if (warnings.length)
    return {
      phase: 'scope',
      ask: [{ field: 'date_from', question: 'Уточни дату виїзду й повернення.' }],
      warnings,
      readyForResearch: false,
    };

  add('to', 'Куди їдеш?');
  add('date_from', 'Коли починається поїздка?');
  if (a.date_from) {
    add(
      'return_type',
      'Плануєш повернення, поїздку в один бік чи дата ще невідома?',
      ENUMS.return_type,
    );
    if (a.return_type === 'round_trip')
      add('date_to', 'Коли повертаєшся? Для одноденної поїздки — та сама дата.');
  }
  if (!home.city) add('from_city', 'Звідки вирушаєш?');
  add('mode', 'Чим плануєш їхати? Якщо ще обираєш — порівняю варіанти.', MODES);
  if (!a.transport_count)
    add(
      'participants',
      'Скільки людей їде разом із тобою цим транспортом? Якщо на місці буде інша група, можеш одразу сказати.',
      ['1', '2', '3', '4', 'other'],
    );
  add('purpose', 'Яка мета поїздки: відпочинок, робота, транзит чи інше?', TRIP_PURPOSES);
  add('international', 'Це закордонна поїздка?', ['так', 'ні']);
  if (a.international === true) add('country', 'У яку країну їдеш?');
  const scopeMissing =
    !a.to ||
    !a.date_from ||
    !a.return_type ||
    (a.return_type === 'round_trip' && !a.date_to) ||
    (!home.city && !a.from_city) ||
    !a.mode ||
    (!a.participants && !a.transport_count) ||
    !a.purpose ||
    a.international == null ||
    (a.international && !a.country);
  if (scopeMissing) return { phase: 'scope', ask, warnings, readyForResearch: false };

  if (a.mode === 'car') {
    if (vehicles.length && !a.vehicle_description) {
      if (
        !a.vehicle_key ||
        (a.vehicle_key !== 'other' && !vehicles.some((v) => v.key === a.vehicle_key))
      )
        ask.push({
          field: 'vehicle_key',
          question: 'Яким авто їдеш?',
          options: [...vehicles.map((v) => v.key), 'other'],
          default: vehicles[0]?.key,
        });
      if (a.vehicle_key === 'other')
        add(
          'vehicle_description',
          'Яке інше авто й приблизна витрата пального? Якщо не знаєш — так і скажи.',
        );
    } else
      add(
        'vehicle_description',
        'Яке авто й приблизна витрата пального? Якщо не знаєш — розрахую без цього.',
      );
    add('depart_at', 'Коли орієнтовно виїжджаєш? Можна часовий проміжок.');
  } else if (a.mode === 'bus' || a.mode === 'train') {
    add('departure_window', 'Який час виїзду зручний?');
    add('ticket_status', 'Квитки вже є, ще шукаєш чи поки не вирішив?', ENUMS.ticket_status);
  } else if (a.mode === 'plane') {
    add('departure_airport', 'З якого аеропорту зручно летіти?');
    add('ticket_status', 'Квитки вже є, ще шукаєш чи поки не вирішив?', ENUMS.ticket_status);
    add('baggage', 'Який багаж плануєш взяти?');
  } else if (a.mode === 'hike' || a.mode === 'walk') {
    add('route_profile', 'Яка дистанція або складність маршруту тобі підходить?');
  } else if (a.mode === 'mixed') {
    add('legs', 'Які частини маршруту й види транспорту вже відомі?');
  } else if (a.mode === 'compare') {
    add('trip_priorities', 'Що важливіше при виборі дороги: ціна, час чи зручність?');
  }
  if (a.international) {
    add('timezone', 'Який місцевий часовий пояс у місці призначення? Наприклад Europe/Vienna.');
    add('departure_timezone', 'Який часовий пояс у місці виїзду? Наприклад Europe/Kyiv.');
  }
  if (a.international)
    add(
      'citizenship',
      'Громадянство учасників для перевірки правил вʼїзду? Номерів документів не надсилай.',
    );
  add('budget_type', 'Бюджет жорсткий, гнучкий чи без ліміту?', ENUMS.budget_type);
  if (a.budget_type === 'limit') {
    add('budget_total', 'Який ліміт бюджету на всю поїздку?');
  }
  if (a.budget_total) add('budget_currency', 'У якій валюті бюджет?');
  if (a.return_type === 'one_way' || (a.date_to && a.date_to > a.date_from))
    add('lodging_needed', 'Потрібне житло чи вже маєш де зупинитися?', ENUMS.lodging_needed);
  if (ask.length)
    return {
      phase: 'logistics',
      ask: ask.slice(0, QUESTION_LIMIT),
      warnings,
      readyForResearch: true,
    };

  if (a.optional_skipped) return { phase: 'ready', ask: [], warnings, readyForResearch: true };
  if (a.budget_total) add('budget_scope', 'Цей бюджет на кого?', ENUMS.budget_scope, true);
  if (a.return_type === 'round_trip')
    add(
      'return_meaning',
      'Названа дата повернення — це вже бути вдома чи виїхати назад?',
      ENUMS.return_meaning,
      true,
    );
  if (
    a.return_type === 'round_trip' &&
    a.destination_count &&
    a.destination_count !== a.transport_count
  )
    add('return_count', 'Скільки людей їде з тобою назад?', ['1', '2', '3', '4', 'other'], true);
  if (a.lodging_needed === 'yes') {
    add('lodging_count', 'На скількох людей підбирати житло?', ['1', '2', '3', '4', 'other'], true);
    add('lodging_layout', 'Як хочете розміститися?', ENUMS.lodging_layout, true);
    add(
      'lodging_from',
      'З якої дати потрібне заселення? Ніч у дорозі не рахую як ніч у житлі.',
      undefined,
      true,
    );
    add('lodging_to', 'До якої дати потрібне житло?', undefined, true);
  }
  if (!a.purpose.match(/транзит|ділов|робот|бізнес/i)) {
    add('interests', 'Що хочеш побачити або зробити? Можна пропустити.', undefined, true);
  }
  if (a.lodging_needed === 'yes')
    add('lodging_preference', 'Є побажання до житла чи району? Можна пропустити.', undefined, true);
  add('arrival_window', 'Потрібно прибути до певного часу? Можна пропустити.', undefined, true);
  if (a.return_type === 'round_trip')
    add('return_window', 'Коли зручно виїхати назад? Можна пропустити.', undefined, true);
  add(
    'trip_priorities',
    'Що важливіше: ціна, час чи зручність? Можна пропустити.',
    undefined,
    true,
  );
  if (a.international)
    add(
      'documents_status',
      'Документи, право вʼїзду і страховку вже перевірив? Без номерів документів. Можна пропустити.',
      undefined,
      true,
    );
  if (a.mode === 'plane') {
    add('arrival_airport', 'Є бажаний аеропорт прибуття? Можна пропустити.', undefined, true);
    add('flight_transfers', 'Пересадки допустимі? Можна пропустити.', undefined, true);
  }
  if (a.mode === 'car')
    add(
      'parking_preference',
      'Потрібна парковка біля житла або в центрі? Можна пропустити.',
      undefined,
      true,
    );
  if (a.mode === 'hike')
    add(
      'equipment',
      'Яке спорядження вже маєш і чи плануєш ночівлю? Можна пропустити.',
      undefined,
      true,
    );
  if (!a.purpose.match(/транзит|ділов|робот|бізнес/i)) {
    add('travel_pace', 'Який темп тобі ближчий?', ENUMS.travel_pace, true);
    add('food_preference', 'Є побажання до їжі чи закладів? Можна пропустити.', undefined, true);
  }
  add('constraints', 'Є важливі обмеження чи побажання? Можна пропустити.', undefined, true);
  add(
    'accessibility',
    'Є потреби щодо доступності, дітей або особливі умови учасників?',
    undefined,
    true,
  );
  add('pets', 'Подорожуєте з твариною?', ['no', 'yes'], true);
  add(
    'home_preparation',
    'Що підготувати вдома перед від’їздом: ключі, рослини, тварини, доставки?',
    undefined,
    true,
  );
  add('support_level', 'Яка допомога потрібна?', ENUMS.support_level, true);
  return { phase: ask.length ? 'preferences' : 'ready', ask, warnings, readyForResearch: true };
}

/**
 * Чернетка + найближчі доречні питання; збереження тільки через policy T0.
 * @param {Env} env
 * @param {{to?:string,date_from?:string,purpose?:string,draft_id?:string,restart?:boolean,skip_optional?:boolean,skip_field?:string,free_field?:string,edit_field?:string,read_only?:boolean,expected_revision?:number,answers?:Record<string,unknown>}} args
 * @param {number} nowMs
 * @param {{chatId?:number|string|null,threadId?:number|string|null}} ctx
 * @returns {Promise<{result:any}>}
 */
export async function runTripBrief(env, args, nowMs = Date.now(), ctx = {}) {
  const patch = answerPatch(args);
  const scope = tripScopeKey(ctx);
  let row = null;
  let persisted = Boolean(scope);
  try {
    if (scope && !args.restart)
      row = await loadDraft(env, scope, args.draft_id ?? null, patch.to ?? null, nowMs);
  } catch (error) {
    // Expand rollout: old schema remains usable for text-only planning. Never
    // invent a saved draft or clickable callback when migration has not landed.
    if (args.draft_id || !/no such table: (?:main\.)?trip_briefs/i.test(String(error))) throw error;
    persisted = false;
  }
  const previous = row ? JSON.parse(String(row.answers_json)) : {};
  if (args.read_only && !row) return { result: null };
  if (
    args.expected_revision != null &&
    Number(previous._meta?.revision ?? 0) !== args.expected_revision
  )
    throw new Error('Бриф уже змінився. Відкрий актуальні дані.');
  let answers = { ...previous, ...patch };
  if (args.free_field) answers._free_field = args.free_field;
  if (Object.hasOwn(patch, answers._free_field)) delete answers._free_field;
  if (args.edit_field) answers._editing = args.edit_field;
  if (Object.hasOwn(patch, answers._editing)) delete answers._editing;
  const [vehicles, home] = await Promise.all([listVehicles(env), homeCity(env)]);
  if (!answers.from_city && home.city) answers.from_city = home.city;
  const dependencies = {
    to: [
      'country',
      'country_code',
      'international',
      'timezone',
      'citizenship',
      'documents_status',
      'lodging_from',
      'lodging_to',
    ],
    from_city: ['departure_timezone'],
    date_from: ['arrival_date', 'lodging_from'],
    date_to: ['lodging_to'],
  };
  for (const [field, dependents] of Object.entries(dependencies))
    if (Object.hasOwn(patch, field) && previous[field] && patch[field] !== previous[field]) {
      for (const dependent of dependents)
        if (!Object.hasOwn(patch, dependent)) delete answers[dependent];
      answers._geo =
        field === 'to'
          ? { ...answers._geo, destination: null }
          : field === 'from_city'
            ? { ...answers._geo, origin: null }
            : answers._geo;
      if (answers._research) answers._research = { ...answers._research, stale: true };
    }
  if (
    answers.participants &&
    (Object.hasOwn(patch, 'participants') || !answers.transport_count || !answers.destination_count)
  ) {
    const number = (/** @type {string} */ value) =>
      /** @type {Record<string,number>} */ ({
        сам: 1,
        самостійно: 1,
        один: 1,
        одна: 1,
        двоє: 2,
        дві: 2,
        два: 2,
        вдвох: 2,
        удвох: 2,
        троє: 3,
        три: 3,
        четверо: 4,
        чотири: 4,
      })[String(value).toLowerCase()] ?? Number(value);
    const tokens =
      answers.participants
        .toLowerCase()
        .match(/\d+|самостійно|сам|один|одна|двоє|дві|два|вдвох|удвох|троє|три|четверо|чотири/gu) ??
      [];
    if (
      tokens.length &&
      number(tokens[0]) > 0 &&
      number(tokens[0]) <= 100 &&
      !Object.hasOwn(patch, 'transport_count') &&
      (Object.hasOwn(patch, 'participants') || !answers.transport_count)
    )
      answers.transport_count = number(tokens[0]);
    if (
      tokens.length > 1 &&
      number(tokens[1]) > 0 &&
      number(tokens[1]) <= 100 &&
      /(?:але|на місці|загалом)[^.]{0,80}(?:буде|будемо|нас|всього)/iu.test(answers.participants) &&
      !Object.hasOwn(patch, 'destination_count') &&
      (Object.hasOwn(patch, 'participants') || !answers.destination_count)
    )
      answers.destination_count = number(tokens[1]);
  }
  if (args.skip_field)
    answers._skipped = [...new Set([...(answers._skipped ?? []), args.skip_field])].slice(-80);
  if (args.skip_field === answers._editing) delete answers._editing;
  if (Object.keys(patch).length)
    answers._skipped = (answers._skipped ?? []).filter(
      (/** @type {string} */ field) => !Object.hasOwn(patch, field),
    );
  if (answers._inferred) {
    answers._inferred = { ...answers._inferred };
    for (const field of Object.keys(patch)) delete answers._inferred[field];
  }
  if (
    Object.hasOwn(patch, 'destination_count') &&
    previous._inferred?.lodging_count &&
    !Object.hasOwn(patch, 'lodging_count')
  )
    delete answers.lodging_count;
  if (args.skip_optional) answers.optional_skipped = true;
  // Зміна способу не тягне випадково старі поля авто до плану літака.
  if (patch.mode && previous.mode && patch.mode !== previous.mode) {
    for (const key of [
      'vehicle_key',
      'vehicle_description',
      'depart_at',
      'departure_window',
      'return_window',
      'ticket_status',
      'departure_airport',
      'arrival_airport',
      'baggage',
      'route_profile',
      'legs',
      'parking_preference',
      'flight_transfers',
      'equipment',
    ]) {
      if (!Object.hasOwn(patch, key)) delete answers[key];
    }
  }
  if (patch.return_type === 'one_way') delete answers.date_to;
  if (patch.international === false) {
    delete answers.country;
    delete answers.citizenship;
    delete answers.documents_status;
  }
  if (patch.budget_type === 'no_limit') delete answers.budget_total;
  for (const key of Object.keys(answers)) if (answers[key] === null) delete answers[key];
  if (answers.date_to && !answers.return_type) answers.return_type = 'round_trip';
  answers = await enrichTripGeography(
    env,
    answers,
    previous,
    patch,
    nowMs,
    Boolean(args.read_only),
  );
  if (answers.lodging_needed === 'yes' && answers.destination_count && !answers.lodging_count) {
    answers.lodging_count = answers.destination_count;
    answers._inferred = {
      ...answers._inferred,
      lodging_count: 'Кількість людей на місці; можна змінити.',
    };
  }
  if (!args.read_only) {
    const at = new Date(nowMs).toISOString();
    answers._sources = {
      ...previous._sources,
      ...Object.fromEntries(Object.keys(patch).map((field) => [field, { kind: 'owner', at }])),
    };
    for (const [field, geoKey] of /** @type {[string,string][]} */ ([
      ['country', 'destination'],
      ['country_code', 'destination'],
      ['timezone', 'destination'],
      ['departure_timezone', 'origin'],
    ]))
      if (answers[field] && !Object.hasOwn(patch, field) && answers._geo?.[geoKey]?.place)
        answers._sources[field] = {
          kind: 'resolved_city',
          at,
          source: answers._geo[geoKey].place.source,
        };
    answers._meta = {
      ...previous._meta,
      revision: Number(previous._meta?.revision ?? 0) + 1,
      at: new Date(nowMs).toISOString(),
      changed: Object.keys(patch),
      history: [
        ...(previous._meta?.history ?? []),
        ...Object.keys(patch).filter((key) => TRIP_FIELD_LABELS[key]),
      ].slice(-100),
    };
  }
  let draftId = row?.id ?? null;
  if (persisted && scope && !args.read_only) {
    try {
      draftId = await saveDraft(env, row, scope, answers, nowMs);
    } catch (error) {
      if (args.draft_id || !/no such table: (?:main\.)?trip_briefs/i.test(String(error)))
        throw error;
      persisted = false;
    }
  }
  const price = await fuelPrice(env, vehicles[0]?.fuel ?? null);
  let questions = tripQuestions(answers, home, vehicles, nowMs);
  if (answers._editing) {
    const editing = { ...answers };
    delete editing[answers._editing];
    editing._skipped = (answers._skipped ?? []).filter(
      (/** @type {string} */ f) => f !== answers._editing,
    );
    const q = tripQuestions(editing, home, vehicles, nowMs).ask.find(
      (q) => q.field === answers._editing,
    ) ?? {
      field: answers._editing,
      question: `Зміни «${TRIP_FIELD_LABELS[answers._editing] ?? answers._editing}». Поточне: ${answers[answers._editing] ?? 'не задано'}.`,
      ...(ENUMS[answers._editing] ? { options: ENUMS[answers._editing] } : {}),
    };
    questions = {
      ...questions,
      ask: [q, ...questions.ask.filter((q) => q.field !== answers._editing)],
    };
  }
  let approvedPattern = null;
  if (scope && env.DB) {
    const { results } = await env.DB.prepare(
      `SELECT t.cost_json,c.state_json FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE json_extract(t.cost_json,'$.travel.pattern.confirmed')=1 ORDER BY t.date_from DESC LIMIT 100`,
    )
      .bind()
      .all();
    const candidate = (results ?? []).find((item) => {
      const state = JSON.parse(String(item.state_json ?? '{}'));
      return tripScopeKey({ chatId: state?.chat_id, threadId: state?.thread_id }) === scope;
    });
    if (candidate)
      approvedPattern = JSON.parse(String(candidate.cost_json)).travel?.pattern ?? null;
  }
  const result = {
    draft_id: draftId,
    revision: answers._meta?.revision ?? 0,
    persisted,
    phase: questions.phase,
    ask: questions.ask,
    warnings: questions.warnings,
    ready_for_research: questions.readyForResearch,
    answers,
    known: {
      from_city: answers.from_city ?? home.city,
      vehicles: vehicles.map((v) => ({ key: v.key, name: v.name, per100: v.per100 })),
      fuel_price: price,
      approved_pattern: approvedPattern,
    },
    purposes: TRIP_PURPOSES,
    then:
      questions.phase === 'ready'
        ? 'Підготуй обґрунтовані варіанти маршруту, бюджету й проживання з джерелами. Не бронюй і не запускай chain.start до явного вибору власника.'
        : `Запитай тільки найближче поле ask одним коротким повідомленням. Нові відповіді передай у trip.brief через answers; ${persisted ? 'чернетка збережена' : 'чернетка не збережена: користуйся контекстом розмови, не обіцяй стійкість після /new'}. Не запускай chain.start.`,
  };
  return { result: { ...result, question_card: tripBriefCard(result) } };
}

/** Read the saved state without refreshing TTL, writing preferences or invoking web search.
 * @param {Env} env @param {{chatId?:number|string|null,threadId?:number|string|null}} ctx @param {number} nowMs @param {string|null} draftId @returns {Promise<any>} */
export async function readTripBrief(env, ctx, nowMs = Date.now(), draftId = null) {
  if (!env.DB || !tripScopeKey(ctx)) return null;
  try {
    return (
      await runTripBrief(
        env,
        { read_only: true, ...(draftId ? { draft_id: draftId } : {}) },
        nowMs,
        ctx,
      )
    ).result;
  } catch (error) {
    if (/no such table|не знайдено/u.test(String(error))) return null;
    throw error;
  }
}
/** Owner context stays bounded and never promotes stored web prose to first-party instructions.
 * @param {any} brief */
export function tripBriefContext(brief) {
  if (!brief) return null;
  return {
    draft_id: brief.draft_id,
    revision: brief.revision,
    phase: brief.phase,
    ask: brief.ask?.slice(0, 1),
    question_card: brief.question_card,
    ready_for_research: brief.ready_for_research,
    answers: normalizeTripAnswers(brief.answers),
    geography: brief.answers?._geo,
    research_available: Boolean(brief.answers?._research?.options?.length),
    research_revision: brief.answers?._research?.revision ?? 0,
    previous_selection_ids: brief.answers?._research?.selections ?? {},
    selection_note:
      'Ідентифікатори попередніх виборів не підтверджують нові ціни. Перед використанням умов прочитай trip.research і перевір попередження.',
  };
}

/** Активні поїздки без сирого стану Workflow чи припущень про живу локацію.
 * @param {Env} env @param {{to?:string,trip_id?:string}} args @param {number} nowMs */
export async function runTripContext(
  env,
  args = {},
  nowMs = Date.now(),
  ctx = /** @type {any} */ (null),
) {
  if (!env.DB) throw new Error('Сховище поїздок недоступне');
  const today = kyivDateKey(new Date(nowMs));
  const filter = String(args.to ?? '')
    .trim()
    .toLocaleLowerCase('uk')
    .slice(0, 80);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.to_text, t.from_city, t.country, t.date_from, t.date_to,
            t.mode, t.status, t.cost_json, c.state_json, c.status AS chain_status
       FROM trips t LEFT JOIN chains c ON c.id = t.workflow_id
      WHERE (t.status IN ('active', 'failed') OR (t.status = 'done' AND ? = 1))
        AND (? IS NULL OR t.id = ?)
      ORDER BY CASE WHEN t.date_from <= ? AND (t.date_to IS NULL OR t.date_to >= ?) THEN 0 ELSE 1 END,
               t.date_from LIMIT 200`,
  )
    .bind(filter || args.trip_id ? 1 : 0, args.trip_id ?? null, args.trip_id ?? null, today, today)
    .all();
  const matches = (results ?? [])
    .filter((row) => {
      if (!ctx) return true;
      try {
        const state = JSON.parse(String(row.state_json ?? '{}'));
        return (
          tripScopeKey({ chatId: state.chat_id, threadId: state.thread_id }) === tripScopeKey(ctx)
        );
      } catch {
        return false;
      }
    })
    .filter((row) => !filter || String(row.to_text).toLocaleLowerCase('uk').includes(filter))
    .map((row) => {
      /** @type {Record<string, any>} */
      let state = {};
      try {
        const parsed = JSON.parse(String(row.state_json ?? '{}'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
      } catch {
        // Старий/пошкоджений стан не приховує сам запис поїздки.
      }
      /** @type {Record<string,any>} */
      let travel = {};
      try {
        travel = JSON.parse(String(row.cost_json ?? '{}'))?.travel ?? {};
      } catch {
        // Read-only context still exposes the trip; workspace/ledger report unavailable data.
      }
      const timezone = tripZone(travel.preferences?.timezone ?? state.preferences?.timezone);
      const localToday = tripLocalParts(nowMs, timezone).date;
      const from = String(row.date_from);
      const to = row.date_to == null ? null : String(row.date_to);
      const phase =
        localToday < from
          ? 'upcoming'
          : to == null
            ? localToday === from
              ? 'departure_day'
              : 'return_unknown'
            : localToday > to
              ? 'awaiting_summary'
              : 'travel_day';
      const dayNumber =
        phase === 'travel_day' && to
          ? Math.round(
              (Date.parse(`${localToday}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
                86_400_000,
            ) + 1
          : null;
      return {
        trip_id: row.id,
        brief_id: state.brief_id ?? null,
        to: row.to_text,
        from_city: row.from_city,
        country: row.country,
        date_from: from,
        date_to: to,
        mode: row.mode,
        status: row.status,
        chain_status: row.chain_status,
        phase,
        day_number: dayNumber,
        depart_at: state.depart_at ?? null,
        purpose: state.purpose ?? null,
        participants: state.participants ?? null,
        preferences: normalizeTripAnswers({
          ...state.preferences,
          ...travel.preferences,
        }),
        recorded_costs: recordedCosts(row.cost_json),
        expense_ledger: tripExpenseSummary(row.cost_json),
        workspace: tripWorkspaceView(row.cost_json),
        local_today: localToday,
        timezone,
      };
    })
    .sort((a, b) => {
      /** @type {Record<string, number>} */
      const priority = {
        travel_day: 0,
        departure_day: 0,
        return_unknown: 1,
        upcoming: 2,
        awaiting_summary: 3,
      };
      return (
        (priority[a.phase] ?? 4) - (priority[b.phase] ?? 4) ||
        a.date_from.localeCompare(b.date_from)
      );
    });
  return {
    result: {
      today,
      trips: matches.slice(0, 5),
      location_known: false,
      note: 'Це запис поїздки, а не жива геолокація чи підтверджений розклад транспорту.',
    },
  };
}

/** Do not add ticket subtotal to an owner's actual total: they may overlap.
 * @param {unknown} raw */
function recordedCosts(raw) {
  /** @type {Record<string, {minor:number,currency:string}>} */
  const costs = {};
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    for (const key of ['ticket', 'actual']) {
      const value = parsed?.[key];
      if (
        Number.isSafeInteger(value?.minor) &&
        value.minor > 0 &&
        /^[A-Z]{3}$/.test(value?.currency)
      )
        costs[key] = { minor: value.minor, currency: value.currency };
    }
  } catch {
    /* No usable confirmed costs. */
  }
  return costs;
}

/**
 * Дім: чи відомий узагалі і як він зветься.
 *
 * ⚠️ Форм три, і ядро знає всі (ревʼю): `{city}` / `{name}`, канонічна
 * `{lat, lon}` (саме її радить `resolveHome`) і фолбек `OWNER_LOCATIONS`. Дві
 * останні дому НЕ називають - і це нормально: ланцюг усе одно бере координати
 * сам. Повну адресу як «місто» не віддаємо: вона поїхала б у `chain.start` і
 * рендерилась як «вул. Франка 24, Львів → Івано-Франківськ».
 * @param {Env} env
 * @returns {Promise<{ known: boolean, city: string | null }>}
 */
async function homeCity(env) {
  const { result } = await runFactsGet(env, { kind: 'place', key: 'home' });
  const value = /** @type {any} */ (result[0])?.value;
  if (value != null) {
    const named = value.city ?? value.name ?? null;
    const located = Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lon));
    if (named != null) return { known: true, city: String(named).slice(0, 60) };
    if (located || value.address != null) return { known: true, city: null };
  }
  try {
    const list = JSON.parse(String(env.OWNER_LOCATIONS ?? '[]'));
    const first = Array.isArray(list) ? list[0] : null;
    if (first)
      return { known: true, city: first.name == null ? null : String(first.name).slice(0, 60) };
  } catch {
    // Зіпсований OWNER_LOCATIONS - не привід валити опитувальник: просто
    // спитаємо місто, як і без нього.
  }
  return { known: false, city: null };
}
