import { calculateTaxiWeek, taxiWeek, taxiEntryWeek, kyivParts, sumMoney } from './planning.mjs';

const DAY = 86400000;
/** @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? (s[(s.length - 1) / 2] ?? 0)
    : ((s[s.length / 2 - 1] ?? 0) + (s[s.length / 2] ?? 0)) / 2;
};
/** @param {number[]} xs */
const weighted = (xs) =>
  xs.reduce((n, v, i) => n + v * (xs.length - i), 0) / ((xs.length * (xs.length + 1)) / 2);
/** @type {Record<string,(xs:number[])=>number>} */
const predictors = { median, weighted, last: (xs) => xs[0] ?? 0 };
/** Rolling-origin comparison uses only earlier completed periods, never the held-out week.
 * @param {number[]} chronological */
export function chooseIncomeModel(chronological) {
  /** @type {Record<string,number[]>} */ const errors = { median: [], weighted: [], last: [] };
  for (let i = 3; i < chronological.length; i++) {
    const train = chronological.slice(Math.max(0, i - 8), i).reverse();
    for (const [name, predict] of Object.entries(predictors))
      (errors[name] ??= []).push(Math.abs(predict(train) - (chronological[i] ?? 0)));
  }
  const folds = errors.median?.length ?? 0;
  const scores = Object.entries(errors).map(([name, values]) => ({
    name,
    mae: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
  }));
  const selected =
    folds >= 3
      ? ([...scores].sort((a, b) => (a.mae ?? Infinity) - (b.mae ?? Infinity))[0]?.name ?? 'median')
      : 'median';
  return { selected, folds, mae: scores.find((s) => s.name === selected)?.mae ?? null, scores };
}
/** Empirical remaining-work scenarios, repriced using the current historical taxi rules.
 * Estimates are cashflow at handover, not spendable money today or promised income.
 * @param {any} finance @param {number} nowMs */
export function taxiIncomeForecast(finance, nowMs) {
  /** @type {any[]} */ const policies = finance.policies ?? [];
  /** @type {any[]} */ const entries = finance.taxiEntries ?? [];
  if (!policies.some((p) => Date.parse(p.effectiveAt) <= nowMs))
    return { status: 'unavailable', reason: 'Немає чинних умов таксі.' };
  const period = taxiWeek(nowMs, policies);
  const actual = entries.filter(
    (e) => taxiEntryWeek(e, policies).key === period.key && Date.parse(e.at) <= nowMs,
  );
  const complete = actual.every((e) => e.commissionReported !== false && e.cashReported !== false);
  const current = calculateTaxiWeek(actual, policies, nowMs);
  const held = sumMoney(actual.map((e) => (e.receivedCashMinor ?? 0) - (e.paidWorkMinor ?? 0)));
  const settled = /** @type {any[]} */ (finance.settlements ?? []).some(
    (s) => s.weekKey === period.key,
  );
  const pendingMinor = settled ? 0 : Math.max(0, current.earnedMinor - held);
  const date = kyivParts(period.to).date;
  const history = /** @type {any[]} */ (finance.taxiWeeks ?? [])
    .filter(
      (w) =>
        w.to <= period.from &&
        w.complete !== false &&
        w.to - w.from >= 6 * DAY &&
        w.to - w.from <= 8 * DAY,
    )
    .sort((a, b) => b.from - a.from)
    .slice(0, 8);
  const common = {
    date,
    at: new Date(period.to).toISOString(),
    periodKey: period.key,
    historyPeriods: history.length,
    pendingMinor,
    currentEarnedMinor: current.earnedMinor,
    heldMinor: held,
  };
  if (!complete)
    return {
      ...common,
      status: 'incomplete',
      reason: 'Уточни комісію та отриману готівку в записах таксі.',
    };
  if (history.length < 3)
    return {
      ...common,
      status: 'insufficient',
      reason: 'Для прогнозу майбутньої роботи потрібні щонайменше три повні завершені періоди.',
      estimateMinor: pendingMinor,
      lowerMinor: pendingMinor,
      upperMinor: pendingMinor,
    };
  const progress = Math.max(0, Math.min(1, (nowMs - period.from) / (period.to - period.from)));
  const scenarios = history.map((week) => {
    const prior = entries.filter(
      (e) => taxiEntryWeek(e, policies).key === week.key && Date.parse(e.at) < week.to,
    );
    const future = prior
      .filter((e) => (Date.parse(e.at) - week.from) / (week.to - week.from) > progress)
      .map((e) => {
        const at =
          period.from +
          ((Date.parse(e.at) - week.from) / (week.to - week.from)) * (period.to - period.from);
        const policy = [...policies]
          .filter((p) => Date.parse(p.effectiveAt) <= at)
          .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
        return {
          ...e,
          id: `forecast:${week.key}:${e.id}`,
          at: new Date(at).toISOString(),
          policyId: policy.id,
          periodKey: period.key,
        };
      });
    const projected = calculateTaxiWeek([...actual, ...future], policies, nowMs);
    return Math.max(0, projected.earnedMinor - current.earnedMinor);
  });
  // Validate the same remaining-period quantity, not a full-week total.
  // Every held-out period can use only periods completed before it.
  const historicalRemainders = history.map((week) => {
    const prior = entries.filter(
      (e) => taxiEntryWeek(e, policies).key === week.key && Date.parse(e.at) < week.to,
    );
    const prefix = prior.filter(
      (e) => (Date.parse(e.at) - week.from) / (week.to - week.from) <= progress,
    );
    return Math.max(
      0,
      calculateTaxiWeek(prior, policies, week.from).earnedMinor -
        calculateTaxiWeek(prefix, policies, week.from).earnedMinor,
    );
  });
  const validation = chooseIncomeModel([...historicalRemainders].reverse());
  const estimate = Math.round((predictors[validation.selected] ?? median)(scenarios));
  const sorted = [...scenarios].sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) * 0.1)] ?? estimate,
    high = sorted[Math.ceil((sorted.length - 1) * 0.9)] ?? estimate;
  return {
    ...common,
    status: 'estimated',
    model: validation.selected,
    validation,
    futureEarnedMinor: estimate,
    estimateMinor: sumMoney([pendingMinor, estimate]),
    lowerMinor: sumMoney([pendingMinor, Math.min(low, estimate)]),
    upperMinor: sumMoney([pendingMinor, Math.max(high, estimate)]),
    reason:
      'Сценарії решти роботи за останніми повними періодами; чинні частки, комісія, пальне та поріг перераховані. Це оцінка на дату перезмінки.',
  };
}
