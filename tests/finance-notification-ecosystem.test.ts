import { describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import {
  financeMiniAppButton,
  financePathForStartParam,
  financeStartParam,
} from '../web/core/finance/links.mjs';
import { miniAppPaymentRemindTask, queuePaymentAttention } from '../web/core/finance/reminders.mjs';
import { acknowledgeFinanceAlert } from '../web/core/finance/attention.mjs';
import { readFinanceWorkspace, executeFinanceCommand } from '../web/core/finance/workspace.mjs';
import { handleBrainCallback } from '../web/core/prerouter.mjs';
import { isLoud } from '../web/core/finance/rules.mjs';
import { parseFinanceAttention } from '../web/core/finance/attention-state.mjs';

const NOW = Date.parse('2026-10-11T08:00:00Z');
function setup() {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0005_finance.sql',
    '0028_mini_app_finance.sql',
    '0029_finance_credit_limits.sql',
    '0030_finance_card_installment.sql',
    '0031_finance_installment_overpayment.sql',
    '0032_finance_interest_method.sql',
    '0033_finance_history_and_links.sql',
    '0035_finance_budget_planning.sql',
  ]);
  const batch = d1.stub.batch;
  d1.stub.batch = async (s) => {
    d1.db.exec('BEGIN');
    try {
      const result = await batch(s);
      d1.db.exec('COMMIT');
      return result;
    } catch (e) {
      d1.db.exec('ROLLBACK');
      throw e;
    }
  };
  return {
    d1,
    env: workerEnv({
      DB: d1.stub,
      ASSISTANT_V2: 'on',
      TELEGRAM_CHAT_ID: '123',
      TELEGRAM_BOT_USERNAME: 'sample_bot',
      TELEGRAM_BOT_TOKEN: 'test-only',
    }),
  };
}
function payment(
  d1: ReturnType<typeof setup>['d1'],
  id: string,
  name = 'LoveYouHome',
  amount = 12000,
  date = '2026-10-10',
  status = 'active',
) {
  d1.db
    .prepare(
      `INSERT INTO finance_payments(id,name,kind,amount_minor,next_date,anchor_day,category,status,created_at)
    VALUES(?,?,'installment',?,?,10,'покупка частинами',?,'2026-10-01')`,
    )
    .run(id, name, amount, date, status);
}
function transaction(d1: ReturnType<typeof setup>['d1'], id = 'bank-1', flags = ['duplicate']) {
  d1.db
    .prepare(
      `INSERT INTO transactions(id,at,amount,currency,amount_uah,category,description,flags_json,raw_json)
    VALUES(?,?,-12000,'UAH',-12000,'покупка частинами','LoveYouHome',?,?)`,
    )
    .run(
      id,
      new Date(NOW - 60000).toISOString(),
      JSON.stringify(flags),
      JSON.stringify({ account: 'mono-1', hold: false }),
    );
}

describe('finance record navigation is selection, not authorization', () => {
  it.each(['bank-1', 'id_with=padding', 'A'.repeat(120)])('round-trips the exact ID %s', (id) => {
    const param = financeStartParam('transaction', id)!;
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(param.length).toBeLessThan(512);
    expect(financePathForStartParam(param)).toBe(`/finance?transaction=${encodeURIComponent(id)}`);
  });
  it('rejects unknown kinds, path injection and malformed hex', () => {
    expect(financeStartParam('delete', 'abc')).toBeNull();
    expect(financeStartParam('payment', '../abc?all=1')).toBeNull();
    expect(financePathForStartParam('finance_payment_61f')).toBeNull();
    expect(financePathForStartParam('finance_payment_2f')).toBeNull();
    expect(financePathForStartParam('finance_payment_61&action=delete')).toBeNull();
  });
  it('uses Telegram initData launches; no unauthenticated group demo fallback', () => {
    const { env } = setup();
    expect(financeMiniAppButton(env, 'Оплата', 'payment', 'p-1', -100)?.url).toBe(
      `https://t.me/sample_bot?startapp=${financeStartParam('payment', 'p-1')}`,
    );
    env.TELEGRAM_BOT_USERNAME = undefined;
    env.MINI_APP_URL = 'https://svitanok.example/app/';
    expect(financeMiniAppButton(env, 'Оплата', 'payment', 'p-1', -100)).toBeNull();
    expect(financeMiniAppButton(env, 'Оплата', 'payment', 'p-1', 123)?.web_app?.url).toBe(
      'https://svitanok.example/app/#/finance?payment=p-1',
    );
    env.MINI_APP_URL = 'http://unsafe.example';
    expect(financeMiniAppButton(env, 'Оплата', 'payment', 'p-1', 123)).toBeNull();
    env.MINI_APP_URL = 'https://user:placeholder@example.test/app/';
    expect(financeMiniAppButton(env, 'Оплата', 'payment', 'p-1', 123)).toBeNull();
  });
});

describe('payment attention uses canonical IDs and persistent atomic claims', () => {
  it('a confirmed bank-linked payment advances the real schedule without a second debit or a reminder', async () => {
    const { d1, env } = setup();
    payment(d1, 'home-a');
    transaction(d1);
    await executeFinanceCommand(
      env,
      {
        id: 'pay-linked-bank',
        version: 0,
        type: 'payment-paid',
        payload: { paymentId: 'home-a', amountMinor: 12000, transactionId: 'bank-1' },
      },
      NOW,
    );
    expect(await miniAppPaymentRemindTask(env, NOW)).toEqual({ queued: 0 });
    expect(
      (await readFinanceWorkspace(env, NOW)).payments.find((p) => p.id === 'home-a')?.nextDate,
    ).toBe('2026-11-10');
    expect(d1.db.prepare('SELECT count(*) AS n FROM transactions').get()?.n).toBe(1);
    expect(d1.db.prepare('SELECT amount FROM transactions WHERE id=?').get('bank-1')?.amount).toBe(
      -12000,
    );
  });
  it('keeps same-name payments distinct in one notice, preserves owner names, and never announces future/due/paused/done bills', async () => {
    const { d1, env } = setup();
    payment(d1, 'home-a');
    payment(d1, 'home-b', 'LoveYouHome', 8000);
    payment(d1, '12m', '12M', 5000);
    payment(d1, '24m', '24M', 15000);
    payment(d1, 'today', 'Сьогодні', 1, '2026-10-11');
    payment(d1, 'future', 'Завтра', 1, '2026-10-12');
    payment(d1, 'paused', 'Пауза', 1, '2026-10-10', 'paused');
    payment(d1, 'done', 'Готово', 1, '2026-10-10', 'done');
    expect(await miniAppPaymentRemindTask(env, NOW)).toEqual({ queued: 4 });
    const rows = d1.db.prepare('SELECT payload_json FROM outbox').all();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]!.payload_json));
    expect(payload.text).toContain('Оплату ще не підтверджено');
    expect(payload.text.match(/LoveYouHome/g)).toHaveLength(2);
    expect(payload.text).toContain('120,00');
    expect(payload.text).toContain('80,00');
    expect(payload.text).toContain('12M');
    expect(payload.text).toContain('24M');
    expect(payload.text).not.toMatch(/прострочен|відхилен|Сьогодні|Завтра|Пауза|Готово/);
    expect(payload.reply_markup.inline_keyboard).toHaveLength(4);
    expect(
      new Set(payload.reply_markup.inline_keyboard.map((r: { url: string }[]) => r[0]!.url)).size,
    ).toBe(4);
    expect(await miniAppPaymentRemindTask(env, NOW + 300000)).toEqual({ queued: 0 });
    d1.db.exec('DELETE FROM outbox');
    expect(await miniAppPaymentRemindTask(env, NOW + 600000)).toEqual({ queued: 0 });
    expect(
      d1.db.prepare('SELECT next_date FROM finance_payments WHERE id=?').get('home-a'),
    ).toMatchObject({ next_date: '2026-10-10' });
  });
  it('rechecks a confirmed/edited payment and omits it from an already selected group', async () => {
    const { d1, env } = setup();
    payment(d1, 'p-a');
    payment(d1, 'p-b');
    d1.db.prepare("UPDATE finance_payments SET next_date='2026-11-10' WHERE id='p-a'").run();
    expect(
      await queuePaymentAttention(
        env,
        ['p-a', 'p-b'].map((id) => ({
          id: `payment:${id}:2026-10-10:overdue`,
          paymentId: id,
          date: '2026-10-10',
          text: id,
        })),
        NOW,
      ),
    ).toBe(1);
    const payload = JSON.parse(
      String(d1.db.prepare('SELECT payload_json FROM outbox').get()?.payload_json),
    );
    expect(payload.text).not.toContain('p-a');
    expect(payload.text).toContain('p-b');
    expect(payload.reply_markup.inline_keyboard).toEqual([]);
  });
  it('rolls claims back with a failed enqueue, and can retry safely', async () => {
    const { d1, env } = setup();
    payment(d1, 'bill-a');
    d1.db.exec(
      "CREATE TRIGGER fail_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    await expect(miniAppPaymentRemindTask(env, NOW)).rejects.toThrow();
    expect(d1.db.prepare('SELECT count(*) AS n FROM finance_notices').get()?.n).toBe(0);
    d1.db.exec('DROP TRIGGER fail_notice');
    expect(await miniAppPaymentRemindTask(env, NOW)).toEqual({ queued: 1 });
  });
  it('stays quiet when disabled or outside the delivery hour', async () => {
    const { d1, env } = setup();
    payment(d1, 'bill-a');
    expect(await miniAppPaymentRemindTask(env, NOW + 3600000)).toEqual({ skipped: 'hour' });
    d1.db.exec('UPDATE finance_settings SET payment_reminders=0');
    expect(await miniAppPaymentRemindTask(env, NOW)).toEqual({ skipped: 'disabled' });
    expect(d1.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(0);
  });
});

describe('alert acknowledgement is shared state, never another debit', () => {
  it('a stale same-ID batch cannot overwrite a newer owner decision, even with the same timestamp', async () => {
    const { d1, env } = setup();
    transaction(d1);
    const original = {
      id: 'ack-same-id',
      version: 0,
      type: 'transaction-attention',
      payload: { transactionId: 'bank-1', status: 'reviewing' },
    };
    const batch = env.DB!.batch;
    let injected = false;
    env.DB!.batch = async (statements) => {
      if (!injected && statements.length === 3) {
        injected = true;
        env.DB!.batch = batch;
        // Both requests passed the initial read before the first one committed.
        await executeFinanceCommand(env, original, NOW);
        // A newer explicit decision arrives before the stale batch is resumed.
        await executeFinanceCommand(
          env,
          {
            ...original,
            id: 'ack-new-decision',
            version: 1,
            payload: { transactionId: 'bank-1', status: 'different' },
          },
          NOW + 1,
        );
      }
      return batch(statements);
    };
    await expect(executeFinanceCommand(env, original, NOW)).rejects.toThrow('Дані змінилися');
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.version).toBe(2);
    expect(state.transactions[0]?.attention?.status).toBe('different');
  });
  it('only exposes allowlisted owner acknowledgement metadata', () => {
    expect(parseFinanceAttention('{broken')).toBeNull();
    expect(
      parseFinanceAttention(
        JSON.stringify({
          financeAttention: {
            status: 'different',
            source: 'bank',
            at: new Date(NOW).toISOString(),
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseFinanceAttention(
        JSON.stringify({
          financeAttention: { status: 'different', source: 'owner', at: 'invalid' },
        }),
      ),
    ).toBeNull();
    expect(
      parseFinanceAttention(
        JSON.stringify({
          financeAttention: {
            status: 'different',
            source: 'owner',
            at: new Date(NOW).toISOString(),
            internal: 'do not forward',
          },
        }),
      ),
    ).toEqual({ status: 'different', source: 'owner', at: new Date(NOW).toISOString() });
  });
  it('distinguishes a committed response from a failed Telegram edit, and retries only the edit', async () => {
    const { d1, env } = setup();
    transaction(d1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 500 })),
    );
    try {
      const callback = { data: 'm:fx:bank-1:different', chatId: 123, messageId: 42 };
      expect(await handleBrainCallback(env, callback, NOW)).toContain('Відповідь збережено');
      expect((await readFinanceWorkspace(env, NOW)).transactions[0]?.attention?.status).toBe(
        'different',
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      );
      expect(await handleBrainCallback(env, callback, NOW + 1)).toBe('Позначив як різні покупки.');
      expect(d1.db.prepare('SELECT count(*) AS n FROM finance_commands').get()?.n).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps retry choices and no success receipt when persistence fails', async () => {
    const { d1, env } = setup();
    transaction(d1);
    d1.db.exec(
      "CREATE TRIGGER fail_ack BEFORE INSERT ON finance_commands BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    try {
      expect(
        await handleBrainCallback(
          env,
          { data: 'm:fx:bank-1:review', chatId: 123, messageId: 42 },
          NOW,
        ),
      ).toContain('Не вдалося зберегти відповідь');
      expect(mock).not.toHaveBeenCalled();
      expect((await readFinanceWorkspace(env, NOW)).version).toBe(0);
      expect((await readFinanceWorkspace(env, NOW)).transactions[0]?.attention).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('is repeat-safe, preserves amounts and changes the same callback card', async () => {
    const { d1, env } = setup();
    transaction(d1);
    const first = await acknowledgeFinanceAlert(env, 'bank-1', 'different', NOW);
    const again = await acknowledgeFinanceAlert(env, 'bank-1', 'reviewing', NOW + 1);
    expect(again.attention).toEqual(first.attention);
    const state = await readFinanceWorkspace(env, NOW);
    expect(state.version).toBe(1);
    expect(state.transactions[0]).toMatchObject({
      attention: { status: 'different', source: 'owner' },
      amountMinor: -12000,
    });
    expect(d1.db.prepare('SELECT count(*) AS n FROM transactions').get()?.n).toBe(1);
    expect(d1.db.prepare('SELECT count(*) AS n FROM finance_commands').get()?.n).toBe(1);
    const fetchMock = vi.fn(
      async (_url: unknown, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(
        await handleBrainCallback(
          env,
          { data: 'm:fx:bank-1:different', chatId: 123, messageId: 42 },
          NOW,
        ),
      ).toContain('Позначив');
      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
      expect(body.message_id).toBe(42);
      expect(body.text).toContain('Позначив як різні покупки');
      expect(body.reply_markup.inline_keyboard).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('rejects fabricated resolutions for normal transactions, without changing the ledger or version', async () => {
    const { d1, env } = setup();
    transaction(d1, 'normal', ['new_merchant', 'over_threshold']);
    expect(isLoud(['new_merchant', 'over_threshold', 'foreign', 'subscription'])).toBe(false);
    await expect(
      executeFinanceCommand(
        env,
        {
          id: 'ack-normal',
          version: 0,
          type: 'transaction-attention',
          payload: { transactionId: 'normal', status: 'different' },
        },
        NOW,
      ),
    ).rejects.toThrow('немає попередження');
    expect((await readFinanceWorkspace(env, NOW)).version).toBe(0);
  });
});
