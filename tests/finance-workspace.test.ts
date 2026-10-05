import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { readFinanceWorkspace, executeFinanceCommand } from '../web/core/finance/workspace.mjs';
import { handleFinance } from '../web/api-finance.mjs';
import { applyRule, RETENTION } from '../web/core/retention/cleanup.mjs';
import { runFinanceQuery } from '../web/core/tools/finance.mjs';
import { queueMiniAppNotice, miniAppPaymentRemindTask } from '../web/core/finance/reminders.mjs';
import { interestDebtPayment } from '../web/core/finance/payments.mjs';

const NOW = Date.parse('2026-10-08T15:00:00Z');
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0005_finance.sql',
    '0028_mini_app_finance.sql',
    '0029_finance_credit_limits.sql',
    '0030_finance_card_installment.sql',
    '0031_finance_installment_overpayment.sql',
    '0032_finance_interest_method.sql',
    '0033_finance_history_and_links.sql',
  ]);
  const originalBatch = d1.stub.batch;
  d1.stub.batch = async (statements) => {
    d1.db.exec('BEGIN');
    try {
      const out = await originalBatch(statements);
      d1.db.exec('COMMIT');
      return out;
    } catch (e) {
      d1.db.exec('ROLLBACK');
      throw e;
    }
  };
  return { d1, env: workerEnv({ DB: d1.stub }) };
}
describe('finance workspace · real migration and SQLite transactions', () => {
  it('uses the saved interest method for each real payment without requiring manual principal', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'annual-plan-create',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Кредит за ставкою',
          kind: 'loan',
          amountMinor: 10662,
          totalMinor: 120000,
          remainingMinor: 120000,
          rateBps: 1200,
          feeMinor: 0,
          interestMethod: 'annuity',
          termMonths: 12,
          installmentsLeft: 12,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'кредити',
        },
      },
      NOW,
    );
    expect((await readFinanceWorkspace(env, NOW)).transactions).toHaveLength(0);
    for (let n = 1; n <= 12; n++) {
      const state = await readFinanceWorkspace(env, NOW);
      const pay = interestDebtPayment(state.payments[0]!)!;
      await executeFinanceCommand(
        env,
        {
          id: `annual-pay-${n}`,
          version: n,
          type: 'payment-paid',
          payload: {
            paymentId: 'annual-plan-create',
            accountId: 'cash',
            amountMinor: pay.amountMinor,
          },
        },
        NOW,
      );
    }
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.payments[0]).toMatchObject({
      remainingMinor: 0,
      installmentsLeft: 0,
      status: 'done',
      interestMethod: 'annuity',
    });
    expect(state.transactions).toHaveLength(12);
    expect(state.accounts[0]!.balanceMinor).toBe(-127942);
  });
  it('rejects invalid interest plans and permits the actual bank principal and early payoff', async () => {
    const { env } = setup();
    const payload = {
      name: 'Кредит',
      kind: 'loan',
      amountMinor: 10662,
      totalMinor: 120000,
      remainingMinor: 120000,
      rateBps: 1200,
      feeMinor: 0,
      interestMethod: 'annuity',
      termMonths: 12,
      installmentsLeft: 12,
      nextDate: '2026-10-09',
      anchorDay: 9,
      recurrence: 'month',
      category: 'кредити',
    };
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'bad-method',
          version: 0,
          type: 'payment',
          payload: { ...payload, interestMethod: 'invented' },
        },
        NOW,
      ),
    ).rejects.toThrow();
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'bad-amount',
          version: 0,
          type: 'payment',
          payload: { ...payload, amountMinor: 100 },
        },
        NOW,
      ),
    ).rejects.toThrow(/покривати/);
    await executeFinanceCommand(
      env,
      { id: 'annual-manual', version: 0, type: 'payment', payload },
      NOW,
    );
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'too-small',
          version: 1,
          type: 'payment-paid',
          payload: { paymentId: 'annual-manual', accountId: 'cash', amountMinor: 1000 },
        },
        NOW,
      ),
    ).rejects.toThrow(/покривати/);
    await executeFinanceCommand(
      env,
      {
        id: 'bank-exact',
        version: 1,
        type: 'payment-paid',
        payload: {
          paymentId: 'annual-manual',
          accountId: 'cash',
          amountMinor: 10662,
          principalMinor: 9500,
        },
      },
      NOW,
    );
    expect((await readFinanceWorkspace(env, NOW)).payments[0]!.remainingMinor).toBe(110500);
    await executeFinanceCommand(
      env,
      {
        id: 'annual-close',
        version: 2,
        type: 'payment-paid',
        payload: {
          paymentId: 'annual-manual',
          accountId: 'cash',
          amountMinor: 111000,
          close: true,
        },
      },
      NOW,
    );
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.payments[0]).toMatchObject({ remainingMinor: 0, status: 'done' });
    expect(state.accounts[0]!.balanceMinor).toBe(-121662);
  });
  it('records total overpayment separately and charges exactly 675 UAH across twelve installments', async () => {
    const { env } = setup();
    const payload = {
      name: 'Розстрочка 550',
      kind: 'card-installment',
      totalMinor: 55000,
      remainingMinor: 55000,
      overpaymentTotalMinor: 12500,
      overpaymentRemainingMinor: 12500,
      termMonths: 12,
      installmentsLeft: 12,
      amountMinor: 5625,
      nextDate: '2026-10-09',
      anchorDay: 9,
      recurrence: 'month',
      category: 'розстрочка',
    };
    await executeFinanceCommand(
      env,
      { id: 'extra-create-550', version: 0, type: 'payment', payload },
      NOW,
    );
    expect((await readFinanceWorkspace(env, NOW)).accounts[0]!.balanceMinor).toBe(0);
    for (let n = 1; n <= 12; n++)
      await executeFinanceCommand(
        env,
        {
          id: `extra-payment-${n}`,
          version: n,
          type: 'payment-paid',
          payload: { paymentId: 'extra-create-550', amountMinor: 5625, accountId: 'cash' },
        },
        NOW,
      );
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.payments[0]).toMatchObject({
      status: 'done',
      remainingMinor: 0,
      overpaymentRemainingMinor: 0,
      overpaymentPaidMinor: 12500,
      overpaymentTotalMinor: 12500,
      installmentsLeft: 0,
      totalMinor: 55000,
    });
    expect(state.transactions).toHaveLength(12);
    expect(state.accounts[0]!.balanceMinor).toBe(-67500);
    expect(state.transactions.reduce((sum, t) => sum - t.amountMinor, 0)).toBe(67500);
  });
  it('records actual early payoff fees and stops the remaining planned surcharge without charging it', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'extra-early-create',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Достроково',
          kind: 'card-installment',
          totalMinor: 55000,
          remainingMinor: 55000,
          overpaymentTotalMinor: 12500,
          overpaymentRemainingMinor: 12500,
          termMonths: 12,
          installmentsLeft: 12,
          amountMinor: 5625,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'розстрочка',
        },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'extra-early-paid',
        version: 1,
        type: 'payment-paid',
        payload: {
          paymentId: 'extra-early-create',
          amountMinor: 58000,
          principalMinor: 55000,
          close: true,
          accountId: 'cash',
        },
      },
      NOW,
    );
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.payments[0]).toMatchObject({
      status: 'done',
      remainingMinor: 0,
      overpaymentRemainingMinor: 0,
      overpaymentPaidMinor: 3000,
    });
    expect(state.accounts[0]!.balanceMinor).toBe(-58000);
    expect(state.transactions).toHaveLength(1);
  });
  it('initializes an already-started installment without inventing past expenses', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'extra-historical',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Уже сплачую',
          kind: 'card-installment',
          totalMinor: 55000,
          remainingMinor: 27500,
          overpaymentTotalMinor: 12500,
          overpaymentRemainingMinor: 6250,
          termMonths: 12,
          installmentsLeft: 6,
          amountMinor: 5625,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'розстрочка',
        },
      },
      NOW,
    );
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.payments[0]).toMatchObject({
      remainingMinor: 27500,
      overpaymentRemainingMinor: 6250,
      overpaymentPaidMinor: 6250,
      installmentsLeft: 6,
    });
    expect(state.accounts[0]!.balanceMinor).toBe(0);
    expect(state.transactions).toHaveLength(0);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'extra-invalid-term',
          version: 1,
          type: 'payment',
          payload: {
            paymentId: 'extra-historical',
            name: 'Уже сплачую',
            kind: 'card-installment',
            totalMinor: 55000,
            remainingMinor: 27500,
            overpaymentTotalMinor: 12500,
            overpaymentRemainingMinor: 6250,
            termMonths: 3,
            installmentsLeft: 6,
            amountMinor: 5625,
            nextDate: '2026-10-09',
            anchorDay: 9,
            recurrence: 'month',
            category: 'розстрочка',
          },
        },
        NOW,
      ),
    ).rejects.toThrow('термін');
  });
  it('closes a card installment early exactly once and removes all future reminders', async () => {
    const { env, d1 } = setup();
    const payload = {
      name: 'Розстрочка',
      kind: 'card-installment',
      amountMinor: 5000,
      remainingMinor: 25000,
      installmentsLeft: 5,
      nextDate: '2026-10-09',
      anchorDay: 9,
      recurrence: 'month',
      category: 'розстрочка',
    };
    await executeFinanceCommand(
      env,
      { id: 'card-parts-create', version: 0, type: 'payment', payload },
      NOW,
    );
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'card-parts-invalid',
          version: 1,
          type: 'payment-paid',
          payload: {
            paymentId: 'card-parts-create',
            amountMinor: 5000,
            principalMinor: 5000,
            accountId: 'cash',
            close: true,
          },
        },
        NOW,
      ),
    ).rejects.toThrow('весь залишок');
    expect((await readFinanceWorkspace(env, NOW)).version).toBe(1);
    const command = {
      id: 'card-parts-close',
      version: 1,
      type: 'payment-paid',
      payload: {
        paymentId: 'card-parts-create',
        amountMinor: 25000,
        principalMinor: 25000,
        accountId: 'cash',
        close: true,
      },
    };
    await executeFinanceCommand(env, command, NOW);
    await executeFinanceCommand(env, command, NOW);
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.payments[0]).toMatchObject({
      remainingMinor: 0,
      installmentsLeft: 0,
      status: 'done',
    });
    expect(state.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(-25000);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(1);
    await expect(
      executeFinanceCommand(
        env,
        { ...command, id: 'card-parts-close-again', version: state.version },
        NOW,
      ),
    ).rejects.toThrow('Активний');
  });
  it('links an early bank repayment without a second transaction or cash debit', async () => {
    const { env, d1 } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'early-bank-loan',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Кредит',
          kind: 'loan',
          amountMinor: 5000,
          remainingMinor: 25000,
          installmentsLeft: 5,
          rateBps: 2400,
          feeMinor: 100,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'кредити',
        },
      },
      NOW,
    );
    d1.db
      .prepare(
        'INSERT INTO transactions(id,at,amount,currency,amount_uah,category,description,raw_json,flags_json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'early-bank-pay',
        '2026-10-08T12:00:00Z',
        -25500,
        'UAH',
        -25500,
        'інше',
        'Погашення',
        JSON.stringify({ account: 'mono-1', hold: false }),
        '[]',
      );
    await executeFinanceCommand(
      env,
      {
        id: 'early-bank-close',
        version: 1,
        type: 'payment-paid',
        payload: {
          paymentId: 'early-bank-loan',
          transactionId: 'early-bank-pay',
          amountMinor: 25500,
          principalMinor: 25000,
          close: true,
        },
      },
      NOW,
    );
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.payments[0]).toMatchObject({
      remainingMinor: 0,
      installmentsLeft: 0,
      status: 'done',
    });
    expect(state.accounts.find((a) => a.id === 'cash')!.balanceMinor).toBe(0);
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({
      amountMinor: -25500,
      reference: 'early-bank-loan',
      category: 'кредити',
    });
  });
  it('finishes the final installment but retains a real residual even when the count reaches zero', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'last-parts-create',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Останній',
          kind: 'installment',
          amountMinor: 5256,
          remainingMinor: 5252,
          installmentsLeft: 1,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'покупка частинами',
        },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'last-parts-paid',
        version: 1,
        type: 'payment-paid',
        payload: { paymentId: 'last-parts-create', amountMinor: 5252, accountId: 'cash' },
      },
      NOW,
    );
    expect((await readFinanceWorkspace(env, NOW)).payments[0]).toMatchObject({
      status: 'done',
      remainingMinor: 0,
      installmentsLeft: 0,
    });
    await executeFinanceCommand(
      env,
      {
        id: 'residual-create',
        version: 2,
        type: 'payment',
        payload: {
          name: 'Залишок',
          kind: 'loan',
          amountMinor: 5000,
          remainingMinor: 5500,
          installmentsLeft: 1,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'кредити',
        },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'residual-paid',
        version: 3,
        type: 'payment-paid',
        payload: { paymentId: 'residual-create', amountMinor: 5000, accountId: 'cash' },
      },
      NOW,
    );
    expect(
      (await readFinanceWorkspace(env, NOW)).payments.find((p) => p.id === 'residual-create'),
    ).toMatchObject({ status: 'active', remainingMinor: 500, installmentsLeft: 0 });
  });
  it('cancels a subscription without making an expense, and rejects cancelling outstanding debt', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'subscription-create',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Підписка',
          kind: 'subscription',
          amountMinor: 5000,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'підписки',
        },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'subscription-cancel',
        version: 1,
        type: 'payment-cancel',
        payload: { paymentId: 'subscription-create' },
      },
      NOW,
    );
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.payments[0]!.status).toBe('done');
    expect(state.transactions).toHaveLength(0);
    expect(state.accounts[0]!.balanceMinor).toBe(0);
    await executeFinanceCommand(
      env,
      {
        id: 'debt-not-subscription',
        version: 2,
        type: 'payment',
        payload: {
          name: 'Кредит',
          kind: 'loan',
          amountMinor: 5000,
          remainingMinor: 25000,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'кредити',
        },
      },
      NOW,
    );
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'cancel-debt',
          version: 3,
          type: 'payment-cancel',
          payload: { paymentId: 'debt-not-subscription' },
        },
        NOW,
      ),
    ).rejects.toThrow('підписку');
  });
  it('offers bank purchase categories and accounts for installment payments without duplicating debt or cash', async () => {
    const { env } = setup();
    const before = await readFinanceWorkspace(env, NOW);
    expect(before.categories).toEqual(
      expect.arrayContaining(['покупка частинами', 'розстрочка', 'кіно', 'комуналка та інтернет']),
    );
    await executeFinanceCommand(
      env,
      {
        id: 'parts-proove',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Proove',
          kind: 'installment',
          amountMinor: 9070,
          remainingMinor: 108840,
          totalMinor: 181400,
          installmentsLeft: 12,
          nextDate: '2026-10-09',
          anchorDay: 9,
          recurrence: 'month',
          category: 'покупка частинами',
        },
      },
      NOW,
    );
    const scheduled = await readFinanceWorkspace(env, NOW);
    expect(scheduled.accounts[0]?.balanceMinor).toBe(before.accounts[0]?.balanceMinor);
    await executeFinanceCommand(
      env,
      {
        id: 'parts-proove-paid',
        version: 1,
        type: 'payment-paid',
        payload: { paymentId: 'parts-proove', amountMinor: 9070, accountId: 'cash' },
      },
      NOW,
    );
    const after = await readFinanceWorkspace(env, NOW);
    expect(after.payments[0]).toMatchObject({
      remainingMinor: 99770,
      installmentsLeft: 11,
      nextDate: '2026-11-09',
      category: 'покупка частинами',
    });
    expect(after.accounts[0]?.balanceMinor).toBe(-9070);
    expect(after.transactions[0]).toMatchObject({
      category: 'покупка частинами',
      amountMinor: -9070,
    });
  });
  it('payment reminders are persistent, configurable and never send directly', async () => {
    const { env, d1 } = setup();
    env.TELEGRAM_CHAT_ID = '123';
    env.TELEGRAM_BOT_TOKEN = 'test-only';
    d1.db.exec(
      'CREATE TABLE outbox(id TEXT PRIMARY KEY,chat_id TEXT,thread_id TEXT,kind TEXT,payload_json TEXT,attempts INTEGER,next_at TEXT,status TEXT)',
    );
    const at = Date.parse('2026-10-08T08:00:00Z');
    await executeFinanceCommand(
      env,
      {
        id: 'bill-0001',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Інтернет',
          kind: 'subscription',
          amountMinor: 30000,
          nextDate: '2026-10-10',
          anchorDay: 10,
          recurrence: 'month',
          category: 'звʼязок та інтернет',
          remindDays: 3,
        },
      },
      at,
    );
    expect(await miniAppPaymentRemindTask(env, at)).toEqual({ queued: 1 });
    expect(await miniAppPaymentRemindTask(env, at + 300000)).toEqual({ queued: 0 });
    d1.db.exec('DELETE FROM outbox');
    expect(await miniAppPaymentRemindTask(env, at + 600000)).toEqual({ queued: 0 });
    expect(await queueMiniAppNotice(env, 'checkin:2026-10-08:am', 'Чек-ін', at)).toBe(true);
    expect(await queueMiniAppNotice(env, 'checkin:2026-10-08:am', 'Чек-ін', at + 1)).toBe(false);
    await executeFinanceCommand(
      env,
      {
        id: 'prefs-0001',
        version: 1,
        type: 'settings',
        payload: {
          incomePeriod: 'week',
          taxiVisible: true,
          categories: [],
          paymentReminders: false,
          checkinReminders: false,
        },
      },
      at,
    );
    expect(await miniAppPaymentRemindTask(env, Date.parse('2026-10-10T08:00:00Z'))).toEqual({
      skipped: 'disabled',
    });
    expect((await readFinanceWorkspace(env, at)).settings.checkinReminders).toBe(false);
  });
  it('links an imported payment once, and preserves the manual balance ledger through retention', async () => {
    const { env, d1 } = setup();
    d1.db
      .prepare(
        'INSERT INTO transactions(id,at,amount,currency,amount_uah,category,description,raw_json,flags_json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'bank-pay',
        '2026-10-08T12:00:00Z',
        -30000,
        'UAH',
        -30000,
        'інше',
        'Internet',
        JSON.stringify({ account: 'mono-1', hold: false }),
        '[]',
      );
    await executeFinanceCommand(
      env,
      {
        id: 'payment-0001',
        version: 0,
        type: 'payment',
        payload: {
          name: 'Інтернет',
          kind: 'subscription',
          amountMinor: 30000,
          nextDate: '2026-10-08',
          anchorDay: 8,
          recurrence: 'month',
          category: 'звʼязок та інтернет',
        },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'paid-0001',
        version: 1,
        type: 'payment-paid',
        payload: { paymentId: 'payment-0001', transactionId: 'bank-pay', amountMinor: 30000 },
      },
      NOW,
    );
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(1);
    expect((await readFinanceWorkspace(env, NOW)).payments[0]!.nextDate).toBe('2026-11-08');
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'paid-0002',
          version: 2,
          type: 'payment-paid',
          payload: { paymentId: 'payment-0001', transactionId: 'bank-pay', amountMinor: 30000 },
        },
        NOW,
      ),
    ).rejects.toThrow('непов’язаний');
    await executeFinanceCommand(
      env,
      {
        id: 'opening-0001',
        version: 2,
        type: 'transaction',
        payload: { kind: 'adjustment', accountId: 'cash', amountMinor: 100000 },
      },
      NOW,
    );
    await applyRule(
      env,
      RETENTION.find((r) => r.table === 'transactions')!,
      Date.parse('2029-10-08T15:00:00Z'),
    );
    expect(
      (await readFinanceWorkspace(env, Date.parse('2029-10-08T15:00:00Z'))).accounts.find(
        (a) => a.id === 'cash',
      )!.balanceMinor,
    ).toBe(100000);
  });
  it('assistant spending excludes transfers and cash held for the fleet', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'opening-0001',
        version: 0,
        type: 'transaction',
        payload: { kind: 'adjustment', accountId: 'cash', amountMinor: 100000 },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'expense-0001',
        version: 1,
        type: 'transaction',
        payload: {
          kind: 'expense',
          accountId: 'cash',
          amountMinor: 10000,
          category: 'продукти',
          at: new Date(NOW - 60000).toISOString(),
        },
      },
      NOW,
    );
    const result = await runFinanceQuery(env, { period: 'день' }, NOW);
    if (!('total_uah' in result.result)) throw new Error('Expected period summary');
    expect(result.result.total_uah).toBe(10000);
    expect(result.result.workspace!.available_minor).toBe(90000);
  });
  it('taxi cash, fleet reserve, personal spending and goals are accounted once', async () => {
    const { env, d1 } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'taxi-0001',
        version: 0,
        type: 'taxi-entry',
        payload: {
          at: '2026-10-06T18:00:00Z',
          accountId: 'cash',
          netCashMinor: 400000,
          commissionMinor: 70000,
          fuelMinor: 100000,
          receivedCashMinor: 200000,
        },
      },
      NOW,
    );
    const expense = {
      id: 'expense-0001',
      version: 1,
      type: 'transaction',
      payload: {
        kind: 'expense',
        amountMinor: 100000,
        accountId: 'cash',
        category: 'продукти',
        description: 'Продукти',
      },
    };
    await executeFinanceCommand(env, expense, NOW);
    await executeFinanceCommand(env, expense, NOW);
    let view = await readFinanceWorkspace(env, NOW);
    expect(view.version).toBe(2);
    expect(view.accounts[0]!.balanceMinor).toBe(100000);
    expect(view.reserveMinor).toBe(50000);
    expect(view.taxiWeeks[0]!.earnedMinor).toBe(150000);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(2);
    await executeFinanceCommand(
      env,
      {
        id: 'goal-0001',
        version: 2,
        type: 'goal',
        payload: { name: 'Навчання', targetMinor: 1000000 },
      },
      NOW,
    );
    await executeFinanceCommand(
      env,
      {
        id: 'move-0001',
        version: 3,
        type: 'goal-move',
        payload: { goalId: 'goal-0001', accountId: 'cash', amountMinor: 20000 },
      },
      NOW,
    );
    view = await readFinanceWorkspace(env, NOW);
    expect(view.accounts[0]!.balanceMinor).toBe(100000);
    expect(view.goalMoves[0]!.amountMinor).toBe(20000);
    expect(view.transactions.filter((t) => t.kind === 'expense')).toHaveLength(1);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'return-0001',
          version: 4,
          type: 'goal-move',
          payload: { goalId: 'goal-0001', accountId: 'cash', amountMinor: -20001 },
        },
        NOW,
      ),
    ).rejects.toThrow();
    expect((await readFinanceWorkspace(env, NOW)).version).toBe(4);
  });
  it('a taxi week rollover preserves fleet debt until the actual settlement', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'taxi-0001',
        version: 0,
        type: 'taxi-entry',
        payload: {
          at: '2026-10-06T18:00:00Z',
          accountId: 'cash',
          netCashMinor: 400000,
          commissionMinor: 70000,
          fuelMinor: 100000,
          receivedCashMinor: 200000,
        },
      },
      NOW,
    );
    const monday = Date.parse('2026-10-12T10:00:01Z');
    const before = await readFinanceWorkspace(env, monday);
    expect(before.reserveMinor).toBe(50000);
    expect(before.taxiWeeks[0]!.closed).toBe(true);
    const settle = {
      id: 'settle-0001',
      version: 1,
      type: 'taxi-settle',
      payload: { weekKey: '2026-10-05', accountId: 'cash' },
    };
    await executeFinanceCommand(env, settle, monday);
    await executeFinanceCommand(env, settle, monday);
    const after = await readFinanceWorkspace(env, monday);
    expect(after.reserveMinor).toBe(0);
    expect(after.accounts[0]!.balanceMinor).toBe(150000);
    expect(after.transactions.filter((t) => t.kind === 'income')).toHaveLength(0);
    expect(after.taxiWeeks[0]!.settled).toBe(true);
  });
  it('incomplete entries stay visible but cannot create a falsely final settlement', async () => {
    const { env } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'taxi-0001',
        version: 0,
        type: 'taxi-entry',
        payload: { at: '2026-10-06T18:00:00Z', accountId: 'cash', netCashMinor: 400000 },
      },
      NOW,
    );
    expect((await readFinanceWorkspace(env, NOW)).taxiWeeks[0]!.complete).toBe(false);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'settle-0001',
          version: 1,
          type: 'taxi-settle',
          payload: { weekKey: '2026-10-05', accountId: 'cash' },
        },
        Date.parse('2026-10-12T11:00:00Z'),
      ),
    ).rejects.toThrow();
    const edit = {
      id: 'taxi-edit-0001',
      version: 1,
      type: 'taxi-edit',
      payload: {
        entryId: 'taxi-0001',
        at: '2026-10-06T18:00:00Z',
        accountId: 'cash',
        netCashMinor: 400000,
        commissionMinor: 70000,
        fuelMinor: 100000,
        receivedCashMinor: 200000,
      },
    };
    await executeFinanceCommand(env, edit, NOW);
    await executeFinanceCommand(env, edit, NOW);
    const amended = await readFinanceWorkspace(env, NOW);
    expect(amended.taxiEntries).toHaveLength(1);
    expect(amended.taxiWeeks[0]!.complete).toBe(true);
    expect(amended.accounts[0]!.balanceMinor).toBe(200000);
    expect(amended.taxiWeeks[0]!.earnedMinor).toBe(150000);
    await executeFinanceCommand(
      env,
      {
        ...edit,
        id: 'taxi-edit-0002',
        version: 2,
        payload: { ...edit.payload, receivedCashMinor: 250000 },
      },
      NOW,
    );
    expect((await readFinanceWorkspace(env, NOW)).accounts[0]!.balanceMinor).toBe(250000);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'classify-0001',
          version: 3,
          type: 'classify',
          payload: { transactionId: 'taxi-cash:taxi-edit-0002', kind: 'income', category: 'дохід' },
        },
        NOW,
      ),
    ).rejects.toThrow('обліком');
  });
  it('rejects stale versions and reused IDs with different amounts, without partial writes', async () => {
    const { env, d1 } = setup();
    await executeFinanceCommand(
      env,
      {
        id: 'income-0001',
        version: 0,
        type: 'transaction',
        payload: { kind: 'income', accountId: 'cash', amountMinor: 10000, category: 'дохід' },
      },
      NOW,
    );
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'stale-0001',
          version: 0,
          type: 'transaction',
          payload: { kind: 'income', accountId: 'cash', amountMinor: 10000, category: 'дохід' },
        },
        NOW,
      ),
    ).rejects.toThrow('Дані змінилися');
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'income-0001',
          version: 0,
          type: 'transaction',
          payload: { kind: 'income', accountId: 'cash', amountMinor: 20000, category: 'дохід' },
        },
        NOW,
      ),
    ).rejects.toThrow('ID');
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(1);
  });
  it('private API rejects anonymous requests before touching finance data', async () => {
    const { env, d1 } = setup();
    const response = await handleFinance(
      new Request('https://example.test/api/finance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'income-0001',
          version: 0,
          type: 'transaction',
          payload: { kind: 'income', accountId: 'cash', amountMinor: 10000, category: 'дохід' },
        }),
      }),
      env,
    );
    expect([401, 403]).toContain(response.status);
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n).toBe(0);
  });
});
