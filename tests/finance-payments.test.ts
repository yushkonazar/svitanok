import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  estimateRemaining,
  installmentQuote,
  fixedDebtPayment,
  interestQuote,
  interestDebtPayment,
} from '../web/core/finance/payments.mjs';
import { d1FromSqlite } from './helpers/d1.js';

describe('payment balances and schema expansion', () => {
  it('distinguishes annuity, declining principal and flat nominal annual interest', () => {
    expect(interestQuote(120000, 12, 1200, 'annuity')).toEqual({
      amountMinor: 10662,
      totalMinor: 127942,
      overpaymentMinor: 7942,
      lastAmountMinor: 10660,
    });
    expect(interestQuote(120000, 12, 1200, 'declining')).toEqual({
      amountMinor: 11200,
      totalMinor: 127800,
      overpaymentMinor: 7800,
      lastAmountMinor: 10100,
    });
    expect(interestQuote(120000, 12, 1200, 'flat')).toEqual({
      amountMinor: 11200,
      totalMinor: 134400,
      overpaymentMinor: 14400,
      lastAmountMinor: 11200,
    });
    expect(interestQuote(120000, 12, 0, 'annuity', 100)).toEqual({
      amountMinor: 10100,
      totalMinor: 121200,
      overpaymentMinor: 1200,
      lastAmountMinor: 10100,
    });
  });
  it('recalculates from outstanding principal and refuses incomplete or non-amortizing input', () => {
    expect(interestQuote(60000, 6, 1200, 'flat', 0, 120000)?.totalMinor).toBe(67200);
    for (const [principal, months, rate, method] of [
      [0, 12, 1200, 'annuity'],
      [120000, 0, 1200, 'annuity'],
      [120000, 12, 30001, 'annuity'],
      [120000, 12, 1200, 'guess'],
      [120000, 1.5, 1200, 'flat'],
    ] as const)
      expect(interestQuote(principal, months, rate, method)).toBeNull();
    const pay = {
      amountMinor: 10662,
      remainingMinor: 120000,
      totalMinor: 120000,
      installmentsLeft: 12,
      rateBps: 1200,
      interestMethod: 'annuity',
    };
    expect(interestDebtPayment(pay)).toMatchObject({ principalMinor: 9462, interestMinor: 1200 });
    expect(interestDebtPayment(pay, 1200)).toBeNull();
    expect(interestDebtPayment({ ...pay, installmentsLeft: 1 })).toMatchObject({
      amountMinor: 121200,
      principalMinor: 120000,
    });
    expect(interestDebtPayment({ ...pay, interestMethod: null })).toBeNull();
    expect(interestQuote(Number.MAX_SAFE_INTEGER, 12, 1200, 'flat')).toBeNull();
  });
  it('keeps a 550 plus 125 installment exact across all twelve monthly payments', () => {
    const quote = installmentQuote(55000, 12500, 12)!;
    expect(quote).toEqual({ totalMinor: 67500, amountMinor: 5625, lastAmountMinor: 5625 });
    const state = {
      amountMinor: quote.amountMinor,
      remainingMinor: 55000,
      overpaymentRemainingMinor: 12500,
      installmentsLeft: 12,
    };
    let principal = 0,
      extra = 0,
      total = 0;
    while (state.installmentsLeft > 0) {
      const pay = fixedDebtPayment(state)!;
      expect(pay.amountMinor).toBe(5625);
      state.remainingMinor -= pay.principalMinor;
      state.overpaymentRemainingMinor -= pay.overpaymentMinor;
      state.installmentsLeft--;
      principal += pay.principalMinor;
      extra += pay.overpaymentMinor;
      total += pay.amountMinor;
    }
    expect({ principal, extra, total }).toEqual({ principal: 55000, extra: 12500, total: 67500 });
    expect(state.remainingMinor + state.overpaymentRemainingMinor).toBe(0);
    expect(installmentQuote(55000, 12501, 12)!.lastAmountMinor).toBe(5626);
    expect(installmentQuote(55000, -1, 12)).toBeNull();
    expect(installmentQuote(55000, 12500, 12.5)).toBeNull();
    expect(
      fixedDebtPayment(
        { ...state, remainingMinor: 55000, overpaymentRemainingMinor: 12500 },
        67501,
      ),
    ).toBeNull();
  });
  it('computes kopecks without including fees as principal or inventing interest', () => {
    expect(estimateRemaining(5000, 12)).toBe(60000);
    expect(estimateRemaining(9070, 12)).toBe(108840);
    expect(estimateRemaining(5100, 12, 100)).toBe(60000);
    expect(estimateRemaining(5000, 12, 0, 2400)).toBeNull();
    expect(estimateRemaining(5000, 0)).toBeNull();
    expect(estimateRemaining(5000, 1.5)).toBeNull();
    expect(estimateRemaining(Number.MAX_SAFE_INTEGER, 12)).toBeNull();
  });
  it('retains every payment field while permitting card installments', () => {
    const { db } = d1FromSqlite([
      '0001_base.sql',
      '0005_finance.sql',
      '0028_mini_app_finance.sql',
      '0029_finance_credit_limits.sql',
    ]);
    db.exec(
      `INSERT INTO finance_payments VALUES('keep-payment','Proove','installment',9070,108840,12,'2026-10-09',9,'month','покупка частинами',3,'active',181400,0,0,'Mono','Не змінювати','2026-10-04T12:00:00Z')`,
    );
    const before = db.prepare('SELECT * FROM finance_payments').all();
    db.exec(
      readFileSync(
        new URL('../web/core/migrations/0030_finance_card_installment.sql', import.meta.url),
        'utf8',
      ),
    );
    expect(db.prepare('SELECT * FROM finance_payments').all()).toEqual(before);
    db.exec("UPDATE finance_payments SET kind = 'card-installment' WHERE id = 'keep-payment'");
    expect(db.prepare('SELECT kind FROM finance_payments').get()!.kind).toBe('card-installment');
    db.close();
  });
});
