import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFinanceDemo, writeFinanceDemo, resetFinanceDemo } from './finance-demo.ts';
describe('finance preview uses the real money rules', () => {
  beforeEach(() => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
      clear: () => saved.clear(),
    });
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T09:00:00Z'));
    resetFinanceDemo();
  });
  afterEach(() => {
    resetFinanceDemo();
    vi.useRealTimers();
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  it('corrects the balance and one expense, preserving the date and excluding fleet cash from personal income', () => {
    const before = readFinanceDemo(),
      tx = before.transactions.find((t) => !t.bank && t.kind === 'expense')!;
    const amount = Math.abs(tx.amountMinor) + 550;
    writeFinanceDemo({
      id: 'test-edit-001',
      version: before.version,
      type: 'transaction-edit',
      payload: {
        transactionId: tx.id,
        kind: 'expense',
        amountMinor: amount,
        category: tx.category,
        description: 'Уточнено',
      },
    });
    const after = readFinanceDemo();
    expect(after.transactions).toHaveLength(before.transactions.length);
    expect(after.transactions.find((t) => t.id === tx.id)).toMatchObject({
      amountMinor: -amount,
      at: tx.at,
      description: 'Уточнено',
    });
    expect(after.accounts.find((a) => a.id === tx.accountId)?.balanceMinor).toBe(
      before.accounts.find((a) => a.id === tx.accountId)!.balanceMinor! - 550,
    );
    expect(after.reserveMinor).toBe(before.reserveMinor);
    expect(after.transactions.filter((t) => t.kind === 'income')).toHaveLength(
      before.transactions.filter((t) => t.kind === 'income').length,
    );
  });
  it('uses the same transfer reference as the server and undoes a demo terminal credit once', async () => {
    const seeded = readFinanceDemo();
    seeded.transactions.unshift({
      ...seeded.transactions[0]!,
      id: 'demo-terminal',
      bank: true,
      accountId: 'mono:demo',
      kind: 'unclassified',
      amountMinor: 40000,
      amountUah: 40000,
      description: 'Термінал mono',
      reference: null,
    });
    localStorage.setItem('svitanok:finance-demo:v1', JSON.stringify(seeded));
    vi.resetModules();
    const demo = await import('./finance-demo.ts');
    const before = demo.readFinanceDemo();
    demo.writeFinanceDemo({
      id: 'demo-terminal-link',
      version: before.version,
      type: 'bank-transfer',
      payload: { transactionId: 'demo-terminal', accountId: 'cash' },
    });
    const linked = demo.readFinanceDemo();
    expect(
      linked.transactions.find((t) => t.id === 'bank-transfer:demo-terminal-link')!.reference,
    ).toBe('demo-terminal-link');
    const undo = {
      id: 'demo-terminal-undo',
      version: linked.version,
      type: 'bank-transfer-undo',
      payload: { transactionId: 'demo-terminal' },
    };
    demo.writeFinanceDemo(undo);
    demo.writeFinanceDemo(undo);
    expect(demo.readFinanceDemo().accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(
      before.accounts.find((a) => a.id === 'cash')!.balanceMinor,
    );
  });
  it('tracks the exact agreed overpayment through the last installment', () => {
    const before = readFinanceDemo();
    writeFinanceDemo({
      id: 'preview-extra-create',
      version: before.version,
      type: 'payment',
      payload: {
        name: 'Розстрочка 550',
        kind: 'card-installment',
        totalMinor: 55000,
        remainingMinor: 55000,
        overpaymentTotalMinor: 12500,
        overpaymentRemainingMinor: 12500,
        termMonths: 12,
        installmentsLeft: 12,
        amountMinor: 5625,
        rateBps: 0,
        feeMinor: 0,
        nextDate: '2026-10-09',
        anchorDay: 9,
        recurrence: 'month',
        category: 'розстрочка',
      },
    });
    for (let n = 0; n < 12; n++)
      writeFinanceDemo({
        id: `preview-extra-pay-${n}`,
        version: readFinanceDemo().version,
        type: 'payment-paid',
        payload: { paymentId: 'preview-extra-create', amountMinor: 5625, accountId: 'cash' },
      });
    const after = readFinanceDemo();
    expect(after.payments.find((p) => p.id === 'preview-extra-create')).toMatchObject({
      status: 'done',
      remainingMinor: 0,
      overpaymentRemainingMinor: 0,
      overpaymentPaidMinor: 12500,
    });
    expect(after.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(
      before.accounts.find((a) => a.id === 'cash')!.balanceMinor! - 67500,
    );
  });
});
