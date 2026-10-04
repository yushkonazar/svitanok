export const PAYMENT_KIND_LABELS = {
  subscription: 'Підписка',
  loan: 'Кредит',
  installment: 'Оплата частинами',
  'card-installment': 'Розстрочка на картку',
  bill: 'Інший платіж',
};

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
