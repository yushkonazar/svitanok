import { chainTarget } from '../chains/state.mjs';
import { tripInstant, tripZone } from '../trips/time.mjs';

const LIMITS = { legs: 80, places: 120, reviews: 60, history: 20 };
export const TRIP_WORKSPACE_OPS = [
  'get',
  'leg',
  'remove_leg',
  'restore_revision',
  'place',
  'review',
  'monitor',
  'link_transaction',
  'unlink_transaction',
  'learn',
];

/** @param {unknown} value @returns {Record<string,any>} */
function object(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Запис поїздки пошкоджений — не перезаписую його.');
  return parsed;
}
/** @param {unknown} value @param {number} max */
const text = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
/** @param {unknown} value */
function key(value) {
  const id = String(value ?? crypto.randomUUID());
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) throw new Error('Не вдалося визначити запис маршруту.');
  return id;
}
/** HTTPS links only; these are references, not proof of live availability. @param {unknown} value */
function link(value) {
  if (!value) return null;
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 1000)
    throw new Error('Потрібне звичайне HTTPS-посилання без пароля.');
  return url.href;
}
/** @param {any} raw */
export function normalizedTripLeg(raw) {
  const kind = String(raw.kind ?? 'activity');
  const mode = raw.mode == null ? null : String(raw.mode);
  if (
    !['travel', 'activity', 'stay'].includes(kind) ||
    (mode && !['car', 'train', 'bus', 'plane', 'walk', 'hike', 'mixed'].includes(mode))
  )
    throw new Error('Уточни тип етапу та транспорт.');
  const start_zone = tripZone(raw.start_zone);
  const end_zone = tripZone(raw.end_zone, start_zone);
  const start = text(raw.start, 16),
    end = text(raw.end, 16);
  const start_ms = tripInstant(start, start_zone),
    end_ms = tripInstant(end, end_zone);
  if (end_ms <= start_ms)
    throw new Error('Завершення етапу має бути після початку, з урахуванням місцевого часу.');
  const title = text(raw.title, 120);
  if (!title) throw new Error('Назви етап маршруту.');
  const transfer_minutes = Number(raw.transfer_minutes ?? 0);
  if (!Number.isInteger(transfer_minutes) || transfer_minutes < 0 || transfer_minutes > 1440)
    throw new Error('Уточни запас на пересадку в хвилинах.');
  return {
    id: key(raw.id),
    kind,
    mode,
    title,
    from: text(raw.from, 120),
    to: text(raw.to, 120),
    start,
    end,
    start_zone,
    end_zone,
    start_ms,
    end_ms,
    transfer_minutes,
    parallel: raw.parallel === true,
    booked: raw.booked === true,
    operator: text(raw.operator, 80),
    service: text(raw.service, 40),
    source_url: link(raw.source_url),
    note: text(raw.note, 160),
  };
}
/** @param {any[]} legs */
export function itineraryWarnings(legs) {
  const sorted = [...legs].sort((a, b) => a.start_ms - b.start_ms);
  const warnings = [];
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i];
    for (const prev of sorted.slice(0, i)) {
      if (next.start_ms < prev.end_ms && !next.parallel && !prev.parallel)
        warnings.push(`Накладення: «${prev.title}» і «${next.title}».`);
    }
    const prev = sorted[i - 1];
    if (
      prev &&
      next.kind === 'travel' &&
      next.start_ms >= prev.end_ms &&
      next.start_ms - prev.end_ms < next.transfer_minutes * 60_000
    )
      warnings.push(`Замалий запас перед «${next.title}»: потрібно ${next.transfer_minutes} хв.`);
    if (next.kind === 'travel' && ['plane', 'train', 'bus'].includes(next.mode) && !next.source_url)
      warnings.push(`Для «${next.title}» ще немає джерела перевізника.`);
  }
  return [...new Set(warnings)].slice(0, 20);
}

/** Scoped storage, optimistic updates preserve concurrent expenses and chain totals.
 * @param {Env} env @param {string} id @param {any} ctx */
async function rowFor(env, id, ctx) {
  if (!env.DB || ctx?.chatId == null) throw new Error('Не вдалося визначити чат поїздки.');
  const row = await env.DB.prepare(
    `SELECT t.*, c.state_json FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.id=? AND c.kind='trip'`,
  )
    .bind(id)
    .first();
  if (!row || !['active', 'done'].includes(String(row.status)))
    throw new Error('Поїздку не знайдено або її скасовано.');
  const state = object(row.state_json);
  const target = chainTarget(env, state);
  if (
    String(target.chatId) !== String(ctx.chatId) ||
    String(target.threadId ?? '') !== String(ctx.threadId === 'dm' ? '' : (ctx.threadId ?? ''))
  )
    throw new Error('Ця поїздка належить іншому чату.');
  return { row, state, costs: object(row.cost_json) };
}

/** @param {unknown} raw */
export function tripWorkspaceView(raw) {
  /** @type {Record<string,any>} */
  let workspace;
  try {
    workspace = object(object(raw).travel);
  } catch {
    return {
      unavailable: true,
      note: 'Збережений маршрут не вдалося прочитати. Це не означає, що записів немає.',
    };
  }
  const legs = Array.isArray(workspace.legs) ? workspace.legs.slice(0, LIMITS.legs) : [];
  return {
    revision: workspace.revision ?? 0,
    legs,
    warnings: itineraryWarnings(legs),
    places: Array.isArray(workspace.places) ? workspace.places.slice(0, LIMITS.places) : [],
    reviews: Array.isArray(workspace.reviews) ? workspace.reviews.slice(-LIMITS.reviews) : [],
    monitor: workspace.monitor ?? { enabled: false },
    pattern: workspace.pattern ?? null,
    history: Array.isArray(workspace.history)
      ? workspace.history
          .slice(-LIMITS.history)
          .map(({ at, op, revision }) => ({ at, op, revision }))
      : [],
    itinerary_versions: Array.isArray(workspace.versions)
      ? workspace.versions.map(({ revision, at }) => ({ revision, at }))
      : [],
    note: 'Збережений маршрут не є бронюванням або живим розкладом перевізника.',
  };
}

/** @param {any[]} entries */
export function commonTripPattern(entries) {
  if (entries.length < 3) return null;
  const fields = [
    'mode',
    'purpose',
    'lodging_preference',
    'food_preference',
    'travel_pace',
    'interests',
  ];
  /** @type {Record<string,string>} */
  const answers = {};
  for (const field of fields) {
    const counts = new Map();
    for (const entry of entries) {
      const value = text(entry[field], 300);
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const most = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (most && most[1] >= 3 && most[1] > entries.length / 2) answers[field] = most[0];
  }
  return Object.keys(answers).length ? { samples: entries.length, answers, confirmed: true } : null;
}

/** Writes only explicit owner-selected trip data; all operations through policy.
 * @param {Env} env @param {any} args @param {number} nowMs @param {any} ctx */
export async function runTripWorkspace(env, args, nowMs, ctx) {
  if (!env.DB) throw new Error('Сховище поїздки недоступне.');
  if (!TRIP_WORKSPACE_OPS.includes(args.op)) throw new Error('Невідома дія для поїздки.');
  const id = String(args.trip_id),
    at = new Date(nowMs).toISOString();
  const input = object(args.data);
  if (args.op === 'leg' || args.op === 'place') input.id = key(input.id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { row, state, costs } = await rowFor(env, id, ctx);
    const travel = object(costs.travel);
    if (args.op === 'get') return { result: tripWorkspaceView(costs) };
    if (
      args.expected_revision != null &&
      Number(args.expected_revision) !== Number(travel.revision ?? 0)
    )
      throw new Error('Маршрут уже змінився. Спершу відкрий актуальну версію.');
    let facet, value;
    let entries = Array.isArray(costs.entries) ? [...costs.entries] : [];
    const beforeEntries = entries;
    /** @type {string|null} */
    let transactionId = null;
    if (args.op === 'restore_revision') {
      facet = 'legs';
      const saved = (Array.isArray(travel.versions) ? travel.versions : []).find(
        (/** @type {any} */ v) => v.revision === Number(input.revision),
      );
      if (!saved) throw new Error('Ця версія маршруту вже недоступна. Обери одну зі збережених.');
      value = saved.legs;
    } else if (args.op === 'leg' || args.op === 'remove_leg') {
      facet = 'legs';
      const legs = Array.isArray(travel.legs) ? travel.legs : [];
      const legId = key(input.id);
      value = legs.filter((/** @type {any} */ leg) => leg.id !== legId);
      if (args.op === 'leg') value.push(normalizedTripLeg({ ...input, id: legId }));
      else if (value.length === legs.length) throw new Error('Цей етап уже відсутній.');
      if (value.length > LIMITS.legs) throw new Error('Маршрут уже має 80 етапів.');
      value.sort((a, b) => a.start_ms - b.start_ms);
    } else if (args.op === 'place') {
      facet = 'places';
      const places = Array.isArray(travel.places) ? travel.places : [];
      const placeId = key(input.id);
      const status = String(input.status ?? 'saved');
      if (!['saved', 'visited', 'favorite', 'skipped'].includes(status))
        throw new Error('Уточни стан місця.');
      const old = places.find((/** @type {any} */ p) => p.id === placeId);
      const title = text(input.title ?? old?.title, 120);
      if (!title) throw new Error('Назви місце.');
      value = [
        ...places.filter((/** @type {any} */ p) => p.id !== placeId),
        {
          ...old,
          id: placeId,
          title,
          category: text(input.category ?? old?.category, 40),
          status,
          url: input.url == null ? (old?.url ?? null) : link(input.url),
          note: text(input.note ?? old?.note, 240),
          updated_at: at,
        },
      ];
      if (value.length > LIMITS.places) throw new Error('У журналі вже 120 місць.');
    } else if (args.op === 'review') {
      facet = 'reviews';
      const date = text(input.date, 10);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
      )
        throw new Error('Уточни день вражень.');
      if (
        (row.date_from && date < String(row.date_from)) ||
        (row.date_to && date > String(row.date_to))
      )
        throw new Error('Цей день поза датами поїздки. Уточни день або дати подорожі.');
      const note = text(input.note, 500),
        unfinished = text(input.unfinished, 300);
      if (!note && !unfinished) throw new Error('Напиши враження або що ще хочеш зробити.');
      value = [
        ...(Array.isArray(travel.reviews) ? travel.reviews : []).filter(
          (/** @type {any} */ r) => r.date !== date,
        ),
        { date, note, unfinished, at },
      ].slice(-LIMITS.reviews);
    } else if (args.op === 'monitor') {
      facet = 'monitor';
      if (typeof input.enabled !== 'boolean')
        throw new Error('Підтвердь, чи ввімкнути сповіщення.');
      if (input.enabled && input.consent !== true)
        throw new Error('Для фонових перевірок потрібна твоя згода.');
      const timezone = tripZone(input.timezone ?? state.preferences?.timezone);
      const interval_hours = Number(input.interval_hours ?? 6);
      if (!Number.isInteger(interval_hours) || interval_hours < 6 || interval_hours > 24)
        throw new Error('Інтервал перевірок — від 6 до 24 годин.');
      value = {
        enabled: input.enabled,
        consent: input.enabled,
        timezone,
        interval_hours,
        weather: input.weather !== false,
        road: input.road === true,
        service: input.service === true,
        max_checks_day: 4,
        max_alerts_day: 2,
        delay_minutes: 30,
        quiet_from: 22,
        quiet_to: 8,
        changed_at: at,
      };
    } else if (args.op === 'learn') {
      facet = 'pattern';
      if (input.consent !== true)
        throw new Error('Повторювані вподобання зберігаю лише за твоєю згодою.');
      const { results } = await env.DB.prepare(
        `SELECT t.cost_json,c.state_json FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.status='done' AND c.kind='trip' ORDER BY t.date_from DESC LIMIT 100`,
      )
        .bind()
        .all();
      const samples = (results ?? [])
        .filter((candidate) => {
          const target = chainTarget(env, object(candidate.state_json));
          return (
            String(target.chatId) === String(ctx.chatId) &&
            String(target.threadId ?? '') ===
              String(ctx.threadId === 'dm' ? '' : (ctx.threadId ?? ''))
          );
        })
        .map((candidate) => {
          const s = object(candidate.state_json);
          return { ...object(s.preferences), mode: s.mode, purpose: s.purpose };
        });
      value = commonTripPattern(samples);
      if (!value)
        throw new Error(
          'Ще немає щонайменше трьох завершених поїздок зі стійким спільним вподобанням.',
        );
    } else {
      facet = 'bank';
      transactionId = text(input.transaction_id, 120);
      if (!transactionId) throw new Error('Обери конкретну банківську операцію.');
      const existing = entries.find((/** @type {any} */ e) => e.transaction_id === transactionId);
      if (args.op === 'unlink_transaction') {
        if (!existing) throw new Error('Ця операція не привʼязана до поїздки.');
        entries = existing.bank_created
          ? entries.filter((/** @type {any} */ e) => e.id !== existing.id)
          : entries.map((/** @type {any} */ e) =>
              e.id === existing.id ? { ...e, transaction_id: null } : e,
            );
      } else {
        if (existing)
          return { result: { text: 'Ця операція вже привʼязана.', already_recorded: true } };
        const tx = await env.DB.prepare(
          'SELECT id,amount,currency,description FROM transactions WHERE id=?',
        )
          .bind(transactionId)
          .first();
        if (
          !tx ||
          Number(tx.amount) >= 0 ||
          !Number.isSafeInteger(Number(tx.amount)) ||
          !/^[A-Z]{3}$/.test(String(tx.currency))
        )
          throw new Error('Підтвердженої банківської витрати з цим id немає.');
        const duplicate = await env.DB.prepare(
          `SELECT t.id FROM trips t,json_each(json_extract(t.cost_json,'$.entries')) e WHERE json_extract(e.value,'$.transaction_id')=? LIMIT 1`,
        )
          .bind(transactionId)
          .first();
        if (duplicate) throw new Error('Ця операція вже врахована в іншій поїздці.');
        const minor = -Number(tx.amount),
          currency = String(tx.currency);
        const manual = input.entry_id
          ? entries.find((/** @type {any} */ e) => e.id === input.entry_id)
          : null;
        if (
          input.entry_id &&
          (!manual ||
            manual.minor !== minor ||
            manual.currency !== currency ||
            manual.transaction_id)
        )
          throw new Error('Ручний запис має іншу суму/валюту або вже звірений.');
        if (manual)
          entries = entries.map((/** @type {any} */ e) =>
            e.id === manual.id ? { ...e, transaction_id: transactionId } : e,
          );
        else {
          // A matching manual entry requires explicit reconciliation, not double counting.
          if (
            input.separate !== true &&
            entries.some(
              (/** @type {any} */ e) =>
                e.minor === minor && e.currency === currency && !e.transaction_id,
            )
          )
            throw new Error(
              'Є ручна витрата з цією сумою. Обери її entry_id для звірки або уточни, що це інша витрата.',
            );
          if (entries.length >= 200) throw new Error('У журналі вже 200 витрат.');
          entries = [
            ...entries,
            {
              id: crypto.randomUUID(),
              minor,
              currency,
              category: 'other',
              note: text(tx.description, 160),
              at,
              transaction_id: transactionId,
              bank_created: true,
            },
          ];
        }
      }
      value = { updated_at: at };
    }
    const before = travel[facet] ?? null;
    const revision = Number(travel.revision ?? 0) + 1;
    const next = {
      ...costs,
      entries,
      travel: {
        ...travel,
        [facet]: value,
        revision,
        ...(facet === 'legs'
          ? {
              versions: [
                ...(Array.isArray(travel.versions) ? travel.versions : []),
                { revision, at, legs: value },
              ].slice(-10),
            }
          : {}),
        history: [
          ...(Array.isArray(travel.history) ? travel.history : []),
          { at, op: args.op, revision },
        ].slice(-LIMITS.history),
      },
    };
    const saved = await env.DB.prepare(
      `UPDATE trips SET cost_json=? WHERE id=? AND cost_json IS ? AND status IN ('active','done')
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM trips other,json_each(json_extract(other.cost_json,'$.entries')) e WHERE other.id<>? AND json_extract(e.value,'$.transaction_id')=?))`,
    )
      .bind(
        JSON.stringify(next),
        id,
        row.cost_json ?? null,
        args.op === 'link_transaction' ? transactionId : null,
        id,
        transactionId,
      )
      .run();
    if (Number(saved.meta?.changes ?? 0) === 1)
      return {
        result: {
          ...(args.op === 'monitor'
            ? {
                monitor_services: {
                  weather: Boolean(env.WEATHER_API_KEY && env.WEATHER_QUOTA),
                  road: Boolean(env.MAPS_API_KEY),
                  service: 'manual_check_link',
                  flight_live: false,
                  lodging_live: false,
                },
              }
            : {}),
          text: /** @type {Record<string,string>} */ ({
            leg: 'Етап маршруту збережено.',
            remove_leg: 'Етап вилучено.',
            restore_revision: 'Версію маршруту відновлено.',
            place: 'Журнал місць оновлено.',
            review: 'Враження збережено.',
            monitor: input.enabled
              ? 'Сповіщення ввімкнено. До двох повідомлень на добу; вночі мовчу.'
              : 'Сповіщення вимкнено.',
            learn: 'Повторювані вподобання збережено.',
            link_transaction: 'Витрату звірено — без подвійного підрахунку.',
            unlink_transaction: 'Привʼязку витрати знято.',
          })[String(args.op)],
          ...tripWorkspaceView(next),
        },
        prev: {
          trip_id: id,
          facet,
          before,
          after: value,
          ...(facet === 'bank' ? { before_entries: beforeEntries, after_entries: entries } : {}),
        },
      };
  }
  throw new Error(
    'Дані змінилися паралельно або операція вже звірена. Відкрий актуальну поїздку й повтори.',
  );
}

/** Conflict-aware facet undo; never restores a whole stale trip snapshot.
 * @param {Env} env @param {any} snapshot */
export async function undoTripWorkspace(env, snapshot) {
  if (!env.DB) throw new Error('Сховище поїздки недоступне.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.DB.prepare('SELECT cost_json FROM trips WHERE id=?')
      .bind(snapshot.trip_id)
      .first();
    if (!row) return;
    const costs = object(row.cost_json),
      travel = object(costs.travel);
    if (
      JSON.stringify(travel[snapshot.facet] ?? null) !== JSON.stringify(snapshot.after) ||
      (snapshot.facet === 'bank' &&
        JSON.stringify(costs.entries) !== JSON.stringify(snapshot.after_entries))
    )
      throw new Error('Цю частину вже змінено після дії. Відкат не перезапише нові дані.');
    /** @type {Record<string,any>} */
    const next = {
      ...costs,
      travel: {
        ...travel,
        [snapshot.facet]: snapshot.before,
        revision: Number(travel.revision ?? 0) + 1,
      },
    };
    if (snapshot.facet === 'bank') next.entries = snapshot.before_entries;
    const saved = await env.DB.prepare(
      `UPDATE trips SET cost_json=? WHERE id=? AND cost_json IS ?
      AND NOT EXISTS (SELECT 1 FROM trips other,json_each(json_extract(other.cost_json,'$.entries')) e,json_each(?) restored
        WHERE other.id<>? AND json_extract(e.value,'$.transaction_id') IS NOT NULL AND json_extract(e.value,'$.transaction_id')=json_extract(restored.value,'$.transaction_id'))`,
    )
      .bind(
        JSON.stringify(next),
        snapshot.trip_id,
        row.cost_json ?? null,
        JSON.stringify(snapshot.facet === 'bank' ? snapshot.before_entries : []),
        snapshot.trip_id,
      )
      .run();
    if (Number(saved.meta?.changes ?? 0) === 1) return;
  }
  throw new Error('Не вдалося безпечно виконати відкат. Інші дані не змінював.');
}
