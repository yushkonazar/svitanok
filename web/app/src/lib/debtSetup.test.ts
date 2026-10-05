import { describe, expect, it } from 'vitest';
import { debtSetup } from './debtSetup.ts';
const base = {
  paymentSetup: 'total-cost',
  total: '550',
  overpayment: '125',
  termMonths: '12',
  progressMode: 'new',
  paidCount: '',
  rate: '0',
  fee: '0',
  amountOverride: '',
  remaining: '',
  extraRemaining: '',
  months: '',
  interestMethod: 'annuity',
};
describe('guided debt import', () => {
  it('derives paid and outstanding sums without historical transactions', () => {
    const plan = debtSetup({ ...base, progressMode: 'paid', paidCount: '3' });
    expect(plan).toMatchObject({
      amountMinor: 5625,
      remainingMinor: 41251,
      overpaymentRemainingMinor: 9374,
      installmentsLeft: 9,
      preview: {
        paidAmount: 16875,
        futureTotal: 50625,
        next: 5625,
        last: 5625,
        contractTotal: 67500,
      },
    });
    expect(plan.preview.paidAmount! + plan.preview.futureTotal).toBe(plan.preview.contractTotal);
  });
  it('absorbs kopecks only in the final payment and permits zero paid', () => {
    const plan = debtSetup({
      ...base,
      total: '100',
      overpayment: '0',
      termMonths: '3',
      progressMode: 'paid',
      paidCount: '2',
    });
    expect(plan.preview).toMatchObject({
      paidAmount: 6666,
      futureTotal: 3334,
      next: 3334,
      last: 3334,
    });
    expect(debtSetup({ ...base, progressMode: 'paid', paidCount: '0' }).remainingMinor).toBe(55000);
  });
  it.each(['annuity', 'declining', 'flat'])(
    'imports %s progress along the original schedule',
    (interestMethod) => {
      const v = { ...base, paymentSetup: 'interest', total: '1200', rate: '12', interestMethod };
      const full = debtSetup(v);
      const partial = debtSetup({ ...v, progressMode: 'paid', paidCount: '5' });
      expect(partial.installmentsLeft).toBe(7);
      expect(partial.preview.paidAmount! + partial.preview.futureTotal).toBe(
        full.preview.futureTotal,
      );
      expect(partial.remainingMinor).toBeLessThan(full.remainingMinor);
      if (interestMethod === 'annuity') expect(partial.amountMinor).toBe(full.amountMinor);
      if (interestMethod === 'flat') expect(partial.preview.next).toBe(full.preview.next);
      if (interestMethod === 'declining')
        expect(partial.preview.next).toBeLessThan(full.preview.next);
    },
  );
  it('preserves exact bank balances rather than overwriting them with a model', () => {
    expect(
      debtSetup({
        ...base,
        progressMode: 'bank',
        months: '5',
        remaining: '200,01',
        extraRemaining: '30,02',
        amountOverride: '46',
      }),
    ).toMatchObject({
      remainingMinor: 20001,
      overpaymentRemainingMinor: 3002,
      amountMinor: 4600,
      installmentsLeft: 5,
      preview: { futureTotal: 23003, last: 4603 },
    });
  });
  it.each(['', '-1', '1.5', '13', '12'])(
    'rejects incomplete, invalid or fully paid progress %s',
    (paidCount) => {
      expect(() => debtSetup({ ...base, progressMode: 'paid', paidCount })).toThrow();
    },
  );
  it('refuses unknown principal for interest-bearing bank schedules', () => {
    expect(() =>
      debtSetup({
        ...base,
        paymentSetup: 'schedule',
        amount: '50',
        months: '10',
        remainingMode: 'auto',
        rate: '24',
      }),
    ).toThrow('точний залишок');
  });
  it('does not silently replace the original term or allow excess remaining principal', () => {
    expect(() =>
      debtSetup({
        ...base,
        progressMode: 'bank',
        months: '13',
        remaining: '550',
        extraRemaining: '125',
      }),
    ).toThrow();
    expect(() =>
      debtSetup({
        ...base,
        progressMode: 'bank',
        months: '10',
        remaining: '551',
        extraRemaining: '125',
      }),
    ).toThrow();
  });
});

it('shows the exact rounded final bank payment and rejects an inconsistent count', () => {
  const v = {
    ...base,
    paymentSetup: 'schedule',
    total: '',
    amount: '50,25',
    months: '10',
    remainingMode: 'manual',
    remaining: '502,48',
  };
  expect(debtSetup(v).preview).toMatchObject({ next: 5025, last: 5023, futureTotal: 50248 });
  expect(() => debtSetup({ ...v, remaining: '510' })).toThrow('не покривають');
  expect(() => debtSetup({ ...v, remaining: '450' })).toThrow('раніше');
});
