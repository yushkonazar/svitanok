import { analyticsSelection, analyticsAccumulator, merchantName } from './analytics.mjs';
import { readFinanceWorkspace, financeTransactionOf } from './workspace.mjs';
import { buildFinanceReport, validateReportRange } from './reporting.mjs';
import { NOT_TEST_SQL } from './store.mjs';
import { kyivParts, shiftDate, sumMoney } from './planning.mjs';
import { financeReviewAccumulator, financeReviewContext } from './review.mjs';

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
 * @param {Env} env @param {URLSearchParams} params @param {number} [nowMs]
 * @param {boolean} [catalog] @param {{review?:boolean,context?:boolean}} [options] */
export async function readFinanceAnalytics(
  env,
  params,
  nowMs = Date.now(),
  catalog = false,
  options = {},
) {
  if (!env.DB) throw new Error('Finance DB unavailable');
  const s = analyticsSelection(params, nowMs);
  const f = await readFinanceWorkspace(env, nowMs, undefined, { omitTransactions: true });
  const review = options.review ? financeReviewAccumulator(s, f.payments, f.merchantAliases) : null;
  const current = validateReportRange(s.from, s.to, nowMs),
    previous = validateReportRange(s.previousFrom, s.previousTo, nowMs);
  const from = new Date(Math.min(current.start, previous.start)).toISOString();
  const to = s.period?.to ?? new Date(Math.min(current.end, nowMs + 1)).toISOString();
  const acc = analyticsAccumulator(
      s,
      params.get('ungrouped') === '1' ? {} : f.merchantAliases,
      catalog,
    ),
    global = analyticsAccumulator(
      {
        ...s,
        account: 'all',
        category: '',
        merchant: '',
        source: 'all',
        status: 'all',
      },
      f.merchantAliases,
    );
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
      review?.consume(tx);
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
  const previousBeforeFirstRecord =
    !oldest?.oldest || s.previousFrom < kyivParts(Date.parse(String(oldest.oldest))).date;
  if (previousBeforeFirstRecord || s.previousFrom < shiftDate(kyivParts(nowMs).date, -720))
    data.summary.changeBps = null;
  let context;
  if (options.context) {
    const nightly = await env.DB.prepare(
      "SELECT value_json FROM facts WHERE kind='setting' AND key='mono_statement_sync' LIMIT 1",
    )
      .bind()
      .first();
    let metadata = null;
    try {
      metadata = JSON.parse(String(nightly?.value_json ?? 'null'));
    } catch {
      /* No verified timestamp. */
    }
    context = financeReviewContext(f, nowMs, metadata);
  }
  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    ...data,
    review: review?.finish(),
    context,
    report,
    reportScope: 'all-accounts',
    coverage: {
      bankRetentionDays: 720,
      oldestTransactionAt: oldest?.oldest ?? null,
      beyondBankRetention: s.previousFrom < shiftDate(kyivParts(nowMs).date, -720),
      previousBeforeFirstRecord,
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
    day = params.get('day'),
    issue = params.get('issue') ?? '',
    weekday = params.get('weekday'),
    transactionId = params.get('transactionId');
  if (
    !['', 'unknown-uah', 'duplicates', 'direction', 'changed'].includes(issue) ||
    (weekday != null && !/^[0-6]$/.test(weekday)) ||
    (transactionId != null && (!transactionId || transactionId.length > 160))
  )
    throw new Error('Некоректний фільтр операцій');
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
    const settings = await env.DB.prepare('SELECT * FROM finance_settings WHERE id = ?')
      .bind('owner')
      .first();
    /** @type {Record<string,string>} */ let aliases = {};
    try {
      const parsed = JSON.parse(String(settings?.merchant_aliases_json ?? '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) aliases = parsed;
    } catch {
      /* no groups */
    }
    const names = [
      ...new Set([
        s.merchant,
        ...Object.keys(aliases).filter((name) => merchantName(name, aliases) === s.merchant),
      ]),
    ];
    clauses.push("COALESCE(description,'') IN (SELECT value FROM json_each(?))");
    bindings.push(JSON.stringify(names));
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
  if (params.has('categories')) {
    let categories;
    try {
      categories = JSON.parse(params.get('categories') ?? '');
    } catch {
      throw new Error('Некоректні категорії операцій');
    }
    if (
      !Array.isArray(categories) ||
      categories.length > 200 ||
      categories.some((c) => typeof c !== 'string' || c.length > 120)
    )
      throw new Error('Некоректні категорії операцій');
    clauses.push("COALESCE(category,'інше') IN (SELECT value FROM json_each(?))");
    bindings.push(JSON.stringify(categories));
  }
  if (transactionId) {
    clauses.push('id = ?');
    bindings.push(transactionId);
  }
  if (issue === 'unknown-uah')
    clauses.push(`(${KIND}) IN ('expense','income') AND amount_uah IS NULL`);
  if (issue === 'duplicates')
    clauses.push(
      `COALESCE(flags_json,'[]') LIKE '%"duplicate"%' AND NOT (COALESCE(${value('financeAttention.status')},'') = 'different' AND COALESCE(${value('financeAttention.source')},'') = 'owner' AND julianday(${value('financeAttention.at')}) IS NOT NULL)`,
    );
  if (issue === 'direction')
    clauses.push(
      `((${KIND}) = 'expense' AND amount_uah >= 0 OR (${KIND}) = 'income' AND amount_uah <= 0)`,
    );
  if (issue === 'changed') clauses.push(`COALESCE(${value('financeBankAmountChanged')},0) <> 0`);
  if (weekday != null) {
    const dates = Array.from({ length: s.days }, (_, i) => shiftDate(s.from, i))
      .filter((date) => (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7 === Number(weekday))
      .map((date) => {
        const r = validateReportRange(date, date, nowMs);
        return { start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() };
      });
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(?) AS dates WHERE transactions.at >= json_extract(dates.value,'$.start') AND transactions.at < json_extract(dates.value,'$.end'))",
    );
    bindings.push(JSON.stringify(dates));
  }
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
/** @param {Env} env @param {URLSearchParams} params @param {number} [nowMs] */
export async function readAnalyticsMerchants(env, params, nowMs = Date.now()) {
  const search = params.get('search') ?? '',
    sort = params.get('sort') ?? 'amount',
    after = params.get('after');
  if (search.length > 200 || !['amount', 'count'].includes(sort) || (after?.length ?? 0) > 3000)
    throw new Error('Некоректний пошук продавців');
  const data = await readFinanceAnalytics(env, params, nowMs, true);
  const ranked = data.merchants
    .filter((m) =>
      m.merchant.toLocaleLowerCase('uk-UA').includes(search.toLocaleLowerCase('uk-UA')),
    )
    .sort((a, b) =>
      sort === 'count'
        ? b.count - a.count ||
          b.amountMinor - a.amountMinor ||
          a.merchant.localeCompare(b.merchant, 'uk')
        : b.amountMinor - a.amountMinor || a.merchant.localeCompare(b.merchant, 'uk'),
    );
  /** @type {string|undefined} */ let afterName;
  if (after) {
    try {
      afterName = JSON.parse(after).merchant;
    } catch {
      throw new Error('Некоректна сторінка продавців');
    }
    if (typeof afterName !== 'string') throw new Error('Некоректна сторінка продавців');
  }
  const index = after ? ranked.findIndex((m) => m.merchant === afterName) + 1 : 0;
  if (after && index === 0) throw new Error('Некоректна сторінка продавців');
  const items = ranked.slice(index, index + 50);
  return {
    ok: true,
    items,
    total: ranked.length,
    nextCursor:
      index + 50 < ranked.length
        ? JSON.stringify({ merchant: items.at(-1)?.merchant ?? '' })
        : null,
  };
}
