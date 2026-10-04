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
});
