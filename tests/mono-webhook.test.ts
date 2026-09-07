// Гроші: вебхук Mono, категорії MCC, правила «незвичного» і звірка
// (етап 6 PR-1, S-4-1…S-4-5, S-4-9, S-4-11, S-4-12).
//
// Головне, що тут пінимо: повідомлення про незвичну покупку будує ЯДРО
// детерміновано (жодного виклику мозку), а публічний вебхук відмовляє все,
// що не пройшло чотири бар'єри - секрет у шляху, стелю тіла, форму й
// перевірку `account`.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clientInfo,
  numericToAlpha,
  parseStatementItem,
  setWebhook,
  statement,
  monoToken,
  MonoTooSoonError,
  STATEMENT_MAX_S,
} from '../web/core/adapters/mono.mjs';
import { categoryByMcc, MCC_CATEGORIES, FALLBACK_CATEGORY } from '../web/core/finance/mcc.mjs';
import {
  computeFlags,
  categoryOf,
  isSubscriptionStep,
  looksPeriodic,
  matchRule,
  merchantKey,
  normalizeMerchant,
  isLoud,
  THRESHOLD_DEFAULT,
} from '../web/core/finance/rules.mjs';
import {
  readMonoAccounts,
  writeMonoAccounts,
  hasAnyTransaction,
} from '../web/core/finance/store.mjs';
import { transactionButtons, transactionText } from '../web/core/finance/notify.mjs';
import {
  handleMonoWebhook,
  handleMonoTest,
  monoWebhookUrl,
  MONO_WEBHOOK_PREFIX,
  UNKNOWN_ALERT_KEY,
} from '../web/core/finance/webhook.mjs';
import { monoReconcileTask, RECONCILE_STATE_KEY } from '../web/core/finance/reconcile.mjs';
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

const SECRET = 'mono-webhook-secret-32-symbols-ok';
const ACCOUNT = 'acc-uah-1';
/** Понеділок 07.09.2026, 12:00 Києва. */
const NOON = Date.parse('2026-09-07T09:00:00.000Z');
/** Того ж дня 23:35 Києва - вікно звірки. */
const NIGHT = Date.parse('2026-09-07T20:35:00.000Z');

function setup(kv: Record<string, string> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map(Object.entries(kv))),
    ASSISTANT_V2: 'on',
    TELEGRAM_CHAT_ID: '555',
    TOPIC_ASSISTANT: '99',
    TOPIC_SYSTEM: '77',
    MONO_TOKEN: 'mono-token',
    MONO_WEBHOOK_SECRET: SECRET,
    MINI_APP_URL: 'https://svitanok.yushko.dev',
  });
  return { d1, db: d1.db, env };
}

/** Рахунки власника у facts - без них вебхук відмовляє (S-4-12). */
async function seedAccounts(
  env: Env,
  accounts = [{ id: ACCOUNT, currency: 'UAH', maskedPan: '44**11' }],
) {
  await writeMonoAccounts(env, accounts, NOON);
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    time: Math.floor(NOON / 1000),
    description: 'Comfy',
    mcc: 5732,
    amount: -134_000,
    operationAmount: -134_000,
    currencyCode: 980,
    hold: false,
    balance: 1_000_000,
    ...over,
  };
}

function webhookRequest(body: unknown, secret = SECRET, method = 'POST') {
  return new Request(`https://svitanok.yushko.dev${MONO_WEBHOOK_PREFIX}${secret}`, {
    method,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    headers: { 'content-type': 'application/json' },
  });
}

function statementBody(body: unknown, account = ACCOUNT) {
  return { type: 'StatementItem', data: { account, statementItem: body } };
}

function outboxTexts(db: ReturnType<typeof setup>['db']) {
  // ORDER BY rowid, не id: обидва ряди можуть лягти з тим самим nowMs у
  // префіксі id, і сортування за ним віддавало б їх у випадковому порядку.
  return (
    db.prepare('SELECT payload_json FROM outbox ORDER BY rowid').all() as { payload_json: string }[]
  ).map((r) => JSON.parse(r.payload_json) as { text: string; reply_markup?: unknown });
}

function routeFetch(routes: { match: string; body: unknown; status?: number }[]) {
  const calls: { url: string; body: string | null }[] = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body == null ? null : String(init.body) });
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`несподіваний запит: ${url}`);
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('категорії MCC', () => {
  it('22 групи, кожен код рівно в одній, невідомий - «інше»', () => {
    expect(MCC_CATEGORIES).toHaveLength(22);
    expect(new Set(MCC_CATEGORIES).size).toBe(22);
    expect(categoryByMcc(5411)).toBe('продукти');
    expect(categoryByMcc(5812)).toBe('кафе й ресторани');
    expect(categoryByMcc(5732)).toBe('техніка');
    expect(categoryByMcc(4121)).toBe('транспорт');
    // Діапазон 3000-3999: авіа, оренда авто, готелі.
    expect(categoryByMcc(3010)).toBe('подорожі');
    expect(categoryByMcc(3501)).toBe('подорожі');
    expect(categoryByMcc(9999)).toBe(FALLBACK_CATEGORY);
    // Mono шле mcc: 0 на переказах між своїми рахунками.
    expect(categoryByMcc(0)).toBe(FALLBACK_CATEGORY);
    expect(categoryByMcc('нічого')).toBe(FALLBACK_CATEGORY);
  });
});

describe('нормалізація мерчанта і правила власника', () => {
  it('префікс агрегатора геть, ключ без регістру й пунктуації', () => {
    expect(normalizeMerchant(' IN*Сільпо  315 ')).toBe('Сільпо 315');
    expect(normalizeMerchant('PAYPAL *STEAM')).toBe('STEAM');
    expect(merchantKey('Сільпо 315')).toBe(merchantKey('СІЛЬПО-315'));
    expect(merchantKey('Comfy')).not.toBe(merchantKey('Rozetka'));
    // Керівні символи й розмітка з чужого опису до ключа не доходять.
    expect(normalizeMerchant('<b>Shop</b>')).toBe('bShop/b');
  });

  it('pattern - підрядок без регістру, не регулярка (ReDoS з бази неможливий)', () => {
    const rules = [{ pattern: 'сільпо', category: 'продукти', is_subscription: 0 }];
    expect(matchRule(rules, 'Сільпо 315')?.category).toBe('продукти');
    expect(matchRule([{ pattern: '.*', category: 'x', is_subscription: 0 }], 'Comfy')).toBeNull();
  });

  it('правило власника має пріоритет над довідником MCC', () => {
    const rules = [{ pattern: 'comfy', category: 'подарунки', is_subscription: 0 }];
    expect(categoryOf({ mcc: 5732, merchant: 'Comfy' }, rules)).toBe('подарунки');
    expect(categoryOf({ mcc: 5732, merchant: 'Rozetka' }, rules)).toBe('техніка');
  });
});

describe('прапорці «незвичного»', () => {
  const base = {
    amountUah: -18_000,
    currency: 'UAH',
    accountCurrency: 'UAH',
    isSpending: true,
    knownMerchant: true,
    duplicate: false,
    inSubscriptions: false,
    periodic: false,
    ruleSubscription: false,
    threshold: THRESHOLD_DEFAULT,
  };

  it('звичайна покупка - жодного прапорця (S-4-1)', () => {
    expect(computeFlags(base)).toEqual([]);
    expect(isLoud([])).toBe(false);
  });

  it('новий мерчант + понад поріг (S-4-2)', () => {
    const flags = computeFlags({ ...base, amountUah: -134_000, knownMerchant: false });
    expect(flags).toEqual(['new_merchant', 'over_threshold']);
    expect(isLoud(flags)).toBe(true);
  });

  it('поріг - строго БІЛЬШЕ 1 000 грн, рівно тисяча не прапорець', () => {
    expect(computeFlags({ ...base, amountUah: -100_000 })).toEqual([]);
    expect(computeFlags({ ...base, amountUah: -100_001 })).toEqual(['over_threshold']);
  });

  it('чужа валюта (S-4-5) і дубль (S-4-4)', () => {
    expect(computeFlags({ ...base, currency: 'USD' })).toEqual(['foreign']);
    expect(computeFlags({ ...base, duplicate: true })).toEqual(['duplicate']);
  });

  it('підписка: облік, правило власника або періодичність (S-4-6)', () => {
    expect(computeFlags({ ...base, inSubscriptions: true })).toEqual(['subscription']);
    expect(computeFlags({ ...base, ruleSubscription: true })).toEqual(['subscription']);
    expect(computeFlags({ ...base, periodic: true })).toEqual(['subscription']);
    // Сама по собі підписка не «гучна»: про неї нагадує subscription-remind.
    expect(isLoud(['subscription', 'foreign'])).toBe(false);
  });

  it('ЗАРАХУВАННЯ прапорців не отримують', () => {
    expect(
      computeFlags({ ...base, isSpending: false, knownMerchant: false, amountUah: 5_000_000 }),
    ).toEqual([]);
  });

  it('крок підписки: 7 / 30 / 365 діб із допуском ±2', () => {
    expect(isSubscriptionStep(30)).toBe(true);
    expect(isSubscriptionStep(28)).toBe(true);
    expect(isSubscriptionStep(31)).toBe(true);
    expect(isSubscriptionStep(20)).toBe(false);
    const at = Date.parse('2026-09-07T00:00:00Z');
    expect(looksPeriodic(at, [Date.parse('2026-08-08T00:00:00Z')])).toBe(true);
    expect(looksPeriodic(at, [Date.parse('2026-08-25T00:00:00Z')])).toBe(false); // 13 діб - не крок
    // Майбутні дати кроком не вважаються.
    expect(looksPeriodic(at, [Date.parse('2026-10-07T00:00:00Z')])).toBe(false);
  });
});

describe('адаптер Mono', () => {
  it('без токена - явна відмова, не тиха деградація', () => {
    expect(() => monoToken(workerEnv({}))).toThrow(/MONO_TOKEN не заданий/);
  });

  it('parseStatementItem відкидає тіло без обовʼязкових полів', () => {
    expect(parseStatementItem(item())).toMatchObject({ id: 'tx-1', amount: -134_000 });
    expect(parseStatementItem({ ...item(), id: '' })).toBeNull();
    expect(parseStatementItem({ ...item(), time: 'вчора' })).toBeNull();
    expect(parseStatementItem({ ...item(), amount: 12.5 })).toBeNull();
    expect(parseStatementItem(null)).toBeNull();
    // Опис - зовнішній текст: ріжеться, переноси рядків складаються.
    expect(
      parseStatementItem({ ...item(), description: `a\n\nb${'x'.repeat(400)}` })!.description,
    ).toHaveLength(200);
  });

  it('валюти: числовий код → alpha-3, невідомий - видимий #код', () => {
    expect(numericToAlpha(980)).toBe('UAH');
    expect(numericToAlpha(840)).toBe('USD');
    expect(numericToAlpha(999)).toBe('#999');
    expect(numericToAlpha('дурня')).toBe('?');
  });

  it('client-info і виписка; 429 - окремий тип помилки, токен поза текстом', async () => {
    const { env } = setup();
    routeFetch([
      {
        match: 'client-info',
        body: {
          name: 'Назар',
          webHookUrl: 'https://svitanok.yushko.dev/api/mono/x',
          accounts: [{ id: ACCOUNT, currencyCode: 980, type: 'black', maskedPan: ['44**11'] }],
        },
      },
      { match: 'statement', body: [item()] },
    ]);
    const info = await clientInfo(env);
    expect(info.accounts).toEqual([
      {
        id: ACCOUNT,
        currency: 'UAH',
        currencyCode: 980,
        type: 'black',
        maskedPan: '44**11',
        iban: null,
      },
    ]);
    const items = await statement(env, {
      account: ACCOUNT,
      fromS: Math.floor(NOON / 1000) - 3600,
      toS: Math.floor(NOON / 1000),
    });
    expect(items).toHaveLength(1);

    routeFetch([{ match: 'client-info', body: {}, status: 429 }]);
    await expect(clientInfo(env)).rejects.toBeInstanceOf(MonoTooSoonError);

    routeFetch([{ match: 'client-info', body: { errorDescription: 'Unauthorized' }, status: 403 }]);
    await expect(clientInfo(env)).rejects.toThrow(/HTTP 403/);
    await expect(clientInfo(env)).rejects.not.toThrow(/mono-token/);
  });

  it('виписка: чужий id рахунку і завелике вікно - відмова ДО мережі', async () => {
    const { env } = setup();
    const fetchSpy = routeFetch([]);
    const toS = Math.floor(NOON / 1000);
    await expect(statement(env, { account: '../../etc', fromS: toS - 60, toS })).rejects.toThrow(
      /чужий id/,
    );
    await expect(
      statement(env, { account: ACCOUNT, fromS: toS - STATEMENT_MAX_S - 1, toS }),
    ).rejects.toThrow(/вікно понад/);
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it('setWebhook приймає лише https', async () => {
    const { env } = setup();
    routeFetch([{ match: 'webhook', body: {} }]);
    await expect(setWebhook(env, 'http://evil')).rejects.toThrow(/https/);
    expect(await setWebhook(env, 'https://svitanok.yushko.dev/api/mono/s')).toBe(true);
  });
});

describe('вебхук: бар’єри', () => {
  it('чужий секрет у шляху - 404 без роботи', async () => {
    const { env, db } = setup();
    await seedAccounts(env);
    const res = await handleMonoWebhook(env2req(env, 'not-the-secret'), env, undefined, NOON);
    expect(res.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toMatchObject({ n: 0 });
  });

  it('GET на адресу з правильним секретом - 200 (Mono пінгує перед збереженням)', async () => {
    const { env } = setup();
    const res = await handleMonoWebhook(webhookRequest(null, SECRET, 'GET'), env, undefined, NOON);
    expect(res.status).toBe(200);
  });

  it('без MONO_WEBHOOK_SECRET - 500, а не «пускаємо всіх»', async () => {
    const { env } = setup();
    (env as { MONO_WEBHOOK_SECRET?: string }).MONO_WEBHOOK_SECRET = undefined;
    const res = await handleMonoWebhook(
      webhookRequest(statementBody(item())),
      env,
      undefined,
      NOON,
    );
    expect(res.status).toBe(500);
  });

  it('тіло понад стелю - 413 без розбору', async () => {
    const { env } = setup();
    await seedAccounts(env);
    const huge = statementBody({ ...item(), comment: 'x'.repeat(20_000) });
    const res = await handleMonoWebhook(webhookRequest(huge), env, undefined, NOON);
    expect(res.status).toBe(413);
  });

  it('не StatementItem або без id - 400', async () => {
    const { env } = setup();
    await seedAccounts(env);
    expect(
      (await handleMonoWebhook(webhookRequest({ type: 'Other' }), env, undefined, NOON)).status,
    ).toBe(400);
    expect(
      (await handleMonoWebhook(webhookRequest(statementBody({ id: '' })), env, undefined, NOON))
        .status,
    ).toBe(400);
  });

  it('невідомий рахунок - відкинути й алерт раз на добу (S-4-12)', async () => {
    const { env, db } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedAccounts(env);
    const res = await handleMonoWebhook(
      webhookRequest(statementBody(item(), 'acc-чужий')),
      env,
      undefined,
      NOON,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown-account' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toMatchObject({ n: 0 });
    const alerts = outboxTexts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain('невідомий рахунок');
    expect(await env.BRIEFING.get(UNKNOWN_ALERT_KEY)).toBe(String(NOON));
    // Другий підроблений вебхук того ж дня алерту вже не додає.
    await handleMonoWebhook(
      webhookRequest(statementBody(item(), 'acc-чужий')),
      env,
      undefined,
      NOON,
    );
    expect(outboxTexts(db)).toHaveLength(1);
  });

  it('списку рахунків ще немає - теж відмова (звірка добере з виписки)', async () => {
    const { env, db } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleMonoWebhook(
      webhookRequest(statementBody(item())),
      env,
      undefined,
      NOON,
    );
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toMatchObject({ n: 0 });
  });
});

describe('вебхук: шлях транзакції', () => {
  it('звичайна покупка - запис із категорією і ТИША (S-4-1)', async () => {
    const { env, db } = setup();
    await seedAccounts(env);
    // Мерчант уже траплявся - інакше він «новий».
    db.prepare(
      `INSERT INTO transactions (id, at, amount, currency, amount_uah, mcc, description, category, flags_json)
       VALUES ('old', '2026-08-01T10:00:00.000Z', -18000, 'UAH', -18000, 5411, 'Сільпо', 'продукти', '[]')`,
    ).run();
    const res = await handleMonoWebhook(
      webhookRequest(
        statementBody(
          item({
            id: 'tx-2',
            description: 'Сільпо',
            mcc: 5411,
            amount: -18_000,
            operationAmount: -18_000,
          }),
        ),
      ),
      env,
      undefined,
      NOON,
    );
    expect(res.status).toBe(200);
    const row = db
      .prepare(
        'SELECT category, flags_json, amount, amount_uah, currency FROM transactions WHERE id = ?',
      )
      .get('tx-2');
    expect(row).toMatchObject({
      category: 'продукти',
      flags_json: '[]',
      amount: -18_000,
      amount_uah: -18_000,
      currency: 'UAH',
    });
    expect(outboxTexts(db)).toHaveLength(0);
  });

  it('новий мерчант і велика сума - повідомлення з кнопками (S-4-2)', async () => {
    const { env, db } = setup();
    await seedAccounts(env);
    await handleMonoWebhook(webhookRequest(statementBody(item())), env, undefined, NOON);
    const [msg] = outboxTexts(db);
    expect(msg!.text).toContain('1 340 грн');
    expect(msg!.text).toContain('«Comfy»');
    expect(msg!.text).toContain('новий мерчант, велика сума');
    expect(msg!.text).toContain('Техніка за місяць: 1 340 грн.');
    expect(msg!.reply_markup).toMatchObject({
      inline_keyboard: [
        [
          { text: '🔎 Перевірити ціни', callback_data: 'm:fx:tx-1:price' },
          { text: 'Ок', callback_data: 'm:fx:tx-1:ok' },
        ],
        [{ text: '✏️ Категорія', callback_data: 'm:fx:tx-1:cat' }],
      ],
    });
  });

  it('той самий id двічі - рівно один рядок і одне повідомлення', async () => {
    const { env, db } = setup();
    await seedAccounts(env);
    await handleMonoWebhook(webhookRequest(statementBody(item())), env, undefined, NOON);
    await handleMonoWebhook(webhookRequest(statementBody(item())), env, undefined, NOON);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toMatchObject({ n: 1 });
    expect(outboxTexts(db)).toHaveLength(1);
  });

  it('холд закрився остаточною сумою - рядок оновлюється, другого повідомлення немає', async () => {
    const { env, db } = setup();
    await seedAccounts(env);
    await handleMonoWebhook(
      webhookRequest(
        statementBody(item({ hold: true, amount: -150_000, operationAmount: -150_000 })),
      ),
      env,
      undefined,
      NOON,
    );
    await handleMonoWebhook(
      webhookRequest(
        statementBody(item({ hold: false, amount: -134_000, operationAmount: -134_000 })),
      ),
      env,
      undefined,
      NOON,
    );
    expect(
      db.prepare('SELECT amount, amount_uah FROM transactions WHERE id = ?').get('tx-1'),
    ).toMatchObject({
      amount: -134_000,
      amount_uah: -134_000,
    });
    expect(outboxTexts(db)).toHaveLength(1);
  });

  it('дубль за 5 хв - своє питання і свої кнопки (S-4-4)', async () => {
    const { env, db } = setup();
    await seedAccounts(env);
    const first = item({
      id: 'g1',
      description: 'Glovo',
      mcc: 5812,
      amount: -25_000,
      operationAmount: -25_000,
    });
    await handleMonoWebhook(webhookRequest(statementBody(first)), env, undefined, NOON);
    const second = item({
      id: 'g2',
      description: 'Glovo',
      mcc: 5812,
      amount: -25_000,
      operationAmount: -25_000,
      time: Math.floor(NOON / 1000) + 180,
    });
    await handleMonoWebhook(webhookRequest(statementBody(second)), env, undefined, NOON);
    const texts = outboxTexts(db);
    const dup = texts.at(-1)!;
    expect(dup.text).toContain('Два списання по 250 грн у «Glovo» за 3 хв');
    expect(dup.reply_markup).toMatchObject({
      inline_keyboard: [
        [
          { text: 'Так, перевірю', callback_data: 'm:fx:g2:dupy' },
          { text: 'Ні', callback_data: 'm:fx:g2:ok' },
        ],
      ],
    });
    const flags = JSON.parse(
      (
        db.prepare('SELECT flags_json FROM transactions WHERE id = ?').get('g2') as {
          flags_json: string;
        }
      ).flags_json,
    );
    expect(flags).toContain('duplicate');
  });

  it('списання в USD: оригінал і гривневий еквівалент (S-4-5)', async () => {
    const { env, db } = setup();
    await seedAccounts(env);
    await handleMonoWebhook(
      webhookRequest(
        statementBody(
          item({
            id: 'usd-1',
            description: 'Steam',
            mcc: 5816,
            amount: -53_700,
            operationAmount: -1299,
            currencyCode: 840,
          }),
        ),
      ),
      env,
      undefined,
      NOON,
    );
    const row = db
      .prepare('SELECT amount, currency, amount_uah, flags_json FROM transactions WHERE id = ?')
      .get('usd-1') as {
      amount: number;
      currency: string;
      amount_uah: number;
      flags_json: string;
    };
    expect(row).toMatchObject({ amount: -1299, currency: 'USD', amount_uah: -53_700 });
    expect(JSON.parse(row.flags_json)).toContain('foreign');
    expect(outboxTexts(db)[0]!.text).toContain('12,99 $ (537 грн)');
  });
});

describe('текст і кнопки (чисті функції)', () => {
  const tx = {
    id: 'tx-1',
    at: '2026-09-07T09:00:00.000Z',
    amount: -134_000,
    currency: 'UAH',
    amount_uah: -134_000,
    mcc: 5732,
    description: 'Comfy',
    merchant: 'Comfy',
    category: 'техніка',
    flags: ['new_merchant'],
    balance: null,
  };

  it('назва мерчанта проходить через cleanSource - розмітка й лінки не долітають', () => {
    const text = transactionText({ ...tx, merchant: '[тиць](https://evil.example) SHOP' });
    expect(text).not.toContain('http');
    expect(text).not.toContain('](');
  });

  it('id поза дозволеним алфавітом - кнопок немає, а не крива callback_data', () => {
    expect(transactionButtons('ok_id=', false)).toHaveLength(2);
    expect(transactionButtons('id:with:colons', false)).toEqual([]);
    expect(transactionButtons('x'.repeat(50), false)).toEqual([]);
  });

  it('підписка й чужа валюта в переліку причин не називаються', () => {
    expect(transactionText({ ...tx, flags: ['new_merchant', 'subscription'] })).toContain(
      '· новий мерчант.',
    );
  });
});

describe('звірка mono-reconcile', () => {
  const clientBody = (webHookUrl: string | null) => ({
    name: 'Назар',
    webHookUrl,
    accounts: [{ id: ACCOUNT, currencyCode: 980, type: 'black', maskedPan: ['44**11'] }],
  });

  it('поза 23:30 не працює - але за відсутнього списку рахунків іде по client-info', async () => {
    const { env } = setup();
    await seedAccounts(env);
    expect(await monoReconcileTask(env, NOON)).toEqual({ skipped: 'not-due' });

    const { env: env2, db } = setup();
    routeFetch([
      {
        match: 'client-info',
        body: clientBody(monoWebhookUrl(env2, 'https://svitanok.yushko.dev')),
      },
    ]);
    const out = await monoReconcileTask(env2, NOON);
    expect(out).toMatchObject({ accounts: 1, rearmed: false });
    expect((await readMonoAccounts(env2))[0]).toMatchObject({ id: ACCOUNT, currency: 'UAH' });
    expect(outboxTexts(db)).toHaveLength(0);
  });

  it('вебхук зник - ставимо заново й кажемо про це (S-4-9)', async () => {
    const { env, db } = setup();
    const { calls } = routeFetch([
      { match: 'client-info', body: clientBody(null) },
      { match: 'personal/webhook', body: {} },
    ]);
    const out = await monoReconcileTask(env, NIGHT);
    expect(out).toMatchObject({ rearmed: true });
    const put = calls.find((c) => c.url.includes('personal/webhook'))!;
    expect(JSON.parse(put.body!)).toEqual({
      webHookUrl: `https://svitanok.yushko.dev${MONO_WEBHOOK_PREFIX}${SECRET}`,
    });
    expect(outboxTexts(db)[0]!.text).toContain('порожній');
  });

  it('РІВНО один виклик Mono за тік (ліміт 1/60 с); виписка - наступним', async () => {
    const { env, db } = setup();
    // База НЕ порожня - інакше це первинне завантаження, а воно мовчазне.
    db.prepare(
      `INSERT INTO transactions (id, at, amount, currency, amount_uah, mcc, description, category, flags_json)
       VALUES ('old', '2026-08-01T10:00:00.000Z', -18000, 'UAH', -18000, 5411, 'Сільпо', 'продукти', '[]')`,
    ).run();
    const expected = monoWebhookUrl(env, 'https://svitanok.yushko.dev');
    const mono = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('monobank.ua'));
    const first = routeFetch([{ match: 'client-info', body: clientBody(expected) }]);
    await monoReconcileTask(env, NIGHT);
    expect(mono(first.calls)).toHaveLength(1);

    const second = routeFetch([{ match: 'statement', body: [item({ id: 'miss-1' })] }]);
    const out = await monoReconcileTask(env, NIGHT);
    expect(mono(second.calls)).toHaveLength(1);
    expect(out).toMatchObject({ done: true, imported: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toMatchObject({ n: 2 });
    // Пропущена незвична покупка все одно доїжджає до власника.
    expect(outboxTexts(db).some((m) => m.text.includes('«Comfy»'))).toBe(true);
    // Третій тік уже нічого не робить.
    routeFetch([]);
    expect(await monoReconcileTask(env, NIGHT)).toEqual({ skipped: 'done' });
  });

  it('перший запуск - історія за 31 добу МОВЧКИ (S-4-11)', async () => {
    const { env, db } = setup();
    const expected = monoWebhookUrl(env, 'https://svitanok.yushko.dev');
    routeFetch([{ match: 'client-info', body: clientBody(expected) }]);
    await monoReconcileTask(env, NIGHT);
    const state = JSON.parse((await env.BRIEFING.get(RECONCILE_STATE_KEY))!) as {
      initial: boolean;
      fromS: number;
      toS: number;
    };
    expect(state.initial).toBe(true);
    expect(state.toS - state.fromS).toBe(31 * 86_400);

    routeFetch([{ match: 'statement', body: [item({ id: 'h1' }), item({ id: 'h2' })] }]);
    await monoReconcileTask(env, NIGHT);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toMatchObject({ n: 2 });
    // Прапорців не рахували - жодної «незвичної» покупки в чат.
    expect(db.prepare("SELECT flags_json FROM transactions WHERE id = 'h1'").get()).toMatchObject({
      flags_json: '[]',
    });
    expect(outboxTexts(db).some((m) => m.text.includes('«Comfy»'))).toBe(false);
    expect(outboxTexts(db).some((m) => m.text.includes('Завантажив історію Mono'))).toBe(true);
    expect(await hasAnyTransaction(env)).toBe(true);
  });

  it('429 від Mono - не збій: крок не зсувається, алерту немає', async () => {
    const { env, db } = setup();
    routeFetch([{ match: 'client-info', body: {}, status: 429 }]);
    expect(await monoReconcileTask(env, NIGHT)).toEqual({ skipped: 'too-soon' });
    expect(outboxTexts(db)).toHaveLength(0);
    const state = JSON.parse((await env.BRIEFING.get(RECONCILE_STATE_KEY)) ?? 'null');
    expect(state).toBeNull();
  });

  it('збій Mono - алерт і повтор тієї самої фази наступним тіком', async () => {
    const { env, db } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    routeFetch([{ match: 'client-info', body: {}, status: 500 }]);
    expect(await monoReconcileTask(env, NIGHT)).toMatchObject({ failed: 'client' });
    expect(outboxTexts(db)[0]!.text).toContain('Звірка Mono впала');
    const expected = monoWebhookUrl(env, 'https://svitanok.yushko.dev');
    routeFetch([{ match: 'client-info', body: clientBody(expected) }]);
    expect(await monoReconcileTask(env, NIGHT)).toMatchObject({ accounts: 1 });
  });
});

describe('POST /internal/test/mono', () => {
  function testRequest(body: unknown, headers: Record<string, string>) {
    return new Request('https://svitanok.yushko.dev/internal/test/mono', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  it('без X-Test або з чужим секретом - 404', async () => {
    const { env } = setup();
    await seedAccounts(env);
    expect(
      (await handleMonoTest(testRequest({ amount: -100 }, { 'X-Mono-Secret': SECRET }), env, NOON))
        .status,
    ).toBe(404);
    expect(
      (
        await handleMonoTest(
          testRequest({ amount: -100 }, { 'X-Test': '1', 'X-Mono-Secret': 'wrong-secret' }),
          env,
          NOON,
        )
      ).status,
    ).toBe(404);
  });

  it('при ASSISTANT_V2=off маршруту не існує', async () => {
    const { env } = setup();
    (env as { ASSISTANT_V2?: string }).ASSISTANT_V2 = 'off';
    const res = await handleMonoTest(
      testRequest({ amount: -100 }, { 'X-Test': '1', 'X-Mono-Secret': SECRET }),
      env,
      NOON,
    );
    expect(res.status).toBe(404);
  });

  it('транзакція лягає з міткою test і не входить у суми звітів', async () => {
    const { env, db } = setup();
    await seedAccounts(env);
    const res = await handleMonoTest(
      testRequest(
        { amount: -134_000, description: 'Comfy', mcc: 5732 },
        { 'X-Test': '1', 'X-Mono-Secret': SECRET },
      ),
      env,
      NOON,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      inserted: true,
      announced: true,
      category: 'техніка',
      flags: ['new_merchant', 'over_threshold'],
    });
    const raw = db.prepare('SELECT raw_json FROM transactions LIMIT 1').get() as {
      raw_json: string;
    };
    expect(JSON.parse(raw.raw_json).test).toBe(1);
    // Місячна сума за категорією тестову покупку не рахує.
    expect(outboxTexts(db)[0]!.text).not.toContain('Техніка за місяць');
  });
});

/** Запит із чужим секретом у шляху - для тесту бар'єра. */
function env2req(_env: Env, secret: string) {
  return webhookRequest(statementBody(item()), secret);
}
