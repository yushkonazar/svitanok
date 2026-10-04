export const PAYMENT_KIND_LABELS = {
  subscription: 'Підписка',
  loan: 'Кредит',
  installment: 'Оплата частинами',
  'card-installment': 'Розстрочка на картку',
  bill: 'Інший платіж',
};

export const INTEREST_METHOD_LABELS = {
  annuity: 'Рівний платіж · відсотки на залишок',
  declining: 'Рівне тіло · платіж зменшується',
  flat: 'Відсотки на початкову суму',
};

/** @typedef {{amountMinor:number, remainingMinor:number|null, totalMinor?:number|null, installmentsLeft?:number|null, rateBps?:number, feeMinor?:number, interestMethod?:string|null}} InterestDebt */
/** Monthly nominal rate: annual percent / 12. Daily accrual and effective APR need the bank schedule.
 * @param {InterestDebt} payment @param {number} [paidAmount] */
export function interestDebtPayment(payment, paidAmount) {
  const { interestMethod: method, remainingMinor: remaining, installmentsLeft: count } = payment;
  const rate = payment.rateBps ?? 0,
    fee = payment.feeMinor ?? 0;
  if (
    !method ||
    !Object.hasOwn(INTEREST_METHOD_LABELS, method) ||
    remaining == null ||
    !Number.isSafeInteger(remaining) ||
    remaining <= 0 ||
    !Number.isInteger(count) ||
    count == null ||
    count < 1 ||
    count > 1200 ||
    !Number.isInteger(rate) ||
    rate < 0 ||
    rate > 30000 ||
    !Number.isSafeInteger(fee) ||
    fee < 0
  )
    return null;
  const base = method === 'flat' ? payment.totalMinor : remaining;
  if (base == null || !Number.isSafeInteger(base) || base < remaining) return null;
  const interest = Math.round(base * (rate / 120000));
  const extra = interest + fee;
  const normalPrincipal =
    method === 'annuity' ? payment.amountMinor - extra : Math.ceil(remaining / count);
  if (!Number.isSafeInteger(normalPrincipal) || normalPrincipal <= 0) return null;
  const planned = (count === 1 ? remaining : Math.min(remaining, normalPrincipal)) + extra;
  const amount = paidAmount ?? planned;
  const principal = amount - extra;
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    principal <= 0 ||
    principal > remaining ||
    !Number.isSafeInteger(extra)
  )
    return null;
  return {
    amountMinor: amount,
    principalMinor: principal,
    overpaymentMinor: extra,
    interestMinor: interest,
  };
}

/** @param {number} principal @param {number} months @param {number} rateBps
 * @param {string} method @param {number} [feeMinor] @param {number} [originalPrincipal] */
export function interestQuote(
  principal,
  months,
  rateBps,
  method,
  feeMinor = 0,
  originalPrincipal = principal,
) {
  if (
    !Number.isSafeInteger(principal) ||
    principal <= 0 ||
    !Number.isSafeInteger(originalPrincipal) ||
    originalPrincipal < principal ||
    !Number.isInteger(months) ||
    months < 1 ||
    months > 1200 ||
    !Number.isInteger(rateBps) ||
    rateBps < 0 ||
    rateBps > 30000 ||
    !Number.isSafeInteger(feeMinor) ||
    feeMinor < 0 ||
    !Object.hasOwn(INTEREST_METHOD_LABELS, method)
  )
    return null;
  const r = rateBps / 120000;
  const nominal =
    method === 'annuity'
      ? Math.round(
          r === 0 ? principal / months : (principal * r) / -Math.expm1(-months * Math.log1p(r)),
        ) + feeMinor
      : Math.ceil(principal / months) +
        Math.round((method === 'flat' ? originalPrincipal : principal) * r) +
        feeMinor;
  const state = {
    amountMinor: nominal,
    remainingMinor: principal,
    totalMinor: originalPrincipal,
    installmentsLeft: months,
    rateBps,
    feeMinor,
    interestMethod: method,
  };
  let total = 0,
    first = 0,
    last = 0;
  for (let i = 0; i < months && state.remainingMinor > 0; i++) {
    const pay = interestDebtPayment(state);
    if (!pay) return null;
    if (i === 0) first = pay.amountMinor;
    last = pay.amountMinor;
    total += pay.amountMinor;
    state.remainingMinor -= pay.principalMinor;
    state.installmentsLeft--;
  }
  if (state.remainingMinor !== 0 || !Number.isSafeInteger(total)) return null;
  return {
    amountMinor: first,
    totalMinor: total,
    overpaymentMinor: total - principal,
    lastAmountMinor: last,
  };
}

/** @param {string} kind */
export function isDebtKind(kind) {
  return ['loan', 'installment', 'card-installment'].includes(kind);
}

// Remaining principal, not future interest. Rounded integer minor units only.
/** @param {number} amountMinor @param {number} count @param {number} feeMinor @param {number} rateBps */
export function estimateRemaining(amountMinor, count, feeMinor = 0, rateBps = 0) {
  if (
    rateBps !== 0 ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 1200 ||
    !Number.isSafeInteger(feeMinor) ||
    feeMinor < 0 ||
    feeMinor >= amountMinor
  )
    return null;
  const remaining = (amountMinor - feeMinor) * count;
  return Number.isSafeInteger(remaining) ? remaining : null;
}

/** @param {number} principal @param {number} overpayment @param {number} months */
export function installmentQuote(principal, overpayment, months) {
  const total = principal + overpayment;
  if (
    !Number.isSafeInteger(principal) ||
    principal <= 0 ||
    !Number.isSafeInteger(overpayment) ||
    overpayment < 0 ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(months) ||
    months < 1 ||
    months > 1200 ||
    total < months
  )
    return null;
  // Keep regular payments rounded down; the final payment absorbs only kopecks.
  const regular = Math.floor(total / months);
  return {
    totalMinor: total,
    amountMinor: regular,
    lastAmountMinor: total - regular * (months - 1),
  };
}

/** @typedef {{amountMinor:number, remainingMinor:number|null, installmentsLeft?:number|null, overpaymentRemainingMinor?:number|null}} FixedDebt */
/** @param {FixedDebt} payment @param {number} [paidAmount] */
export function fixedDebtPayment(payment, paidAmount) {
  if (payment.remainingMinor == null || payment.overpaymentRemainingMinor == null) return null;
  const total = payment.remainingMinor + payment.overpaymentRemainingMinor;
  if (!Number.isSafeInteger(total) || total < 0) return null;
  const amount =
    paidAmount ?? (payment.installmentsLeft === 1 ? total : Math.min(payment.amountMinor, total));
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > total) return null;
  // Split exactly in minor units. Recompute on the outstanding balances so that
  // the final payment exhausts both principal and the agreed overpayment.
  const principal =
    total === 0
      ? 0
      : Math.min(payment.remainingMinor, Math.round((amount / total) * payment.remainingMinor));
  return { amountMinor: amount, principalMinor: principal, overpaymentMinor: amount - principal };
}
