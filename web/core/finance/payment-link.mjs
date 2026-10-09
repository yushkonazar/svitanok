/** Bank rows keep the merchant currency; debt accounting needs the card's actual UAH debit.
 * @param {{bank:boolean,amountUah:number|null,amountMinor:number,currency:string}} tx */
export function bankPaymentAmount(tx) {
  if (!tx.bank) return null;
  return tx.amountUah ?? (tx.currency === 'UAH' ? tx.amountMinor : null);
}
