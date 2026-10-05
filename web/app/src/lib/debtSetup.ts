import { parseMoney } from '../../../core/finance/planning.mjs';
import {
  installmentQuote,
  interestQuote,
  interestDebtPayment,
  fixedDebtPayment,
  estimateRemaining,
} from '../../../core/finance/payments.mjs';

/** Importing a schedule only describes debt; it never creates historical transactions. */
export function debtSetup(v: Record<string, string>) {
  const money = (key: string, optional = false) =>
    optional && !v[key]?.trim() ? 0 : parseMoney(v[key]);
  const integer = (value: string, label: string, min: number, max: number) => {
    const n = Number(value);
    if (!value.trim() || !Number.isInteger(n) || n < min || n > max)
      throw new Error(`${label}: вкажи ціле число від ${min} до ${max}`);
    return n;
  };
  const mode = v.paymentSetup;
  const calculated = mode !== 'schedule';
  const total = v.total.trim() ? money('total') : null;
  const term = calculated ? integer(v.termMonths, 'Повний термін', 1, 1200) : null;
  const rate = mode === 'total-cost' ? 0 : money('rate');
  const fee = mode === 'total-cost' ? 0 : money('fee', true);
  if (rate < 0 || rate > 30000) throw new Error('Річна ставка має бути від 0 до 300%.');
  const extra = mode === 'total-cost' ? money('overpayment', true) : null;
  const quote =
    mode === 'total-cost'
      ? installmentQuote(total ?? 0, extra ?? 0, term!)
      : mode === 'interest'
        ? interestQuote(total ?? 0, term!, rate, v.interestMethod, fee)
        : null;
  if (calculated && !quote)
    throw new Error(
      'Вкажи суму, повний термін і переплату або номінальну річну ставку від 0 до 300%',
    );
  let amount = calculated ? quote!.amountMinor : money('amount');
  let remaining = total;
  let extraRemaining = extra;
  let left = term;
  let paidAmount: number | null = null;
  if (calculated && v.progressMode !== 'bank') {
    const paid =
      v.progressMode === 'paid' ? integer(v.paidCount, 'Уже сплачено платежів', 0, term!) : 0;
    if (paid === term)
      throw new Error('Усі платежі вже сплачені. Активний борг додавати не потрібно.');
    paidAmount = 0;
    for (let i = 0; i < paid; i++) {
      const state = {
        amountMinor: amount,
        remainingMinor: remaining,
        totalMinor: total,
        installmentsLeft: left,
        rateBps: rate,
        feeMinor: fee,
        interestMethod: mode === 'interest' ? v.interestMethod : null,
        overpaymentRemainingMinor: extraRemaining,
      };
      const pay = mode === 'interest' ? interestDebtPayment(state) : fixedDebtPayment(state);
      if (!pay) throw new Error('Не вдалося побудувати графік. Перевір умови за банком.');
      paidAmount += pay.amountMinor;
      remaining! -= pay.principalMinor;
      if (extraRemaining != null) extraRemaining -= pay.overpaymentMinor;
      left!--;
    }
  } else {
    left = integer(v.months, 'Платежів ще залишилося', 1, term ?? 1200);
    if (!calculated && v.remainingMode === 'auto') {
      remaining = estimateRemaining(amount, left, fee, rate);
      if (remaining == null)
        throw new Error('За наявності відсотків вкажи точний залишок тіла з банку.');
    } else {
      remaining = money('remaining');
      if (mode === 'total-cost') extraRemaining = money('extraRemaining', true);
    }
    if (mode === 'interest') {
      const q = interestQuote(remaining!, left, rate, v.interestMethod, fee, total ?? 0);
      if (!q) throw new Error('Перевір поточний залишок, ставку й кількість майбутніх платежів.');
      amount = v.amountOverride.trim() ? money('amountOverride') : q.amountMinor;
    } else if (mode === 'total-cost' && v.amountOverride.trim()) amount = money('amountOverride');
  }
  if (amount <= 0 || fee >= amount) throw new Error('Платіж має бути більшим за нуль і комісію.');
  if (remaining == null || remaining <= 0) throw new Error('Вкажи додатний залишок боргу.');
  if (total != null && remaining > total)
    throw new Error('Залишок не може перевищувати початкову суму.');
  if (extra != null && (extraRemaining! < 0 || extraRemaining! > extra))
    throw new Error('Залишок переплати не може перевищувати всю переплату.');
  let futureTotal = 0,
    last = amount,
    next = amount;
  if (calculated) {
    const state = {
      amountMinor: amount,
      remainingMinor: remaining,
      totalMinor: total,
      installmentsLeft: left,
      rateBps: rate,
      feeMinor: fee,
      interestMethod: mode === 'interest' ? v.interestMethod : null,
      overpaymentRemainingMinor: extraRemaining,
    };
    for (let i = 0; i < left!; i++) {
      const pay = mode === 'interest' ? interestDebtPayment(state) : fixedDebtPayment(state);
      if (!pay || pay.amountMinor <= 0)
        throw new Error('Графік не відповідає залишку. Звір платіж і кількість із банком.');
      if (i === 0) next = pay.amountMinor;
      futureTotal += pay.amountMinor;
      last = pay.amountMinor;
      state.remainingMinor -= pay.principalMinor;
      if (state.overpaymentRemainingMinor != null)
        state.overpaymentRemainingMinor -= pay.overpaymentMinor;
      state.installmentsLeft!--;
    }
    if (state.remainingMinor !== 0 || (state.overpaymentRemainingMinor ?? 0) !== 0)
      throw new Error('Графік не погашає залишок повністю. Перевір дані.');
  } else if (rate === 0) {
    let principalLeft = remaining;
    for (let i = 0; i < left!; i++) {
      if (principalLeft <= 0)
        throw new Error('Борг погашається раніше. Уточни кількість платежів за банком.');
      const principal = Math.min(principalLeft, amount - fee);
      last = principal + fee;
      if (i === 0) next = last;
      futureTotal += last;
      principalLeft -= principal;
    }
    if (principalLeft !== 0)
      throw new Error('Платежі не покривають залишок. Перевір графік банку.');
  } else futureTotal = amount * left!;
  if (!Number.isSafeInteger(futureTotal)) throw new Error('Сума графіка надто велика.');
  return {
    amountMinor: amount,
    remainingMinor: remaining,
    installmentsLeft: left!,
    totalMinor: total,
    rateBps: rate,
    feeMinor: fee,
    ...(mode === 'interest' ? { interestMethod: v.interestMethod, termMonths: term! } : {}),
    ...(mode === 'total-cost'
      ? {
          overpaymentTotalMinor: extra!,
          overpaymentRemainingMinor: extraRemaining!,
          termMonths: term!,
        }
      : {}),
    preview: { paidAmount, futureTotal, next, last, contractTotal: quote?.totalMinor ?? null },
  };
}
