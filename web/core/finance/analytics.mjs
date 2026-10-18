import { validDate } from '../ops/system-period.mjs';
import { validateReportRange } from './reporting.mjs';
import { kyivParts, shiftDate, sumMoney } from './planning.mjs';
import { reportPeriod, shiftReportCutoff } from '../report-period.mjs';
/** Calendar periods shared by the assistant and dashboard, without 24h DST arithmetic.
 * @param {string} period @param {number} [nowMs] */
export function analyticsPeriod(period, nowMs = Date.now()) {
  const today = kyivParts(nowMs).date,
    raw = period.trim().toLowerCase();
  let from = today,
    to = today,
    comparison = 'adjacent';
  const relative = raw.match(/^(\d{1,3})([dwm])$/),
    month = raw.match(/^\d{4}-\d{2}$/),
    dates = raw.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (['день', 'сьогодні', 'today', '1d'].includes(raw)) {
    /* Current Kyiv calendar day. */
  } else if (['вчора', 'yesterday'].includes(raw)) from = to = shiftDate(today, -1);
  else if (['тиждень', 'week', '1w'].includes(raw))
    from = shiftDate(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  else if (['місяць', 'month', '1m'].includes(raw)) {
    from = today.slice(0, 7) + '-01';
    comparison = 'month';
  } else if (relative) {
    const n = Number(relative[1]),
      days = n * (relative[2] === 'w' ? 7 : relative[2] === 'm' ? 30 : 1);
    from = shiftDate(today, 1 - days);
  } else if (month) {
    from = raw + '-01';
    const last = new Date(Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(5)), 0))
      .toISOString()
      .slice(0, 10);
    to = last > today ? today : last;
    comparison = 'month';
  } else if (dates) {
    from = dates[1] ?? '';
    to = dates[2] ?? '';
  } else throw new Error('Некоректний період аналітики');
  analyticsSelection(new URLSearchParams({ from, to, comparison }), nowMs);
  return { from, to, comparison };
}

/** @param {URLSearchParams} params @param {number} [nowMs] */
export function analyticsSelection(params, nowMs = Date.now()) {
  const today = kyivParts(nowMs).date;
  const from = params.get('from') ?? shiftDate(today, -6),
    to = params.get('to') ?? today;
  if (!validDate(from) || !validDate(to)) throw new Error('Некоректні дати аналітики');
  const range = validateReportRange(from, to, nowMs);
  const account = params.get('account') ?? 'all',
    category = params.get('category') ?? '',
    merchant = params.get('merchant') ?? '',
    source = params.get('source') ?? 'all',
    status = params.get('status') ?? 'all',
    comparison = params.get('comparison') ?? 'adjacent';
  if (
    account.length > 120 ||
    category.length > 120 ||
    merchant.length > 500 ||
    !['all', 'mono', 'manual'].includes(source) ||
    !['all', 'confirmed', 'pending'].includes(status) ||
    !['adjacent', 'month'].includes(comparison)
  )
    throw new Error('Некоректні фільтри аналітики');
  let previousFrom = shiftDate(from, -range.days),
    previousTo = shiftDate(from, -1);
  if (comparison === 'month' && from.slice(8) === '01' && from.slice(0, 7) === to.slice(0, 7)) {
    const last = shiftDate(from, -1);
    previousFrom = `${last.slice(0, 7)}-01`;
    previousTo = shiftDate(previousFrom, Math.min(range.days, Number(last.slice(8))) - 1);
  }
  const period = reportPeriod(from, to, nowMs);
  const previousPeriod = reportPeriod(
    previousFrom,
    previousTo,
    period.complete
      ? nowMs
      : shiftReportCutoff(nowMs, (Date.parse(previousTo) - Date.parse(to)) / 86_400_000),
  );
  return {
    from,
    to,
    days: range.days,
    account,
    category,
    merchant,
    source,
    status,
    comparison,
    previousFrom,
    previousTo,
    period,
    previousPeriod,
  };
}
/** @param {import('./analytics.mjs').AnalyticsTransaction} tx
 * @param {import('./analytics.mjs').AnalyticsSelection} s @param {Record<string,string>} [aliases] */
export function matchesAnalytics(tx, s, aliases = {}) {
  const pending = Boolean(tx.bankHold && !tx.bankVerifiedByOwner);
  return (
    (s.account === 'all' || tx.accountId === s.account) &&
    (!s.category || tx.category === s.category) &&
    (!s.merchant ||
      tx.description === s.merchant ||
      merchantName(tx.description, aliases) === s.merchant) &&
    (s.source === 'all' || (s.source === 'mono' ? tx.bank : !tx.bank)) &&
    (s.status === 'all' || (s.status === 'pending' ? pending : !pending))
  );
}
/** Streaming reducer keeps amounts for the exact median, not raw ledger rows.
 * @param {import('./analytics.mjs').AnalyticsSelection} selection @param {Record<string,string>} [aliases] @param {boolean} [catalog] */
export function analyticsAccumulator(selection, aliases = {}, catalog = false) {
  const s = selection;
  const daily = Array.from({ length: s.days }, (_, i) => ({
    date: shiftDate(s.from, i),
    expenseMinor: 0,
    incomeMinor: 0,
    count: 0,
    cumulativeMinor: 0,
  }));
  const byDay = new Map(daily.map((d) => [d.date, d]));
  /** @type {Map<string,{category:string,amountMinor:number,count:number,previousCount:number,previousMinor:number,deltaMinor:number}>} */
  const categories = new Map();
  /** @type {Map<string,{merchant:string,amountMinor:number,count:number,previousCount:number,previousMinor:number,deltaMinor:number}>} */
  const merchants = new Map();
  /** @type {number[]} */ const amounts = [];
  const quality = {
    unclassifiedCount: 0,
    unclassifiedOutflowMinor: 0,
    unclassifiedInflowMinor: 0,
    unclassifiedUnknownCurrencyCount: 0,
    unknownCurrencyCount: 0,
    pendingCount: 0,
    pendingMinor: 0,
    possibleDuplicateCount: 0,
    resolvedDuplicateCount: 0,
    invalidDirectionCount: 0,
    amountChangedCount: 0,
  };
  let expenseMinor = 0,
    previousExpenseMinor = 0,
    otherIncomeMinor = 0,
    operationCount = 0;
  const sourceTotals = {
    mono: { expenseMinor: 0, count: 0 },
    manual: { expenseMinor: 0, count: 0 },
  };
  /** @type {{id:string,description:string,at:string,amountMinor:number}|null} */ let largest =
    null;
  /** @param {import('./analytics.mjs').AnalyticsTransaction} tx */
  const consume = (tx) => {
    const date = kyivParts(Date.parse(tx.at)).date;
    const at = Date.parse(tx.at);
    const current = date >= s.from && date <= s.to && (!s.period || at < Date.parse(s.period.to)),
      previous =
        date >= s.previousFrom &&
        date <= s.previousTo &&
        (!s.previousPeriod || at < Date.parse(s.previousPeriod.to));
    if ((!current && !previous) || !matchesAnalytics(tx, s, aliases)) return;
    if (current) {
      operationCount++;
      if (tx.kind === 'unclassified') {
        quality.unclassifiedCount++;
        if (tx.amountUah == null) quality.unclassifiedUnknownCurrencyCount++;
        else if (tx.amountUah < 0)
          quality.unclassifiedOutflowMinor = sumMoney([
            quality.unclassifiedOutflowMinor,
            -tx.amountUah,
          ]);
        else
          quality.unclassifiedInflowMinor = sumMoney([
            quality.unclassifiedInflowMinor,
            tx.amountUah,
          ]);
      }
      if (['expense', 'income'].includes(tx.kind) && tx.amountUah == null)
        quality.unknownCurrencyCount++;
      if (tx.duplicateSuspected) {
        if (tx.attention?.status === 'different') quality.resolvedDuplicateCount++;
        else quality.possibleDuplicateCount++;
      }
      if (tx.bankAmountChanged) quality.amountChangedCount++;
      if (tx.bankHold && !tx.bankVerifiedByOwner) {
        quality.pendingCount++;
        if (tx.kind === 'expense' && tx.amountUah != null && tx.amountUah < 0)
          quality.pendingMinor = sumMoney([quality.pendingMinor, -tx.amountUah]);
      }
    }
    if (tx.amountUah == null) return;
    if (
      (tx.kind === 'expense' && tx.amountUah >= 0) ||
      (tx.kind === 'income' && tx.amountUah <= 0)
    ) {
      if (current) quality.invalidDirectionCount++;
      return;
    }
    if (current && tx.kind === 'income') {
      otherIncomeMinor = sumMoney([otherIncomeMinor, tx.amountUah]);
      const day = byDay.get(date);
      if (day) day.incomeMinor = sumMoney([day.incomeMinor, tx.amountUah]);
    }
    if (tx.kind !== 'expense') return;
    const value = -tx.amountUah;
    if (current) {
      expenseMinor = sumMoney([expenseMinor, value]);
      const source = tx.bank ? sourceTotals.mono : sourceTotals.manual;
      source.expenseMinor = sumMoney([source.expenseMinor, value]);
      source.count++;
      amounts.push(value);
      const day = byDay.get(date);
      if (day) {
        day.expenseMinor = sumMoney([day.expenseMinor, value]);
        day.count++;
      }
      if (!largest || value > largest.amountMinor)
        largest = { id: tx.id, description: tx.description, at: tx.at, amountMinor: value };
    } else previousExpenseMinor = sumMoney([previousExpenseMinor, value]);
    const cat = categories.get(tx.category) ?? {
      category: tx.category,
      amountMinor: 0,
      count: 0,
      previousCount: 0,
      previousMinor: 0,
      deltaMinor: 0,
    };
    const name = merchantName(tx.description, aliases);
    const merchant = merchants.get(name) ?? {
      merchant: name,
      amountMinor: 0,
      count: 0,
      previousCount: 0,
      previousMinor: 0,
      deltaMinor: 0,
    };
    for (const row of [cat, merchant]) {
      if (current) {
        row.amountMinor = sumMoney([row.amountMinor, value]);
        row.count++;
      } else {
        row.previousMinor = sumMoney([row.previousMinor, value]);
        row.previousCount++;
      }
      row.deltaMinor = row.amountMinor - row.previousMinor;
    }
    categories.set(tx.category, cat);
    merchants.set(name, merchant);
  };
  const finish = () => {
    amounts.sort((a, b) => a - b);
    const n = amounts.length,
      median = n
        ? n % 2
          ? amounts[(n - 1) / 2]
          : Math.round(((amounts[n / 2 - 1] ?? 0) + (amounts[n / 2] ?? 0)) / 2)
        : null;
    let cumulative = 0;
    for (const day of daily) {
      cumulative = sumMoney([cumulative, day.expenseMinor]);
      day.cumulativeMinor = cumulative;
    }
    const weekdays = Array.from({ length: 7 }, (_, day) => {
      const rows = daily.filter(
        (d) => (new Date(d.date + 'T12:00:00Z').getUTCDay() + 6) % 7 === day,
      );
      return {
        day,
        days: rows.length,
        amountMinor: sumMoney(rows.map((d) => d.expenseMinor)),
        averageMinor: rows.length
          ? Math.round(sumMoney(rows.map((d) => d.expenseMinor)) / rows.length)
          : 0,
      };
    });
    const rankedMerchants = [...merchants.values()].filter((merchant) => merchant.count > 0);
    const merchantUnion = new Map(
      [
        ...[...rankedMerchants].sort((a, b) => b.amountMinor - a.amountMinor).slice(0, 100),
        ...[...rankedMerchants]
          .sort((a, b) => b.count - a.count || b.amountMinor - a.amountMinor)
          .slice(0, 100),
      ].map((row) => [row.merchant, row]),
    );
    return {
      selection: s,
      sourceTotals,
      summary: {
        expenseMinor,
        previousExpenseMinor,
        otherIncomeMinor,
        count: n,
        operationCount,
        medianMinor: median,
        averagePaymentMinor: n ? Math.round(expenseMinor / n) : null,
        averageDayMinor: Math.round(expenseMinor / s.days),
        activeDays: daily.filter((d) => d.count > 0).length,
        changeMinor: expenseMinor - previousExpenseMinor,
        changeBps: previousExpenseMinor
          ? Math.round(((expenseMinor - previousExpenseMinor) / previousExpenseMinor) * 10000)
          : null,
        largest,
      },
      categories: [...categories.values()].sort((a, b) => b.amountMinor - a.amountMinor),
      merchants: catalog ? rankedMerchants : [...merchantUnion.values()],
      merchantCount: rankedMerchants.length,
      daily,
      weekdays,
      quality,
    };
  };
  return { consume, finish };
}
/** @param {import('./analytics.mjs').AnalyticsTransaction[]} transactions
 * @param {import('./analytics.mjs').AnalyticsSelection} selection @param {Record<string,string>} [aliases] */
export function buildExpenseAnalytics(transactions, selection, aliases = {}) {
  const acc = analyticsAccumulator(selection, aliases);
  transactions.forEach(acc.consume);
  return acc.finish();
}
/** @param {string} name @param {Record<string,string>} [aliases] */
export function merchantName(name, aliases = {}) {
  return Object.hasOwn(aliases, name) && typeof aliases[name] === 'string' ? aliases[name] : name;
}
/** @param {unknown} input @returns {Record<string,string>} */
export function validateMerchantAliases(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length > 300
  )
    throw new Error('Некоректні правила продавців');
  const entries = Object.entries(input);
  for (const [name, group] of entries) {
    if (
      !name.trim() ||
      name.length > 500 ||
      typeof group !== 'string' ||
      !group.trim() ||
      group.length > 120 ||
      ['__proto__', 'constructor', 'prototype'].includes(name)
    )
      throw new Error('Некоректні правила продавців');
  }
  const result = Object.fromEntries(entries.map(([name, group]) => [name, group.trim()]));
  if (
    Object.values(result).some((group) => Object.hasOwn(result, group) && result[group] !== group)
  )
    throw new Error('Некоректні правила продавців: вкладені групи не підтримуються');
  return result;
}
/** @param {import('./analytics.mjs').AnalyticsTransaction} tx @param {string} [issue] */
export function matchesAnalyticsIssue(tx, issue = '') {
  if (issue === 'unknown-uah')
    return ['expense', 'income'].includes(tx.kind) && tx.amountUah == null;
  if (issue === 'duplicates')
    return Boolean(tx.duplicateSuspected && tx.attention?.status !== 'different');
  if (issue === 'direction')
    return (
      (tx.kind === 'expense' && tx.amountUah != null && tx.amountUah >= 0) ||
      (tx.kind === 'income' && tx.amountUah != null && tx.amountUah <= 0)
    );
  if (issue === 'changed') return Boolean(tx.bankAmountChanged);
  return !issue;
}
