// Сховище фінансів (07 §1 `transactions`, `merchant_rules`, `subscriptions`):
// прийом однієї транзакції Mono з дедупом за id, довідки для правил
// «незвичного» і список рахунків власника у `facts.setting.mono_accounts`.
//
// Мапа полів Mono → наші колонки (ADR-029 «валюти в оригіналі + UAH за
// курсом Mono»):
//   amount       ← operationAmount  (сума у валюті ОПЕРАЦІЇ, мінімальні одиниці)
//   currency     ← currencyCode     (валюта операції, alpha-3)
//   amount_uah   ← amount           (сума у валюті РАХУНКУ; заповнюється лише
//                                    коли рахунок гривневий - інакше це не UAH)
//   balance      ← balance          (залишок рахунку після операції)
// Курс операції власнику рахує Фінансист як amount_uah / amount - жодного
// курсу з памʼяті моделі.

import { runFactsGet, runFactsSet } from '../tools/facts.mjs';
import {
  DUPLICATE_WINDOW_MS,
  HISTORY_MONTHS,
  THRESHOLD_DEFAULT,
  categoryOf,
  computeFlags,
  looksPeriodic,
  matchRule,
  merchantKey,
  normalizeMerchant,
} from './rules.mjs';
import { stepDaysOf, upsertSubscription } from './subscriptions.mjs';

/** Ключ факту зі списком рахунків Mono (id + валюта + маска). */
export const ACCOUNTS_FACT_KEY = 'mono_accounts';
/** Ключ факту з порогом «велика покупка» в копійках. */
export const THRESHOLD_FACT_KEY = 'finance_threshold';
/** Скільки попередніх операцій мерчанта дивимось на періодичність. */
const PERIODIC_LOOKBACK = 6;
/** Скільки правил власника читаємо (їх одиниці; стеля - від здичавілої бази). */
const RULES_MAX = 200;
/** Скільки РІЗНИХ мерчантів переглядаємо на «новий мерчант» за 24 міс. */
const MERCHANTS_MAX = 2000;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - фінанси недоступні');
  return env.DB;
}

/**
 * @typedef {{ id: string, currency: string, maskedPan: string | null }} StoredAccount
 */

/**
 * Рахунки власника з `facts.setting.mono_accounts`. Порожній список означає
 * «ще не питали client-info», і це НЕ те саме, що «рахунків немає»: вебхук на
 * такому стані відмовляє гучно, а `mono-reconcile` заповнює список сам.
 * @param {Env} env @returns {Promise<StoredAccount[]>}
 */
export async function readMonoAccounts(env) {
  const { result } = await runFactsGet(env, { kind: 'setting', key: ACCOUNTS_FACT_KEY });
  const value = /** @type {any} */ (result)?.[0]?.value;
  if (!Array.isArray(value)) return [];
  return value
    .filter((a) => a && typeof a.id === 'string' && a.id)
    .map((a) => ({
      id: String(a.id),
      currency: String(a.currency ?? 'UAH'),
      maskedPan: a.maskedPan ? String(a.maskedPan) : null,
    }));
}

/**
 * @param {Env} env @param {StoredAccount[]} accounts @param {number} nowMs
 */
export async function writeMonoAccounts(env, accounts, nowMs) {
  await runFactsSet(
    env,
    { kind: 'setting', key: ACCOUNTS_FACT_KEY, value: accounts, source: 'owner' },
    nowMs,
  );
}

/** Поріг «велика покупка» власника (копійки); немає факту - типовий. @param {Env} env */
export async function readThreshold(env) {
  const { result } = await runFactsGet(env, { kind: 'setting', key: THRESHOLD_FACT_KEY });
  const raw = Number(/** @type {any} */ (result)?.[0]?.value);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : THRESHOLD_DEFAULT;
}

/** Правила власника (`merchant_rules`). @param {Env} env */
export async function readMerchantRules(env) {
  const { results } = await db(env)
    .prepare(`SELECT pattern, category, is_subscription FROM merchant_rules LIMIT ${RULES_MAX}`)
    .bind()
    .all();
  return (results ?? []).map((r) => ({
    pattern: String(r.pattern ?? ''),
    category: r.category == null ? null : String(r.category),
    is_subscription: r.is_subscription == null ? null : Number(r.is_subscription),
  }));
}

/**
 * @typedef {{ id: string, at: string, amount: number, currency: string,
 *   amount_uah: number | null, mcc: number, description: string, merchant: string,
 *   category: string, flags: string[], balance: number | null,
 *   duplicateMinutes?: number | null }} StoredTx
 */

/**
 * Прийняти елемент виписки/вебхука. Дедуп за `transactions.id` - Mono шле той
 * самий id і у вебхуці, і у виписці, а вебхук ще й повторює при 5xx.
 *
 * `silent: true` - первинне завантаження історії (S-4-11): рядки лягають у
 * базу, але прапорці не рахуються і повідомлення не будується; інакше перший
 * запуск оголосив би «новим мерчантом» усе за 31 добу.
 *
 * @param {Env} env
 * @param {{ item: import('../adapters/mono.mjs').MonoStatementItem, account: string,
 *   accountCurrency: string, test?: boolean, silent?: boolean }} input
 * @returns {Promise<{ inserted: boolean, updated?: boolean, tx: StoredTx | null }>}
 */
export async function ingestTransaction(env, input) {
  const { item, account, accountCurrency } = input;
  const existing = /** @type {{ id: string, raw_json: string | null } | null} */ (
    await db(env)
      .prepare('SELECT id, raw_json FROM transactions WHERE id = ?')
      .bind(item.id)
      .first()
  );
  if (existing) {
    const updated = await settleHold(env, existing, item, accountCurrency);
    return { inserted: false, updated, tx: null };
  }

  const atIso = new Date(item.timeS * 1000).toISOString();
  const merchant = normalizeMerchant(item.description) || 'без назви';
  const key = merchantKey(item.description);
  const rules = await readMerchantRules(env);
  const category = categoryOf({ mcc: item.mcc, merchant }, rules);
  const amountUah = accountCurrency === 'UAH' ? item.amount : null;

  /** @type {string[]} */
  let flags = [];
  /** @type {number | null} */
  let duplicateMinutes = null;
  if (!input.silent) {
    const [known, dupAt, prevSame, inSubscriptions, threshold] = await Promise.all([
      merchantSeenBefore(env, key, item.timeS * 1000),
      duplicateAt(env, key, item.operationAmount, item.timeS * 1000),
      sameAmountTimes(env, key, item.operationAmount, item.timeS * 1000),
      merchantInSubscriptions(env, key),
      readThreshold(env),
    ]);
    flags = computeFlags({
      amountUah,
      currency: item.currency,
      accountCurrency,
      isSpending: item.amount < 0,
      knownMerchant: known,
      duplicate: dupAt != null,
      inSubscriptions,
      periodic: looksPeriodic(item.timeS * 1000, prevSame),
      ruleSubscription: matchRule(rules, merchant)?.is_subscription === 1,
      threshold,
    });
    if (dupAt != null) duplicateMinutes = Math.round((item.timeS * 1000 - dupAt) / 60_000);
    // S-4-6: облік підписок веде ядро - повторне списання з кроком підписки
    // САМЕ створює рядок, без участі моделі. Збій обліку не має ламати запис
    // транзакції: вона важливіша.
    if (flags.includes('subscription')) {
      const stepDays = stepDaysOf(item.timeS * 1000, prevSame);
      if (stepDays != null) {
        await upsertSubscription(
          env,
          {
            id: item.id,
            at: atIso,
            amount: item.operationAmount,
            currency: item.currency,
            merchant,
          },
          stepDays,
          item.timeS * 1000,
        ).catch((/** @type {any} */ e) =>
          console.error(`mono: підписку за ${item.id} не записано`, e?.message),
        );
      }
    }
  }

  const raw = { ...item, account, ...(input.test ? { test: 1 } : {}) };
  const { meta } = await db(env)
    .prepare(
      `INSERT INTO transactions
         (id, at, amount, currency, amount_uah, mcc, description, category, flags_json, balance, note, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      item.id,
      atIso,
      item.operationAmount,
      item.currency,
      amountUah,
      item.mcc,
      merchant,
      category,
      JSON.stringify(flags),
      item.balance,
      JSON.stringify(raw),
    )
    .run();
  if (!meta?.changes) return { inserted: false, tx: null };
  return {
    inserted: true,
    tx: {
      id: item.id,
      at: atIso,
      amount: item.operationAmount,
      currency: item.currency,
      amount_uah: amountUah,
      mcc: item.mcc,
      description: item.description,
      merchant,
      category,
      flags,
      balance: item.balance,
      duplicateMinutes,
    },
  };
}

/**
 * Холд перетворився на списання: Mono шле ТОЙ САМИЙ id спершу з `hold: true`
 * і попередньою сумою, потім - з остаточною. Дедуп за id інакше назавжди
 * лишив би в базі суму холду, а вона відрізняється (пальне, готелі, чайові).
 * Прапорці не перераховуємо: власнику вже сказали, а «незвичність» від
 * копійок різниці не міняється.
 * @param {Env} env @param {{ id: string, raw_json: string | null }} existing
 * @param {import('../adapters/mono.mjs').MonoStatementItem} item @param {string} accountCurrency
 */
async function settleHold(env, existing, item, accountCurrency) {
  if (item.hold) return false;
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(String(existing.raw_json ?? '{}'));
  } catch {
    raw = {};
  }
  if (raw?.hold !== true) return false;
  const amountUah = accountCurrency === 'UAH' ? item.amount : null;
  const { meta } = await db(env)
    .prepare(
      `UPDATE transactions SET amount = ?, amount_uah = ?, balance = ?,
         raw_json = json_patch(COALESCE(raw_json, '{}'), ?)
       WHERE id = ?`,
    )
    .bind(
      item.operationAmount,
      amountUah,
      item.balance,
      JSON.stringify({
        hold: false,
        amount: item.amount,
        operationAmount: item.operationAmount,
        balance: item.balance,
      }),
      item.id,
    )
    .run();
  return Boolean(meta?.changes);
}

/**
 * Мерчант траплявся раніше (за HISTORY_MONTHS до цієї операції)? Порівняння -
 * за ключем: description зберігається нормалізованим, тож ключ рахується з
 * тієї самої функції на обох кінцях.
 * @param {Env} env @param {string} key @param {number} atMs
 */
export async function merchantSeenBefore(env, key, atMs) {
  if (!key) return true; // без назви «новим мерчантом» не оголошуємо
  const fromIso = new Date(atMs - HISTORY_MONTHS * 30 * 86_400_000).toISOString();
  const toIso = new Date(atMs).toISOString();
  // DISTINCT, а не перші N рядків: ключ рахується в JS (нормалізація складніша
  // за LIKE), і «останні 1000 транзакцій» оголосили б новим мерчанта, у якого
  // просто давня остання покупка. Різних мерчантів за 24 міс - сотні, не тисячі.
  const { results } = await db(env)
    .prepare(
      `SELECT DISTINCT description FROM transactions WHERE at >= ? AND at < ? LIMIT ${MERCHANTS_MAX}`,
    )
    .bind(fromIso, toIso)
    .all();
  return (results ?? []).some((r) => merchantKey(r.description) === key);
}

/**
 * Час ПОПЕРЕДНЬОГО списання того самого мерчанта на ту саму суму у вікні
 * DUPLICATE_WINDOW_MS (null - дубля немає). Саме час, а не булеве: власнику
 * кажемо «за 3 хв», і рахувати цей проміжок удруге ніде.
 * @param {Env} env @param {string} key @param {number} amount @param {number} atMs
 * @returns {Promise<number | null>}
 */
export async function duplicateAt(env, key, amount, atMs) {
  if (!key) return null;
  const fromIso = new Date(atMs - DUPLICATE_WINDOW_MS).toISOString();
  const toIso = new Date(atMs).toISOString();
  const { results } = await db(env)
    .prepare(
      `SELECT at, description FROM transactions WHERE at > ? AND at <= ? AND amount = ?
       ORDER BY at DESC LIMIT 50`,
    )
    .bind(fromIso, toIso, amount)
    .all();
  const hit = (results ?? []).find((r) => merchantKey(r.description) === key);
  const ms = hit ? Date.parse(String(hit.at)) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Часи попередніх операцій того самого мерчанта з ТІЄЮ САМОЮ сумою (новіші
 * перші) - основа перевірки «схоже на підписку».
 * @param {Env} env @param {string} key @param {number} amount @param {number} atMs
 * @returns {Promise<number[]>}
 */
export async function sameAmountTimes(env, key, amount, atMs) {
  if (!key) return [];
  const fromIso = new Date(atMs - HISTORY_MONTHS * 30 * 86_400_000).toISOString();
  const toIso = new Date(atMs).toISOString();
  const { results } = await db(env)
    .prepare(
      `SELECT at, description FROM transactions WHERE at >= ? AND at < ? AND amount = ?
       ORDER BY at DESC LIMIT 100`,
    )
    .bind(fromIso, toIso, amount)
    .all();
  return (results ?? [])
    .filter((r) => merchantKey(r.description) === key)
    .slice(0, PERIODIC_LOOKBACK)
    .map((r) => Date.parse(String(r.at)))
    .filter((ms) => Number.isFinite(ms));
}

/** Мерчант уже в обліку підписок (будь-який статус, крім cancelled)?
 *  @param {Env} env @param {string} key */
export async function merchantInSubscriptions(env, key) {
  if (!key) return false;
  const { results } = await db(env)
    .prepare(`SELECT merchant FROM subscriptions WHERE status != 'cancelled' LIMIT 200`)
    .bind()
    .all();
  return (results ?? []).some((r) => merchantKey(r.merchant) === key);
}

/**
 * Умова «це не тестова транзакція» для СУМ і звітів (07 §3: транзакція з
 * `POST /internal/test/mono` позначається `raw_json.test=1` і у звіти не йде).
 * У розрахунок прапорців вона, навпаки, входить - інакше приймальний тест
 * «дубль» не спрацював би.
 */
export const NOT_TEST_SQL = "COALESCE(json_extract(raw_json, '$.test'), 0) != 1";

/**
 * Сума за категорією від початку місяця (для рядка «Техніка за місяць: …»
 * у повідомленні S-4-2). Лише гривневий еквівалент - інакше сума складала б
 * долари з гривнями.
 * @param {Env} env @param {string} category @param {string} monthStartIso @param {string} toIso
 */
export async function categoryMonthTotal(env, category, monthStartIso, toIso) {
  const row = /** @type {{ total: number | null } | null} */ (
    await db(env)
      .prepare(
        `SELECT SUM(-amount_uah) AS total FROM transactions
         WHERE category = ? AND at >= ? AND at <= ? AND amount_uah < 0 AND ${NOT_TEST_SQL}`,
      )
      .bind(category, monthStartIso, toIso)
      .first()
  );
  return Number(row?.total ?? 0);
}

/** Чи є в базі хоч одна транзакція - ознака «первинне завантаження ще не робили».
 *  @param {Env} env */
export async function hasAnyTransaction(env) {
  const row = await db(env).prepare('SELECT id FROM transactions LIMIT 1').bind().first();
  return row != null;
}

/** Одна транзакція за id (для кнопок і finance.query). @param {Env} env @param {string} id */
export async function readTransaction(env, id) {
  return /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT id, at, amount, currency, amount_uah, mcc, description, category, flags_json,
                balance, note FROM transactions WHERE id = ?`,
      )
      .bind(id)
      .first()
  );
}
