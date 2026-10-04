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
