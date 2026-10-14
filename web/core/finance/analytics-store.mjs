import { analyticsSelection, analyticsAccumulator } from './analytics.mjs';
import { readFinanceWorkspace, financeTransactionOf } from './workspace.mjs';
import { buildFinanceReport, validateReportRange } from './reporting.mjs';
import { NOT_TEST_SQL } from './store.mjs';
import { kyivParts, shiftDate, sumMoney } from './planning.mjs';

const COLUMNS = 'id,at,amount,currency,amount_uah,category,description,raw_json,flags_json';
const RAW = "CASE WHEN json_valid(raw_json) THEN raw_json ELSE '{}' END";
const value = (/** @type {string} */ key) => `json_extract((${RAW}),'$.${key}')`;
const BANK = `COALESCE(${value('account')},'') <> ''`;
const ACCOUNT = `COALESCE(${value('financeAccount')},CASE WHEN ${BANK} THEN 'mono:' || ${value('account')} ELSE NULL END)`;
const PENDING = `COALESCE(${value('hold')},0) <> 0 AND COALESCE(${value('financeBankVerifiedByOwner')},0) = 0`;
const KIND = `CASE WHEN COALESCE(${value('bankMissingFromStatement')},0) <> 0 AND (${PENDING}) THEN 'unclassified' ELSE COALESCE(${value('financeKind')},CASE WHEN amount < 0 THEN CASE WHEN category = 'перекази й готівка' THEN 'unclassified' ELSE 'expense' END ELSE 'unclassified' END) END`;
/** @param {string|null} cursor */
function readCursor(cursor) {
  if (!cursor) return null;
  try {
    if (cursor.length > 700) throw new Error();
    const x = JSON.parse(cursor);
    if (
      typeof x.at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(x.at) ||
      !Number.isFinite(Date.parse(x.at)) ||
      typeof x.id !== 'string' ||
      !x.id ||
      x.id.length > 160
    )
      throw new Error();
    return { at: x.at, id: x.id };
  } catch {
    throw new Error('Некоректний курсор операцій');
  }
}
/** Reads bounded pages on the server; the phone receives aggregates, not the ledger.
 * @param {Env} env @param {URLSearchParams} params @param {number} [nowMs] */
export async function readFinanceAnalytics(env, params, nowMs = Date.now()) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  const s = analyticsSelection(params, nowMs);
  const f = await readFinanceWorkspace(env, nowMs, undefined, { omitTransactions: true });
  const current = validateReportRange(s.from, s.to, nowMs),
    previous = validateReportRange(s.previousFrom, s.previousTo, nowMs);
  const from = new Date(Math.min(current.start, previous.start)).toISOString();
  const to = new Date(Math.min(current.end, nowMs + 1)).toISOString();
  const acc = analyticsAccumulator(s),
    global = analyticsAccumulator({
      ...s,
      account: 'all',
      category: '',
      merchant: '',
      source: 'all',
      status: 'all',
    });
  /** @type {{at:string,id:string}|null} */ let cursor = null;
  // Never return a silently truncated total. Large windows must be narrowed.
  for (let page = 0; ; page++) {
    if (page >= 20) throw new Error('Забагато операцій для одного звіту. Обери коротший період.');
    /** @type {{results?:KvBlob[]}} */ const result = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM transactions WHERE at >= ? AND at < ? AND ${NOT_TEST_SQL} ${cursor ? 'AND (at < ? OR (at = ? AND id < ?))' : ''} ORDER BY at DESC,id DESC LIMIT 2001`,
    )
      .bind(from, to, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []))
      .all();
    /** @type {KvBlob[]} */ const rows = (result.results ?? []).slice(0, 2000);
    for (const row of rows) {
      const tx = financeTransactionOf(row);
      acc.consume(tx);
      global.consume(tx);
    }
    if ((result.results?.length ?? 0) <= 2000) break;
    /** @type {KvBlob|undefined} */ const last = rows.at(-1);
    cursor = { at: String(last?.at), id: String(last?.id) };
  }
  const data = acc.finish(),
    all = global.finish();
  const base = buildFinanceReport(f, s.from, s.to, nowMs);
  const report = {
    ...base,
    expenseMinor: all.summary.expenseMinor,
    otherIncomeMinor: all.summary.otherIncomeMinor,
    resultMinor: sumMoney([
      base.taxiEarnedMinor,
      base.settlementDifferenceMinor,
      all.summary.otherIncomeMinor,
      -all.summary.expenseMinor,
    ]),
    unclassifiedCount: all.quality.unclassifiedCount,
    unknownCurrencyCount: all.quality.unknownCurrencyCount,
    categories: all.categories.map(({ category, amountMinor, count }) => ({
      category,
      amountMinor,
      count,
    })),
    daily: all.daily.map(({ date, expenseMinor, incomeMinor }) => ({
      date,
      expenseMinor,
      incomeMinor,
    })),
  };
  const oldest = await env.DB.prepare(
    `SELECT MIN(at) AS oldest FROM transactions WHERE ${NOT_TEST_SQL}`,
  )
    .bind()
    .first();
  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    ...data,
    report,
    reportScope: 'all-accounts',
    coverage: {
      bankRetentionDays: 720,
      oldestTransactionAt: oldest?.oldest ?? null,
      beyondBankRetention: s.previousFrom < shiftDate(kyivParts(nowMs).date, -720),
    },
  };
}
/** Keyset pagination uses the same filters/classification as the aggregates.
 * @param {Env} env @param {URLSearchParams} params @param {number} [nowMs] */
export async function readAnalyticsOperations(env, params, nowMs = Date.now()) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  const s = analyticsSelection(params, nowMs),
    range = validateReportRange(s.from, s.to, nowMs);
  const cursor = readCursor(params.get('cursor')),
    kind = params.get('kind') ?? 'expense',
    day = params.get('day');
  if (!['expense', 'income', 'transfer', 'unclassified', 'all'].includes(kind))
    throw new Error('Некоректний тип операцій');
  if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < s.from || day > s.to))
    throw new Error('Некоректний день операцій');
  const clauses = [`at >= ?`, `at < ?`, NOT_TEST_SQL];
  /** @type {(string|number)[]} */ const bindings = [
    new Date(range.start).toISOString(),
    new Date(Math.min(range.end, nowMs + 1)).toISOString(),
  ];
  if (s.account !== 'all') {
    clauses.push(`${ACCOUNT} = ?`);
    bindings.push(s.account);
  }
  if (s.category) {
    clauses.push("COALESCE(category,'інше') = ?");
    bindings.push(s.category);
  }
  if (s.merchant) {
    clauses.push("COALESCE(description,'') = ?");
    bindings.push(s.merchant);
  }
  if (s.source !== 'all') clauses.push(s.source === 'mono' ? BANK : `NOT (${BANK})`);
  if (s.status !== 'all')
    clauses.push(s.status === 'pending' ? `(${PENDING})` : `NOT (${PENDING})`);
  if (kind !== 'all') {
    clauses.push(`(${KIND}) = ?`);
    bindings.push(kind);
  }
  if (kind === 'expense') clauses.push('amount_uah < 0');
  if (kind === 'income') clauses.push('amount_uah > 0');
  if (day) {
    const d = validateReportRange(day, day, nowMs);
    clauses.push('at >= ? AND at < ?');
    bindings.push(new Date(d.start).toISOString(), new Date(d.end).toISOString());
  }
  if (cursor) {
    clauses.push('(at < ? OR (at = ? AND id < ?))');
    bindings.push(cursor.at, cursor.at, cursor.id);
  }
  const result = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM transactions WHERE ${clauses.join(' AND ')} ORDER BY at DESC,id DESC LIMIT 51`,
  )
    .bind(...bindings)
    .all();
  const rows = result.results ?? [],
    more = rows.length > 50,
    items = rows.slice(0, 50).map(financeTransactionOf),
    last = items.at(-1);
  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    items,
    nextCursor: more && last ? JSON.stringify({ at: last.at, id: last.id }) : null,
  };
}
