import { loadDraft, tripScopeKey } from '../tools/trip.mjs';
import { planningStageKey } from './planning-basis.mjs';

const BASIS = [
  'to',
  'from_city',
  'date_from',
  'date_to',
  'mode',
  'transport_count',
  'destination_count',
  'lodging_count',
  'lodging_from',
  'lodging_to',
  'lodging_layout',
  'budget_total',
  'budget_currency',
  'budget_scope',
  'constraints',
  'accessibility',
  'baggage',
];
/** @param {any} answers */
export function tripResearchBasis(answers) {
  return Object.fromEntries(BASIS.map((key) => [key, answers[key] ?? null]));
}
/** @param {unknown} value @param {number} max */
const text = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);
/** @param {unknown} value */
function source(value) {
  const u = new URL(String(value));
  if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 1200)
    throw new Error('Додай HTTPS-джерело пропозиції.');
  return u.href;
}
/** @param {string} identity */
function optionId(identity) {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(identity))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return `offer-${hash.toString(16).padStart(16, '0')}`;
}
/** Only bounded reference data may enter this quarantine. It cannot set owner facts, book, or start support.
 * @param {any} raw @param {number} nowMs */
export function normalizeTripOption(raw, nowMs) {
  if (!['transport', 'stay', 'activity'].includes(raw.kind))
    throw new Error('Уточни тип пропозиції.');
  const title = text(raw.title, 160),
    id = text(
      raw.id || optionId(`${raw.kind}|${source(raw.source_url)}|${title}|${text(raw.dates, 120)}`),
      64,
    );
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id) || !title)
    throw new Error('Уточни назву та ідентифікатор пропозиції.');
  const checked = Date.parse(String(raw.checked_at));
  if (!Number.isFinite(checked) || checked > nowMs + 300_000 || checked < nowMs - 30 * 86_400_000)
    throw new Error('Пропозиція потребує свіжої дати перевірки.');
  let price = null;
  if (raw.price != null) {
    const p = raw.price,
      amount = Number(p.amount),
      quantity = Number(p.quantity ?? 1);
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 100_000_000 ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 1000 ||
      !/^[A-Z]{3}$/.test(String(p.currency)) ||
      !['person', 'group', 'room_night', 'stay', 'ticket', 'entry'].includes(p.unit)
    )
      throw new Error('Ціна потребує додатної суми, валюти, одиниці й кількості.');
    price = {
      amount,
      currency: String(p.currency),
      unit: p.unit,
      quantity,
      includes: text(p.includes, 240),
      excludes: text(p.excludes, 240),
      total_confirmed: p.total_confirmed === true,
    };
  }
  const availability = ['unverified', 'page_observed', 'provider_quote'].includes(raw.availability)
    ? raw.availability
    : 'unverified';
  return {
    id,
    kind: raw.kind,
    title,
    provider: text(raw.provider, 100),
    source_url: source(raw.source_url),
    checked_at: new Date(checked).toISOString(),
    availability,
    price,
    dates: text(raw.dates, 120),
    schedule: text(raw.schedule, 300),
    location: text(raw.location, 160),
    cancellation: text(raw.cancellation, 300),
    tradeoffs: text(raw.tradeoffs, 500),
    missing: text(raw.missing, 400),
    status: 'candidate',
  };
}
/** Material terms are compared without timestamps: a fresh check does not undo an owner choice.
 * @param {any} option */
function optionTerms(option) {
  return Object.fromEntries(
    [
      'title',
      'kind',
      'provider',
      'source_url',
      'price',
      'dates',
      'schedule',
      'location',
      'cancellation',
    ].map((key) => [key, option?.[key] ?? null]),
  );
}
/** Older choices get their original terms once, before any external refresh can replace them.
 * @param {any} research */
function selectionSnapshots(research) {
  const snapshots = { ...research.selection_snapshots };
  for (const [kind, id] of Object.entries(research.selections ?? {})) {
    if (snapshots[kind]) continue;
    const option = (research.options ?? []).find((/** @type {any} */ o) => o.id === id);
    if (option)
      snapshots[kind] = {
        option,
        basis: research.basis,
        selected_at: research.selected_at ?? null,
      };
  }
  return snapshots;
}
/** @param {any} answers @param {number} nowMs */
export function tripResearchView(answers, nowMs) {
  const research = answers._research ?? {};
  const stale =
    research.stale === true ||
    JSON.stringify(research.basis ?? {}) !== JSON.stringify(tripResearchBasis(answers));
  const options = (research.options ?? []).map((/** @type {any} */ o) => ({
    ...o,
    stale:
      stale ||
      (o.planning_basis != null && o.planning_basis !== planningStageKey(answers, o.kind)) ||
      !Number.isFinite(Date.parse(o.checked_at)) ||
      Date.parse(o.checked_at) < nowMs - 24 * 3_600_000,
  }));
  const snapshots = selectionSnapshots(research);
  /** @type {Record<string,unknown>} */
  const selections = {};
  const selection_warnings = [];
  for (const [kind, id] of Object.entries(research.selections ?? {})) {
    const snapshot = snapshots[kind],
      current = options.find((/** @type {any} */ o) => o.id === id);
    if (
      snapshot &&
      current &&
      !current.stale &&
      JSON.stringify(snapshot.basis) === JSON.stringify(tripResearchBasis(answers)) &&
      JSON.stringify(optionTerms(snapshot.option)) === JSON.stringify(optionTerms(current))
    ) {
      selections[kind] = id;
    } else {
      const label =
        { transport: 'Транспорт', stay: 'Житло', activity: 'Заняття' }[kind] ?? 'Варіант';
      selection_warnings.push(
        `${label}: попередній вибір збережено, але його умови потребують перевірки й повторного підтвердження.`,
      );
    }
  }
  return {
    ...research,
    stale,
    options,
    selections,
    previous_selections: snapshots,
    selection_warnings,
    note: 'Ціна та наявність потребують повторної перевірки перед оплатою. Вибір варіанта не створює бронювання.',
  };
}
/** @param {Env} env @param {any} args @param {number} nowMs @param {any} ctx */
export async function runTripOptions(env, args, nowMs, ctx) {
  const scope = tripScopeKey(ctx);
  if (!scope || !env.DB) throw new Error('Не вдалося визначити чат поїздки.');
  const row = await loadDraft(env, scope, String(args.draft_id), null, nowMs);
  if (!row) throw new Error('Чернетку поїздки не знайдено.');
  const answers = JSON.parse(String(row.answers_json));
  const old = answers._research ?? {},
    revision = Number(old.revision ?? 0);
  if (args.expected_revision != null && Number(args.expected_revision) !== revision)
    throw new Error('Пропозиції змінилися. Онови список.');
  if (args.op === 'get')
    return { result: { draft_id: row.id, ...tripResearchView(answers, nowMs) } };
  let next;
  if (args.op === 'save') {
    if (
      !Array.isArray(args.options) ||
      args.options.length > 12 ||
      (!args.options.length && !text(args.summary, 1000))
    )
      throw new Error(
        'Передай до 12 перевірених пропозицій або поясни, чого не вдалося перевірити.',
      );
    // The caller must identify the exact owner brief it researched, never silently rebase old findings.
    if (
      !args.basis ||
      JSON.stringify(tripResearchBasis(args.basis)) !== JSON.stringify(tripResearchBasis(answers))
    )
      throw new Error('Бриф змінився під час пошуку. Перевір варіанти за актуальними умовами.');
    const incoming = args.options.map((/** @type {any} */ o) => normalizeTripOption(o, nowMs));
    if (new Set(incoming.map((/** @type {any} */ o) => o.id)).size !== incoming.length)
      throw new Error('Ідентифікатори варіантів мають відрізнятися.');
    const sameBasis =
        old.stale !== true &&
        JSON.stringify(old.basis) === JSON.stringify(tripResearchBasis(answers)),
      previous = sameBasis ? (old.options ?? []) : [],
      pinned = previous.filter((/** @type {any} */ o) =>
        Object.values(old.selections ?? {}).includes(o.id),
      ),
      byId = new Map();
    // Keep other search categories. New observations replace candidates, never the owner's snapshot.
    for (const option of [...incoming, ...pinned, ...previous])
      if (!byId.has(option.id)) byId.set(option.id, option);
    const options = [...byId.values()].slice(0, 36);
    next = {
      basis: tripResearchBasis(answers),
      options,
      selections: { ...old.selections },
      selection_snapshots: selectionSnapshots(old),
      summary: text(args.summary, 1000),
      stale: false,
      revision: revision + 1,
      checked_at: new Date(nowMs).toISOString(),
      provenance: 'external_reference',
    };
  } else if (args.op === 'select') {
    const view = tripResearchView(answers, nowMs),
      option = view.options.find((/** @type {any} */ o) => o.id === args.option_id);
    if (!option) throw new Error('Цього варіанта вже немає. Онови список.');
    if (option.stale)
      throw new Error(
        'Цей варіант потребує повторної перевірки за актуальними датами та складом групи.',
      );
    next = {
      ...old,
      selections: { ...old.selections, [option.kind]: option.id },
      selection_snapshots: {
        ...selectionSnapshots(old),
        [option.kind]: {
          option,
          basis: tripResearchBasis(answers),
          selected_at: new Date(nowMs).toISOString(),
        },
      },
      revision: revision + 1,
      selected_at: new Date(nowMs).toISOString(),
    };
  } else throw new Error('Невідома дія з варіантами поїздки.');
  const value = { ...answers, _research: next };
  const saved = await env.DB.prepare(
    'UPDATE trip_briefs SET answers_json=?,updated_at=? WHERE id=? AND scope_key=? AND answers_json=?',
  )
    .bind(JSON.stringify(value), new Date(nowMs).toISOString(), row.id, scope, row.answers_json)
    .run();
  if (Number(saved.meta?.changes ?? 0) !== 1)
    throw new Error('План змінився паралельно. Онови його перед повтором.');
  const result = {
    draft_id: String(row.id),
    ...tripResearchView(value, nowMs),
    text:
      args.op === 'select'
        ? 'Варіант обрано. Бронювання ще не зроблено.'
        : 'Пропозиції з джерелами збережено.',
  };
  return {
    result: { ...result, selection_card: tripOptionsCard(result) },
    prev: { draft_id: row.id, scope, before: old, after: next },
  };
}
/** Stable list indices are bound to research revision and never interpreted as model text.
 * @param {any} result @param {number} page */
export function tripOptionsCard(result, page = 0) {
  const options = result.options ?? [];
  if (!options.length) return null;
  page = Math.max(0, Math.min(Math.floor(Number(page) || 0), Math.ceil(options.length / 6) - 1));
  const start = page * 6,
    visible = options.slice(start, start + 6);
  const lines = visible.map(
    (/** @type {any} */ o, /** @type {number} */ i) =>
      `${start + i + 1}. ${o.title}${o.price ? ` · ${o.price.amount} ${o.price.currency} (${o.price.unit} × ${o.price.quantity})` : ' · ціну не підтверджено'}${result.selections?.[o.kind] === o.id ? ' · обрано' : ''}\n${o.source_url}`,
  );
  const buttons = visible
    .filter((/** @type {any} */ o) => !o.stale)
    .map((/** @type {any} */ o) => [
      {
        text: `Обрати: ${o.title}`.slice(0, 40),
        callback_data: `m:to:${result.draft_id}:s:${options.indexOf(o)}:${result.revision}`,
      },
    ]);
  // Two options per row keep all six choices and navigation in Telegram's compact envelope.
  const compact = [];
  for (let i = 0; i < buttons.length; i += 2)
    compact.push([...(buttons[i] ?? []), ...(buttons[i + 1] ?? [])]);
  const navigation = [];
  if (page > 0)
    navigation.push({
      text: '← Попередні',
      callback_data: `m:to:${result.draft_id}:p:${page - 1}:${result.revision}`,
    });
  if (start + 6 < options.length)
    navigation.push({
      text: 'Наступні →',
      callback_data: `m:to:${result.draft_id}:p:${page + 1}:${result.revision}`,
    });
  if (navigation.length) compact.push(navigation);
  return {
    text: `🧳 Варіанти поїздки\n${(result.selection_warnings ?? []).join('\n')}${result.selection_warnings?.length ? '\n\n' : ''}${lines.join('\n\n')}\n\n${result.stale ? 'Умови змінилися — потрібна повторна перевірка.' : 'Обраний варіант ще потребує бронювання власником.'}`.slice(
      0,
      2000,
    ),
    buttons: compact,
  };
}
/** @param {Env} env @param {any} snapshot */
export async function undoTripOptions(env, snapshot) {
  if (!env.DB) throw new Error('Сховище недоступне.');
  const row = await env.DB.prepare(
    'SELECT answers_json FROM trip_briefs WHERE id=? AND scope_key=?',
  )
    .bind(snapshot.draft_id, snapshot.scope)
    .first();
  if (!row) return;
  const answers = JSON.parse(String(row.answers_json));
  if (JSON.stringify(answers._research) !== JSON.stringify(snapshot.after))
    throw new Error('Пропозиції вже змінено. Відкат не перезапише нові дані.');
  const result = await env.DB.prepare(
    'UPDATE trip_briefs SET answers_json=? WHERE id=? AND answers_json=?',
  )
    .bind(
      JSON.stringify({ ...answers, _research: snapshot.before }),
      snapshot.draft_id,
      row.answers_json,
    )
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw new Error('Пропозиції змінилися паралельно.');
}
