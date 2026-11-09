/** Bank rows keep the merchant currency; debt accounting needs the card's actual UAH debit.
 * @param {{bank:boolean,amountUah:number|null,amountMinor:number,currency:string}} tx */
export function bankPaymentAmount(tx) {
  if (!tx.bank) return null;
  return tx.amountUah ?? (tx.currency === 'UAH' ? tx.amountMinor : null);
}

/** @param {{bankHold?: boolean, bankVerifiedByOwner?: boolean, bankAmountChanged?: boolean}|null|undefined} tx */
export function needsBankHoldConfirmation(tx) {
  return Boolean(tx?.bankHold && (!tx.bankVerifiedByOwner || tx.bankAmountChanged));
}
