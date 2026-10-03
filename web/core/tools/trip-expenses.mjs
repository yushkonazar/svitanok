import { chainTarget } from '../chains/state.mjs';
import { formatMoney } from '../format.mjs';

export const TRIP_EXPENSE_CATEGORIES = [
  'transport',
  'lodging',
  'food',
  'activities',
  'shopping',
  'other',
];

/** @param {unknown} raw @returns {Record<string,any>} */
function costObject(raw) {
  if (raw == null) return {};
  const parsed = JSON.parse(String(raw));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Запис витрат пошкоджений — не перезаписую його.');
  return parsed;
}

/** Owner-declared ledger: never guesses trip membership from transaction dates.
 * @param {Env} env @param {any} args @param {number} nowMs @param {any} ctx */
export async function runTripExpense(env, args, nowMs, ctx) {
  if (!env.DB || ctx?.chatId == null) throw new Error('Не вдалося визначити чат поїздки.');
  const amount = Number(args.amount);
  const minor = Math.round(amount * 100);
  const currency = String(args.currency ?? 'UAH').toUpperCase();
  const category = String(args.category ?? 'other');
  const id = String(args.entry_id ?? crypto.randomUUID());
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(minor) ||
    minor <= 0 ||
    minor > 10_000_000_000
  )
    throw new Error('Уточни додатну суму витрати.');
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    !TRIP_EXPENSE_CATEGORIES.includes(category) ||
    !/^[a-zA-Z0-9-]{8,64}$/.test(id)
  )
    throw new Error('Уточни валюту або категорію витрати.');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await env.DB.prepare(
      `SELECT t.id, t.status, t.cost_json, c.state_json FROM trips t
      JOIN chains c ON c.id = t.workflow_id WHERE t.id = ? AND c.kind = 'trip'`,
    )
      .bind(String(args.trip_id))
      .first();
    if (!row || !['active', 'done'].includes(String(row.status)))
      throw new Error('Поїздку для витрати не знайдено або її скасовано.');
    const destination = chainTarget(env, JSON.parse(String(row.state_json ?? '{}')));
    if (
      String(destination.chatId) !== String(ctx.chatId) ||
      String(destination.threadId ?? '') !==
        String(ctx.threadId === 'dm' ? '' : (ctx.threadId ?? ''))
    )
      throw new Error('Ця поїздка належить іншому чату.');
    const costs = costObject(row.cost_json);
    const entries = Array.isArray(costs.entries) ? costs.entries : [];
    const entry = {
      id,
      minor,
      currency,
      category,
      note: String(args.note ?? '')
        .trim()
        .slice(0, 160),
      at: new Date(nowMs).toISOString(),
    };
    const existing = entries.find((/** @type {any} */ value) => value?.id === id);
    if (existing) {
      if (
        existing.minor !== minor ||
        existing.currency !== currency ||
        existing.category !== category ||
        existing.note !== entry.note
      )
        throw new Error('Цей ідентифікатор уже має іншу витрату.');
      return { result: { entry_id: id, already_recorded: true, text: 'Ця витрата вже записана.' } };
    }
    if (entries.length >= 200) throw new Error('У поїздці вже 200 витрат — нову не записав.');
    const saved = await env.DB.prepare(
      "UPDATE trips SET cost_json = ? WHERE id = ? AND cost_json IS ? AND status IN ('active', 'done')",
    )
      .bind(
        JSON.stringify({ ...costs, entries: [...entries, entry] }),
        row.id,
        row.cost_json ?? null,
      )
      .run();
    if (Number(saved.meta?.changes ?? 0) === 1)
      return {
        result: {
          entry_id: id,
          text: `Записав у поїздку: ${formatMoney(minor, currency)}${entry.note ? ` — ${entry.note}` : ''}.`,
        },
        prev: { trip_id: String(row.id), entry_id: id },
      };
  }
  throw new Error('Витрати змінилися паралельно. Повтори з тим самим entry_id.');
}

/** Undo only its own entry, preserving later records and owner totals.
 * @param {Env} env @param {{trip_id:string,entry_id:string}} snapshot */
export async function undoTripExpense(env, snapshot) {
  if (!env.DB) throw new Error('Сховище витрат недоступне.');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await env.DB.prepare('SELECT cost_json FROM trips WHERE id = ?')
      .bind(snapshot.trip_id)
      .first();
    if (!row) return;
    const costs = costObject(row.cost_json);
    if (
      !Array.isArray(costs.entries) ||
      !costs.entries.some((/** @type {any} */ value) => value?.id === snapshot.entry_id)
    )
      return;
    const next = {
      ...costs,
      entries: costs.entries.filter((/** @type {any} */ value) => value?.id !== snapshot.entry_id),
    };
    const saved = await env.DB.prepare(
      'UPDATE trips SET cost_json = ? WHERE id = ? AND cost_json IS ?',
    )
      .bind(JSON.stringify(next), snapshot.trip_id, row.cost_json ?? null)
      .run();
    if (Number(saved.meta?.changes ?? 0) === 1) return;
  }
  throw new Error('Не вдалося безпечно вилучити витрату — інші записи не змінював.');
}

/** Totals by currency; no invented conversion or addition to overlapping actual.
 * @param {unknown} raw */
export function tripExpenseSummary(raw) {
  try {
    const costs = costObject(raw);
    const entries = (Array.isArray(costs.entries) ? costs.entries : []).filter(
      (/** @type {any} */ entry) =>
        Number.isSafeInteger(entry?.minor) && entry.minor > 0 && /^[A-Z]{3}$/.test(entry.currency),
    );
    /** @type {Record<string,number>} */
    const totals = {};
    for (const entry of entries)
      totals[entry.currency] = (totals[entry.currency] ?? 0) + entry.minor;
    return {
      entries: entries.slice(-200),
      totals_minor_by_currency: totals,
      complete: false,
      note: 'Лише явно записані витрати. Власний підсумок actual не додається: він може містити ці самі витрати.',
    };
  } catch {
    return {
      entries: [],
      totals_minor_by_currency: {},
      complete: false,
      note: 'Запис витрат не вдалося прочитати; це не означає нуль витрат.',
    };
  }
}
