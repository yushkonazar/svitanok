// Гроші, друга половина (етап 6 PR-2, S-4-6…S-4-8, S-4-10): облік підписок,
// вечірній рядок, finance.query / finance.rule / subscriptions.update.
//
// Два інваріанти, за якими тут стежимо найпильніше: періоди рахуються за
// КИЇВСЬКОЮ добою (включно з добою переведення годинника), а T0-записи мають
// справжню «↩» - відкат повертає рівно те, що було.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  resolvePeriod,
  selectSpending,
  summarize,
  kyivDayStartMs,
} from '../web/core/finance/query.mjs';
import {
  periodLabel,
  stepDaysOf,
  upsertSubscription,
  listSubscriptions,
  updateSubscription,
  subscriptionButtons,
  subscriptionRemindTask,
  REMIND_MARKER_KEY,
  addDays,
} from '../web/core/finance/subscriptions.mjs';
import {
  eveningText,
  financeEveningTask,
  EVENING_MARKER_KEY,
} from '../web/core/finance/evening.mjs';
import { runFinanceQuery, runFinanceRule } from '../web/core/tools/finance.mjs';
import { applyPolicy, resolveUndo } from '../web/core/policy/proposals.mjs';
import { ingestTransaction, writeMonoAccounts } from '../web/core/finance/store.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0005_finance.sql',
  '0007_instructions_plans.sql',
];

/** Понеділок 07.09.2026, 12:00 Києва (літній час, +3). */
const NOON = Date.parse('2026-09-07T09:00:00.000Z');
/** Того ж дня 21:10 Києва - вікно вечірнього рядка. */
const EVENING = Date.parse('2026-09-07T18:10:00.000Z');
/** Того ж дня 11:10 Києва - вікно нагадування про підписку. */
const REMIND = Date.parse('2026-09-07T08:10:00.000Z');

function setup(kv: Record<string, string> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map(Object.entries(kv))),
    ASSISTANT_V2: 'on',
    TELEGRAM_CHAT_ID: '555',
    TOPIC_ASSISTANT: '99',
    TOPIC_SYSTEM: '77',
  });
  return { d1, db: d1.db, env };
}

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function seedTx(
  db: ReturnType<typeof setup>['db'],
  over: Partial<{
    id: string;
    at: string;
    amount: number;
    currency: string;
    amount_uah: number | null;
    mcc: number;
    description: string;
    category: string;
    flags: string[];
    raw: string | null;
  }> = {},
) {
  seq += 1;
  const row = {
    id: over.id ?? `t${seq}`,
    at: over.at ?? '2026-09-07T09:00:00.000Z',
    amount: over.amount ?? -18_000,
    currency: over.currency ?? 'UAH',
    amount_uah: over.amount_uah === undefined ? (over.amount ?? -18_000) : over.amount_uah,
    mcc: over.mcc ?? 5411,
    description: over.description ?? 'Сільпо',
    category: over.category ?? 'продукти',
    flags: JSON.stringify(over.flags ?? []),
    raw: over.raw ?? null,
  };
  db.prepare(
    `INSERT INTO transactions (id, at, amount, currency, amount_uah, mcc, description, category, flags_json, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.at,
    row.amount,
    row.currency,
    row.amount_uah,
    row.mcc,
    row.description,
    row.category,
    row.flags,
    row.raw,
  );
  return row;
}

function outboxTexts(db: ReturnType<typeof setup>['db']) {
  return (
    db.prepare('SELECT payload_json FROM outbox ORDER BY rowid').all() as { payload_json: string }[]
  ).map((r) => JSON.parse(r.payload_json) as { text: string; reply_markup?: unknown });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('періоди - за київською добою', () => {
  it('день, вчора, тиждень, місяць', () => {
    const day = resolvePeriod('день', NOON);
    expect(day.from).toBe('2026-09-06T21:00:00.000Z'); // київська північ 07.09
    expect(day.to).toBe(new Date(NOON).toISOString());
    // Попередній період - рівно та сама тривалість перед вікном.
    expect(Date.parse(day.from) - Date.parse(day.prevFrom)).toBe(
      Date.parse(day.to) - Date.parse(day.from),
    );

    expect(resolvePeriod('вчора', NOON)).toMatchObject({
      from: '2026-09-05T21:00:00.000Z',
      to: '2026-09-06T21:00:00.000Z',
    });
    // Понеділок - тиждень починається сьогодні.
    expect(resolvePeriod('тиждень', NOON).from).toBe('2026-09-06T21:00:00.000Z');
    expect(resolvePeriod('місяць', NOON).from).toBe('2026-08-31T21:00:00.000Z');
  });

  it('неділя належить тижню, що почався в понеділок', () => {
    const sunday = Date.parse('2026-09-13T09:00:00.000Z');
    expect(resolvePeriod('тиждень', sunday).from).toBe('2026-09-06T21:00:00.000Z');
  });

  it('Nd/Nw/Nm, YYYY-MM і діапазон; зимовий час дає інший зсув', () => {
    // 28 діб, рахуючи сьогоднішню: київська північ 11.08 - це 10.08 21:00 UTC.
    expect(resolvePeriod('4w', NOON).from).toBe('2026-08-10T21:00:00.000Z');
    expect(resolvePeriod('7d', NOON).from).toBe('2026-08-31T21:00:00.000Z');
    // Січень - зимовий час (+2), тож північ Києва це 22:00 UTC попередньої доби.
    expect(resolvePeriod('2026-01', NOON)).toMatchObject({
      from: '2025-12-31T22:00:00.000Z',
      to: '2026-01-31T22:00:00.000Z',
    });
    expect(resolvePeriod('2026-09-01..2026-09-03', NOON)).toMatchObject({
      from: '2026-08-31T21:00:00.000Z',
      to: '2026-09-03T21:00:00.000Z',
    });
  });

  it('невідомий період - явна помилка, а не тихий дефолт', () => {
    expect(() => resolvePeriod('колись', NOON)).toThrow(/не розібрано/);
    expect(() => resolvePeriod('0d', NOON)).toThrow(/порожній/);
    expect(() => resolvePeriod('2026-09-05..2026-09-01', NOON)).toThrow(/порожній/);
  });

  it('київська північ - опора всіх вікон', () => {
    expect(new Date(kyivDayStartMs(NOON)).toISOString()).toBe('2026-09-06T21:00:00.000Z');
  });
});

describe('зведення витрат', () => {
  it('зарахування не рахуються, валютні без еквівалента - окремим числом', async () => {
    const { env, db } = setup();
    seedTx(db, { amount: -18_000, description: 'Сільпо', category: 'продукти' });
    seedTx(db, { amount: -25_000, description: 'Glovo', category: 'кафе й ресторани' });
    seedTx(db, { id: 'in', amount: 500_000, amount_uah: 500_000, description: 'Зарплата' });
    seedTx(db, {
      id: 'usd',
      amount: -1299,
      currency: 'USD',
      amount_uah: null,
      description: 'Steam',
    });
    const rows = await selectSpending(env, {
      from: '2026-09-06T21:00:00.000Z',
      to: '2026-09-07T21:00:00.000Z',
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't2', 'usd']);
    const sum = summarize(rows);
    expect(sum).toMatchObject({ n: 3, total_uah: 43_000, unconverted: 1 });
    expect(sum.by_category[0]).toMatchObject({ category: 'кафе й ресторани', total: 25_000, n: 1 });
  });

  it('тестова транзакція у зріз не входить (07 §3)', async () => {
    const { env, db } = setup();
    seedTx(db, { amount: -18_000 });
    seedTx(db, { id: 'test-1', amount: -900_000, raw: JSON.stringify({ test: 1 }) });
    const rows = await selectSpending(env, {
      from: '2026-09-06T21:00:00.000Z',
      to: '2026-09-07T21:00:00.000Z',
    });
    expect(rows.map((r) => r.id)).toEqual(['t1']);
  });
});

describe('finance.query', () => {
  it('період: суми, розрізи, список і порівняння з попереднім', async () => {
    const { env, db } = setup();
    seedTx(db, { at: '2026-09-07T08:00:00.000Z', amount: -18_000, description: 'Сільпо' });
    seedTx(db, {
      at: '2026-09-07T10:00:00.000Z',
      amount: -25_000,
      description: 'Glovo',
      category: 'кафе й ресторани',
    });
    seedTx(db, { at: '2026-09-06T10:00:00.000Z', amount: -10_000, description: 'Сільпо' });
    const { result } = (await runFinanceQuery(env, { period: 'день' }, NOON)) as {
      result: Record<string, unknown> & { previous: unknown; list: { merchant: string }[] };
    };
    expect(result).toMatchObject({ mode: 'period', n: 1, total_uah: 18_000 });
    expect(result.total_text).toBe('180 грн');
    expect(result.previous).toMatchObject({ n: 1, total_uah: 10_000 });
    expect(result.list[0]).toMatchObject({ merchant: 'Сільпо', category: 'продукти' });
  });

  it('фільтри category / merchant / flags', async () => {
    const { env, db } = setup();
    seedTx(db, { at: '2026-09-07T08:00:00.000Z', amount: -18_000, description: 'Сільпо' });
    seedTx(db, {
      at: '2026-09-07T08:30:00.000Z',
      amount: -134_000,
      description: 'Comfy',
      category: 'техніка',
      flags: ['new_merchant', 'over_threshold'],
    });
    type PeriodResult = { result: { n: number; list: { merchant: string }[] } };
    const byCat = (await runFinanceQuery(
      env,
      { period: 'день', category: 'техніка' },
      NOON,
    )) as PeriodResult;
    expect(byCat.result.n).toBe(1);
    const byMerchant = (await runFinanceQuery(
      env,
      { period: 'день', merchant: 'сільпо' },
      NOON,
    )) as PeriodResult;
    expect(byMerchant.result.n).toBe(1);
    const byFlag = (await runFinanceQuery(
      env,
      { period: 'день', flags: ['over_threshold'] },
      NOON,
    )) as PeriodResult;
    expect(byFlag.result.list[0]!.merchant).toBe('Comfy');
  });

  it('id: транзакція + довідка по мерчанту, підписка й правило власника', async () => {
    const { env, db } = setup();
    seedTx(db, {
      id: 'old',
      at: '2026-08-07T09:00:00.000Z',
      amount: -53_700,
      description: 'Steam',
    });
    seedTx(db, {
      id: 'now',
      amount: -53_700,
      description: 'Steam',
      category: 'цифрові сервіси',
      flags: ['foreign', 'subscription'],
    });
    db.prepare(
      `INSERT INTO subscriptions (id, merchant, period, amount, currency, next_at, status, created_at)
       VALUES ('s1', 'Steam', 'month', 53700, 'UAH', '2026-10-07T09:00:00.000Z', 'active', '2026-08-07T09:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO merchant_rules (id, pattern, category, is_subscription) VALUES ('r1', 'Steam', 'цифрові сервіси', 1)`,
    ).run();
    const { result } = (await runFinanceQuery(env, { id: 'now' }, NOON)) as {
      result: {
        mode: string;
        tx: unknown;
        merchant: unknown;
        subscription: unknown;
        rule: unknown;
      };
    };
    expect(result.mode).toBe('id');
    expect(result.tx).toMatchObject({ merchant: 'Steam', flags: ['foreign', 'subscription'] });
    expect(result.merchant).toMatchObject({ count_24m: 1, last_at: '2026-08-07T09:00:00.000Z' });
    expect(result.subscription).toMatchObject({ id: 's1', status: 'active' });
    expect(result.rule).toMatchObject({ pattern: 'Steam', category: 'цифрові сервіси' });
  });

  it('без period і без id - помилка контракту, не порожній зріз', async () => {
    const { env } = setup();
    await expect(runFinanceQuery(env, {}, NOON)).rejects.toThrow(/потрібен period або id/);
    await expect(runFinanceQuery(env, { id: 'нема' }, NOON)).rejects.toThrow(/немає/);
  });
});

describe('finance.rule (T0 з «↩»)', () => {
  it('перейменування категорії перекладає й УЖЕ записану історію (S-4-10)', async () => {
    const { env, db } = setup();
    seedTx(db, { id: 'a', category: 'Рестор.', description: 'Пузата хата' });
    seedTx(db, { id: 'b', category: 'Рестор.', description: 'Креденс' });
    seedTx(db, { id: 'c', category: 'продукти', description: 'Сільпо' });
    const { result } = await runFinanceRule(env, { pattern: 'Рестор.', category: 'Кафе' });
    expect(result).toMatchObject({
      pattern: 'Рестор.',
      category: 'Кафе',
      recategorized: 2,
      created: true,
    });
    const cats = (
      db.prepare('SELECT id, category FROM transactions ORDER BY id').all() as {
        id: string;
        category: string;
      }[]
    ).map((r) => `${r.id}:${r.category}`);
    expect(cats).toEqual(['a:Кафе', 'b:Кафе', 'c:продукти']);
  });

  it('правило за мерчантом діє і на майбутні транзакції', async () => {
    const { env, db } = setup();
    await writeMonoAccounts(env, [{ id: 'acc', currency: 'UAH', maskedPan: null }], NOON);
    await runFinanceRule(env, { pattern: 'Comfy', category: 'подарунки' });
    await ingestTransaction(env, {
      item: {
        id: 'new-1',
        timeS: Math.floor(NOON / 1000),
        description: 'Comfy',
        mcc: 5732,
        amount: -30_000,
        operationAmount: -30_000,
        currency: 'UAH',
        hold: false,
        balance: null,
        comment: null,
      },
      account: 'acc',
      accountCurrency: 'UAH',
    });
    expect(db.prepare('SELECT category FROM transactions WHERE id = ?').get('new-1')).toMatchObject(
      {
        category: 'подарунки',
      },
    );
  });

  it('через policy - T0 з «↩», і відкат прибирає створене правило', async () => {
    const { env, db } = setup();
    const out = await applyPolicy(
      env,
      {
        kind: 'finance.rule',
        payload: { pattern: 'Comfy', category: 'подарунки' },
        threadId: 'dm',
        chatId: 555,
        tainted: false,
      },
      NOON,
    );
    expect(out.mode).toBe('executed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get()).toMatchObject({ n: 1 });
    const undoId = (out as { undo?: { id: string } }).undo?.id;
    expect(undoId).toBeTruthy();
    await resolveUndo(env, String(undoId), NOON + 1000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get()).toMatchObject({ n: 0 });
  });

  it('порожній pattern і правило без змісту - чесна відмова', async () => {
    const { env } = setup();
    await expect(runFinanceRule(env, { pattern: '  ', category: 'Кафе' })).rejects.toThrow(
      /потрібен pattern/,
    );
    await expect(runFinanceRule(env, { pattern: 'Comfy' })).rejects.toThrow(
      /потрібна category або is_subscription/,
    );
  });
});

describe('облік підписок', () => {
  it('крок → month·year; крок рахується до найближчої попередньої операції', () => {
    expect(periodLabel(30)).toBe('month');
    expect(periodLabel(365)).toBe('year');
    const at = Date.parse('2026-09-07T00:00:00Z');
    expect(
      stepDaysOf(at, [Date.parse('2026-08-08T00:00:00Z'), Date.parse('2026-07-08T00:00:00Z')]),
    ).toBe(30);
    expect(stepDaysOf(at, [])).toBeNull();
  });

  it('повторне списання САМЕ створює підписку, а наступне лише оновлює', async () => {
    const { env, db } = setup();
    await writeMonoAccounts(env, [{ id: 'acc', currency: 'UAH', maskedPan: null }], NOON);
    const charge = (id: string, iso: string) =>
      ingestTransaction(env, {
        item: {
          id,
          timeS: Math.floor(Date.parse(iso) / 1000),
          description: 'Spotify',
          mcc: 5815,
          amount: -20_000,
          operationAmount: -20_000,
          currency: 'UAH',
          hold: false,
          balance: null,
          comment: null,
        },
        account: 'acc',
        accountCurrency: 'UAH',
      });
    await charge('sp-1', '2026-07-07T09:00:00.000Z');
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()).toMatchObject({ n: 0 });
    await charge('sp-2', '2026-08-06T09:00:00.000Z');
    const subs = await listSubscriptions(env);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ merchant: 'Spotify', period: 'month', amount: 20_000 });
    expect(subs[0]!.next_at?.slice(0, 10)).toBe('2026-09-05');
    await charge('sp-3', '2026-09-05T09:00:00.000Z');
    expect(await listSubscriptions(env)).toHaveLength(1);
    expect(db.prepare('SELECT last_tx_id FROM subscriptions').get()).toMatchObject({
      last_tx_id: 'sp-3',
    });
  });

  it('скасована підписка не воскресає від наступного списання', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO subscriptions (id, merchant, period, amount, currency, next_at, status, created_at)
       VALUES ('s1', 'Spotify', 'month', 20000, 'UAH', '2026-09-05T00:00:00Z', 'cancelled', '2026-07-01T00:00:00Z')`,
    ).run();
    const out = await upsertSubscription(
      env,
      {
        id: 'sp-9',
        at: '2026-09-05T09:00:00.000Z',
        amount: -20_000,
        currency: 'UAH',
        merchant: 'Spotify',
      },
      30,
      NOON,
    );
    expect(out).toBeNull();
    expect(db.prepare('SELECT status FROM subscriptions WHERE id = ?').get('s1')).toMatchObject({
      status: 'cancelled',
    });
  });

  it('subscriptions.update: статус, дата і чесний відкат через policy', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO subscriptions (id, merchant, period, amount, currency, next_at, status, created_at)
       VALUES ('s1', 'Spotify', 'month', 20000, 'UAH', '2026-09-09T00:00:00Z', 'active', '2026-07-01T00:00:00Z')`,
    ).run();
    const out = await applyPolicy(
      env,
      {
        kind: 'subscriptions.update',
        payload: { id: 's1', status: 'cancelled' },
        threadId: 'dm',
        chatId: 555,
        tainted: false,
      },
      NOON,
    );
    expect(out.mode).toBe('executed');
    expect(db.prepare('SELECT status FROM subscriptions WHERE id = ?').get('s1')).toMatchObject({
      status: 'cancelled',
    });
    await resolveUndo(env, String((out as { undo?: { id: string } }).undo?.id), NOON + 1000);
    expect(
      db.prepare('SELECT status, next_at FROM subscriptions WHERE id = ?').get('s1'),
    ).toMatchObject({
      status: 'active',
      next_at: '2026-09-09T00:00:00Z',
    });
  });

  it('чужий статус і неіснуючий id - відмова', async () => {
    const { env } = setup();
    await expect(updateSubscription(env, { id: 'нема' })).rejects.toThrow(/немає/);
  });

  it('кнопка лише для безпечного id', () => {
    expect(subscriptionButtons('s1')[0]![0]).toMatchObject({ callback_data: 'm:fs:s1:cancel' });
    expect(subscriptionButtons('s:1')).toEqual([]);
  });
});

describe('задача subscription-remind (S-4-6)', () => {
  it('за два дні до списання - рядок із кнопкою; поза 11:00 і вдруге - мовчання', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO subscriptions (id, merchant, period, amount, currency, next_at, status, created_at)
       VALUES ('s1', 'Spotify', 'month', 499, 'USD', ?, 'active', '2026-07-01T00:00:00Z')`,
    ).run(`${addDays('2026-09-07', 2)}T09:00:00.000Z`);
    expect(await subscriptionRemindTask(env, NOON)).toEqual({ skipped: 'hour' });
    expect(await subscriptionRemindTask(env, REMIND)).toMatchObject({ sent: true, count: 1 });
    const [msg] = outboxTexts(db);
    expect(msg!.text).toBe('Післязавтра Spotify 4,99 $.');
    expect(msg!.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: 'Скасувати підписку в обліку', callback_data: 'm:fs:s1:cancel' }]],
    });
    expect(await env.BRIEFING.get(REMIND_MARKER_KEY)).toBe('2026-09-07');
    expect(await subscriptionRemindTask(env, REMIND + 60_000)).toEqual({ skipped: 'done' });
  });

  it('за три дні або наступного тижня - тиша (це справа підказки)', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO subscriptions (id, merchant, period, amount, currency, next_at, status, created_at)
       VALUES ('s1', 'Spotify', 'month', 499, 'USD', '2026-09-10T09:00:00.000Z', 'active', '2026-07-01T00:00:00Z')`,
    ).run();
    expect(await subscriptionRemindTask(env, REMIND)).toEqual({ sent: false });
    expect(outboxTexts(db)).toHaveLength(0);
  });

  it('скасована підписка не нагадує', async () => {
    const { env, db } = setup();
    db.prepare(
      `INSERT INTO subscriptions (id, merchant, period, amount, currency, next_at, status, created_at)
       VALUES ('s1', 'Spotify', 'month', 499, 'USD', ?, 'cancelled', '2026-07-01T00:00:00Z')`,
    ).run(`${addDays('2026-09-07', 2)}T09:00:00.000Z`);
    expect(await subscriptionRemindTask(env, REMIND)).toEqual({ sent: false });
    expect(outboxTexts(db)).toHaveLength(0);
  });
});

describe('вечірній рядок (S-4-7)', () => {
  it('текст: сума, кількість, найбільша покупка; нуль - тиша', () => {
    expect(eveningText(summarize([]))).toBeNull();
    const rows = [
      {
        id: 'a',
        at: '',
        amount: -134_000,
        currency: 'UAH',
        amount_uah: -134_000,
        mcc: 0,
        merchant: 'Comfy',
        category: 'техніка',
        flags: [],
        note: null,
      },
      {
        id: 'b',
        at: '',
        amount: -25_000,
        currency: 'UAH',
        amount_uah: -25_000,
        mcc: 0,
        merchant: 'Glovo',
        category: 'кафе',
        flags: [],
        note: null,
      },
      {
        id: 'c',
        at: '',
        amount: -18_000,
        currency: 'UAH',
        amount_uah: -18_000,
        mcc: 0,
        merchant: 'Сільпо',
        category: 'продукти',
        flags: [],
        note: null,
      },
      {
        id: 'd',
        at: '',
        amount: -4_200,
        currency: 'UAH',
        amount_uah: -4_200,
        mcc: 0,
        merchant: 'Кава',
        category: 'кафе',
        flags: [],
        note: null,
      },
    ];
    expect(eveningText(summarize(rows))).toBe(
      'Сьогодні 1 812 грн · 4 покупки · найбільша Comfy 1 340 грн.',
    );
    // Одна покупка - без «найбільшої»: вона ж і єдина.
    expect(eveningText(summarize(rows.slice(0, 1)))).toBe('Сьогодні 1 340 грн · 1 покупка.');
    // Валютна без еквівалента видима окремо, а не мовчки пропущена.
    const withUsd = [...rows.slice(0, 1), { ...rows[1]!, amount_uah: null }];
    expect(eveningText(summarize(withUsd))).toContain('Ще 1 у валюті');
  });

  it('задача: 21:00, лише сьогоднішні витрати, мітка ставиться і при тиші', async () => {
    const { env, db } = setup();
    seedTx(db, { at: '2026-09-07T08:00:00.000Z', amount: -134_000, description: 'Comfy' });
    seedTx(db, { at: '2026-09-06T08:00:00.000Z', amount: -50_000, description: 'Вчора' });
    expect(await financeEveningTask(env, NOON)).toEqual({ skipped: 'hour' });
    expect(await financeEveningTask(env, EVENING)).toMatchObject({ sent: true, n: 1 });
    expect(outboxTexts(db)[0]!.text).toBe('Сьогодні 1 340 грн · 1 покупка.');
    expect(await env.BRIEFING.get(EVENING_MARKER_KEY)).toBe('2026-09-07');
    expect(await financeEveningTask(env, EVENING + 60_000)).toEqual({ skipped: 'done' });
  });

  it('нуль покупок - ТИША, але день закрито', async () => {
    const { env, db } = setup();
    expect(await financeEveningTask(env, EVENING)).toEqual({ sent: false });
    expect(outboxTexts(db)).toHaveLength(0);
    expect(await env.BRIEFING.get(EVENING_MARKER_KEY)).toBe('2026-09-07');
  });
});
