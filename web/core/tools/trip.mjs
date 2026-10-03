// Адаптивна анкета поїздки. Чернетка живе окремо від TripChain: бриф не
// бронює, не змінює календар і не запускає супровід без вибору власника.

import { TRIP_MODES, TRIP_PURPOSES } from '../chains/trip.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
import { listVehicles, fuelPrice } from '../trips/cost.mjs';
import { runFactsGet } from './facts.mjs';
import { tripBriefCard } from './trip-card.mjs';
import { tripExpenseSummary } from './trip-expenses.mjs';
import { tripWorkspaceView } from './trip-workspace.mjs';
import { tripZone, tripLocalParts } from '../trips/time.mjs';

const DRAFT_TTL_MS = 30 * 86_400_000;
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
};

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
        ['date_from', 'date_to', 'international', 'budget_total', 'optional_skipped'].includes(
          field,
        )
      )
        out[field] = null;
      continue;
    }
    if (field in TEXT_FIELDS && typeof raw === 'string') {
      const value = raw.trim().slice(0, TEXT_FIELDS[field] ?? 0);
      if (value && (field === 'timezone' || field === 'departure_timezone')) tripZone(value);
      if (value) out[field] = value;
    } else if (field in ENUMS && ENUMS[field]?.includes(raw)) {
      out[field] = raw;
    } else if (field === 'date_from' || field === 'date_to') {
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
        ['date_from', 'date_to', 'international', 'budget_total'].includes(key)) &&
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
async function loadDraft(env, scope, requestedId, to, nowMs) {
  const database = env.DB;
  if (!database) throw new Error('Сховище чернеток поїздок недоступне');
  const cutoff = new Date(nowMs - DRAFT_TTL_MS).toISOString();
  if (requestedId) {
    const row = await database
      .prepare(
        'SELECT * FROM trip_briefs WHERE id = ? AND scope_key = ? AND status = ? AND updated_at >= ?',
      )
      .bind(requestedId, scope, 'draft', cutoff)
      .first();
    if (!row) throw new Error('Чернетку поїздки не знайдено в цьому чаті або вона застаріла');
    return row;
  }
  const { results } = await database
    .prepare(
      'SELECT * FROM trip_briefs WHERE scope_key = ? AND status = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 10',
    )
    .bind(scope, 'draft', cutoff)
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
  if (row) {
    const saved = await database
      .prepare(
        'UPDATE trip_briefs SET answers_json = ?, updated_at = ? WHERE id = ? AND scope_key = ? AND answers_json = ?',
      )
      .bind(JSON.stringify(answers), at, row.id, scope, row.answers_json)
      .run();
    if (Number(saved.meta?.changes ?? 0) !== 1)
      throw new Error('Бриф змінився паралельно — повтори останню відповідь');
    return String(row.id);
  }
  const id = crypto.randomUUID();
  await database
    .prepare(
      "INSERT INTO trip_briefs (id, scope_key, answers_json, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)",
    )
    .bind(id, scope, JSON.stringify(answers), at, at)
    .run();
  return id;
}

/** @param {Record<string, any>} a @param {{known:boolean,city:string|null}} home @param {any[]} vehicles @param {number} nowMs */
export function tripQuestions(a, home, vehicles, nowMs) {
  /** @type {{field:string,question:string,options?:string[],default?:string,optional?:boolean}[]} */
  const ask = [];
  /** @param {string} field @param {string} question @param {string[] | undefined} options @param {boolean} optional */
  const add = (field, question, options = undefined, optional = false) => {
    if (a[field] == null && ask.length < QUESTION_LIMIT)
      ask.push({
        field,
        question,
        ...(options ? { options } : {}),
        ...(optional ? { optional: true } : {}),
      });
  };
  const today = kyivDateKey(new Date(nowMs));
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
  add('participants', 'Скільки людей їде? Якщо сам - так і скажи.');
  add('purpose', 'Яка мета поїздки: відпочинок, робота, транзит чи інше?');
  add('international', 'Це закордонна поїздка?', ['так', 'ні']);
  if (a.international === true) add('country', 'У яку країну їдеш?');
  const scopeMissing =
    !a.to ||
    !a.date_from ||
    !a.return_type ||
    (a.return_type === 'round_trip' && !a.date_to) ||
    (!home.city && !a.from_city) ||
    !a.mode ||
    !a.participants ||
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
    add(
      'travel_pace',
      'Насичений чи спокійний темп тобі ближчий? Можна пропустити.',
      undefined,
      true,
    );
    add('food_preference', 'Є побажання до їжі чи закладів? Можна пропустити.', undefined, true);
  }
  add('constraints', 'Є важливі обмеження чи побажання? Можна пропустити.', undefined, true);
  return { phase: ask.length ? 'preferences' : 'ready', ask, warnings, readyForResearch: true };
}

/**
 * Чернетка + найближчі доречні питання; збереження тільки через policy T0.
 * @param {Env} env
 * @param {{to?:string,date_from?:string,purpose?:string,draft_id?:string,restart?:boolean,skip_optional?:boolean,answers?:Record<string,unknown>}} args
 * @param {number} nowMs
 * @param {{chatId?:number|string|null,threadId?:number|string|null}} ctx
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
  const answers = { ...previous, ...patch };
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
  if (answers.country && answers.international == null)
    answers.international = !['україна', 'ukraine', 'ua'].includes(
      answers.country.toLocaleLowerCase('uk'),
    );
  let draftId = null;
  if (persisted && scope) {
    try {
      draftId = await saveDraft(env, row, scope, answers, nowMs);
    } catch (error) {
      if (args.draft_id || !/no such table: (?:main\.)?trip_briefs/i.test(String(error)))
        throw error;
      persisted = false;
    }
  }
  const [vehicles, home] = await Promise.all([listVehicles(env), homeCity(env)]);
  const price = await fuelPrice(env, vehicles[0]?.fuel ?? null);
  const questions = tripQuestions(answers, home, vehicles, nowMs);
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

/** Активні поїздки без сирого стану Workflow чи припущень про живу локацію.
 * @param {Env} env @param {{to?:string,trip_id?:string}} args @param {number} nowMs */
export async function runTripContext(env, args = {}, nowMs = Date.now()) {
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
      const localToday = tripLocalParts(nowMs, state.preferences?.timezone ?? 'Europe/Kyiv').date;
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
        preferences: normalizeTripAnswers(state.preferences),
        recorded_costs: recordedCosts(row.cost_json),
        expense_ledger: tripExpenseSummary(row.cost_json),
        workspace: tripWorkspaceView(row.cost_json),
        local_today: tripLocalParts(nowMs, state.preferences?.timezone ?? 'Europe/Kyiv').date,
        timezone: state.preferences?.timezone ?? 'Europe/Kyiv',
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
