export const DEFAULT_THRESHOLDS = [20000, 100000, 300000];
/** @param {any} value */
export function financeDisplay(value) {
  const x = value && typeof value === 'object' ? value : {};
  const thresholds = Array.isArray(x.expenseThresholds) ? x.expenseThresholds : DEFAULT_THRESHOLDS;
  if (
    thresholds.length > 20 ||
    thresholds.some(
      (/** @type {any} */ n, /** @type {number} */ i) =>
        !Number.isSafeInteger(n) || n <= 0 || (i > 0 && n <= thresholds[i - 1]),
    )
  )
    throw new Error('Межі витрат мають зростати, бути додатними та не повторюватися (до 20 меж).');
  return {
    expenseThresholds: [...thresholds],
    currencyCycle: x.currencyCycle !== false,
    animations: x.animations !== false,
    expenseForecast: ['history', 'plan'].includes(x.expenseForecast)
      ? x.expenseForecast
      : 'history',
    savingWeekday:
      Number.isInteger(x.savingWeekday) && x.savingWeekday >= 0 && x.savingWeekday <= 6
        ? x.savingWeekday
        : 2,
  };
}
/** Suggestions are quantiles of actual personal UAH debits, never automatic settings writes.
 * @param {any[]} transactions @param {number} [count] */
export function recommendThresholds(transactions, count = 3) {
  const amounts = transactions
    .filter((t) => t.kind === 'expense' && t.amountUah < 0 && !t.bankMissingFromStatement)
    .map((t) => -t.amountUah)
    .sort((a, b) => a - b);
  if (amounts.length < 10) return { values: [], observations: amounts.length };
  const values = [
    ...new Set(
      Array.from({ length: Math.min(10, count) }, (_, i) => {
        const v = amounts[Math.floor(((amounts.length - 1) * (i + 1)) / (count + 1))] ?? 0;
        const unit = v >= 100000 ? 10000 : v >= 10000 ? 1000 : 100;
        return Math.max(unit, Math.round(v / unit) * unit);
      }),
    ),
  ];
  return { values, observations: amounts.length };
}
/** @param {any} tx */
export function isTerminalTopup(tx) {
  return Boolean(
    tx.bank &&
    tx.amountUah > 0 &&
    tx.currency === 'UAH' &&
    !tx.reference &&
    !tx.bankMissingFromStatement &&
    tx.kind !== 'income' &&
    /(?:термінал\s*mono|mono\s*(?:terminal|термінал)|terminal\s*mono)/iu.test(tx.description),
  );
}
