import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  estimateRemaining,
  installmentQuote,
  fixedDebtPayment,
} from '../web/core/finance/payments.mjs';
import { d1FromSqlite } from './helpers/d1.js';

describe('payment balances and schema expansion', () => {
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
