// Інструменти грошей (07 §4): `finance.query` (читання) і `finance.rule` (T0).
// `subscriptions.update` (T0) живе у `finance/subscriptions.mjs` - тут лише
// обгортка контракту.
//
// Вивід зроблено під контракт Фінансиста (docs/assistant/agents/finance.md):
// кожне число має період і базу, «немає даних» - це слово, а не нуль. Тому в
// режимі періоду завжди їде `previous` (та сама тривалість перед вікном) і
// `unconverted` - скільки операцій без гривневого еквівалента.
//
// Опис мерчанта - зовнішній текст: інструмент віддає його НОРМАЛІЗОВАНИМ
// (`transactions.description` зберігається вже нормалізованим), а правило
// «дослівно не копіювати» тримає інструкція працівника.

import { formatMoney } from '../format.mjs';
import { merchantKey, normalizeMerchant } from '../finance/rules.mjs';
import {
  LIST_MAX,
  merchantReference,
  resolvePeriod,
  selectSpending,
  summarize,
} from '../finance/query.mjs';
import { NOT_TEST_SQL, readTransaction } from '../finance/store.mjs';
import { findSubscriptionByMerchant, listSubscriptions } from '../finance/subscriptions.mjs';

/** Скільки рядків історії перекатегоризовуємо за один виклик `finance.rule`. */
export const RECATEGORIZE_MAX = 2000;
/** Розмір батча UPDATE (D1 виконує batch однією транзакцією). */
const BATCH = 100;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - фінанси недоступні');
  return env.DB;
}

/**
 * `finance.query`: або одна транзакція за `id` (+ довідка по мерчанту), або
 * зріз за періодом із порівнянням.
 * @param {Env} env
 * @param {{ id?: string, period?: string, category?: string, merchant?: string, flags?: string[] }} args
 * @param {number} nowMs
 */
export async function runFinanceQuery(env, args, nowMs) {
  if (args.id) return { result: await queryOne(env, String(args.id)) };
  if (!args.period) throw new Error('finance.query: потрібен period або id');
  const period = resolvePeriod(String(args.period), nowMs);
  const filter = {
    category: args.category,
    merchant: args.merchant,
    flags: Array.isArray(args.flags) ? args.flags.slice(0, 5).map(String) : undefined,
  };
  const rows = await selectSpending(env, { from: period.from, to: period.to, ...filter });
  const prevRows = await selectSpending(env, {
    from: period.prevFrom,
    to: period.prevTo,
    ...filter,
  });
  const sum = summarize(rows);
  const prev = summarize(prevRows);
  const truncated = rows.length > LIST_MAX;
  return {
    result: {
      mode: 'period',
      period: { from: period.from, to: period.to, label: period.label },
      ...sum,
      total_text: formatMoney(sum.total_uah, 'UAH'),
      list: rows.slice(0, LIST_MAX).map(compact),
      truncated,
      previous: {
        period: { from: period.prevFrom, to: period.prevTo },
        n: prev.n,
        total_uah: prev.total_uah,
        by_category: prev.by_category,
      },
      subscriptions: await listSubscriptions(env, 20),
    },
  };
}

/** @param {import('../finance/query.mjs').QueryTx} r */
function compact(r) {
  return {
    id: r.id,
    at: r.at,
    amount: r.amount,
    currency: r.currency,
    amount_uah: r.amount_uah,
    merchant: r.merchant,
    category: r.category,
    flags: r.flags,
    ...(r.note ? { note: r.note } : {}),
  };
}

/** @param {Env} env @param {string} id */
async function queryOne(env, id) {
  const row = await readTransaction(env, id);
  if (!row) throw new Error(`finance.query: транзакції ${id} немає`);
  /** @type {string[]} */
  let flags;
  try {
    flags = JSON.parse(String(row.flags_json ?? '[]'));
  } catch {
    flags = [];
  }
  const merchant = String(row.description ?? '');
  const reference = await merchantReference(env, merchant, String(row.at));
  const subscription = await findSubscriptionByMerchant(env, merchantKey(merchant));
  const rule = await findRule(env, merchant);
  return {
    mode: 'id',
    tx: {
      id: String(row.id),
      at: String(row.at),
      amount: Number(row.amount),
      currency: String(row.currency ?? ''),
      amount_uah: row.amount_uah == null ? null : Number(row.amount_uah),
      mcc: Number(row.mcc ?? 0),
      merchant,
      category: String(row.category ?? ''),
      flags,
      note: row.note == null ? null : String(row.note),
    },
    merchant: reference,
    subscription: subscription
      ? {
          id: String(subscription.id),
          period: subscription.period ?? null,
          amount: subscription.amount ?? null,
          currency: subscription.currency ?? null,
          next_at: subscription.next_at ?? null,
          status: String(subscription.status),
        }
      : null,
    rule: rule ? { pattern: rule.pattern, category: rule.category } : null,
  };
}

/** Правило власника, що збіглося з мерчантом. @param {Env} env @param {string} merchant */
async function findRule(env, merchant) {
  const { results } = await db(env)
    .prepare('SELECT id, pattern, category, is_subscription FROM merchant_rules LIMIT 200')
    .bind()
    .all();
  const hay = merchant.toLowerCase();
  const hit = (results ?? []).find((r) =>
    hay.includes(
      String(r.pattern ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
  return hit
    ? {
        id: String(hit.id),
        pattern: String(hit.pattern),
        category: hit.category == null ? null : String(hit.category),
      }
    : null;
}

/**
 * `finance.rule` (T0): правило власника «мерчант → категорія» + перекладання
 * УЖЕ записаної історії. Друге - не бонус, а вимога послідовності: без нього
 * «скільки на каву» рахувалося б за старою категорією до кінця ретенції, і
 * власник бачив би два різні числа на одне питання.
 *
 * `pattern` - підрядок назви мерчанта АБО точна назва наявної категорії
 * (S-4-10 «перейменуй категорію «Рестор.» на «Кафе»»). Регулярок немає
 * свідомо: власний regexp у базі означав би ReDoS на кожній транзакції.
 *
 * @param {Env} env
 * @param {{ pattern: string, category?: string, is_subscription?: boolean }} args
 */
export async function runFinanceRule(env, args) {
  const pattern = normalizeMerchant(args.pattern);
  if (!pattern) throw new Error('finance.rule: потрібен pattern (мерчант або назва категорії)');
  const category = args.category == null ? null : String(args.category).trim().slice(0, 40);
  if (category != null && !category) throw new Error('finance.rule: порожня категорія');
  const isSubscription = args.is_subscription == null ? null : args.is_subscription ? 1 : 0;
  if (category == null && isSubscription == null) {
    throw new Error('finance.rule: потрібна category або is_subscription');
  }

  const existing = /** @type {any} */ (
    await db(env)
      .prepare('SELECT id, category, is_subscription FROM merchant_rules WHERE pattern = ?')
      .bind(pattern)
      .first()
  );
  /** @type {{ pattern: string, category: string | null, is_subscription: number | null } | null} */
  const prev = existing
    ? {
        pattern,
        category: existing.category == null ? null : String(existing.category),
        is_subscription: existing.is_subscription == null ? null : Number(existing.is_subscription),
      }
    : null;
  if (existing) {
    await db(env)
      .prepare('UPDATE merchant_rules SET category = ?, is_subscription = ? WHERE id = ?')
      .bind(
        category ?? existing.category ?? null,
        isSubscription ?? existing.is_subscription ?? null,
        existing.id,
      )
      .run();
  } else {
    await db(env)
      .prepare(
        'INSERT INTO merchant_rules (id, pattern, category, is_subscription, note) VALUES (?, ?, ?, ?, NULL)',
      )
      .bind(crypto.randomUUID(), pattern, category, isSubscription)
      .run();
  }

  const recategorized = category ? await recategorize(env, pattern, category) : 0;
  return {
    result: {
      pattern,
      category,
      is_subscription: isSubscription,
      recategorized,
      created: !existing,
    },
    prev,
  };
}

/** Відкат `finance.rule` для «↩». @param {Env} env @param {any} snapshot @param {string} pattern */
export async function restoreRule(env, snapshot, pattern) {
  if (snapshot) {
    await db(env)
      .prepare('UPDATE merchant_rules SET category = ?, is_subscription = ? WHERE pattern = ?')
      .bind(snapshot.category, snapshot.is_subscription, snapshot.pattern)
      .run();
    return;
  }
  await db(env).prepare('DELETE FROM merchant_rules WHERE pattern = ?').bind(pattern).run();
}

/**
 * Перекласти історію під нову категорію: збіг за НАЗВОЮ КАТЕГОРІЇ (
 * перейменування) або за ключем мерчанта (правило). Порівняння в JS - те саме,
 * що на записі транзакції; SQL `lower()` кирилиці не знає.
 * @param {Env} env @param {string} pattern @param {string} category
 */
async function recategorize(env, pattern, category) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, description, category FROM transactions WHERE ${NOT_TEST_SQL}
       ORDER BY at DESC LIMIT ${RECATEGORIZE_MAX}`,
    )
    .bind()
    .all();
  const catNeedle = pattern.toLowerCase();
  const merNeedle = merchantKey(pattern);
  /** @type {string[]} */
  const ids = [];
  for (const r of results ?? []) {
    const current = String(r.category ?? '');
    if (current === category) continue;
    const byCategory = current.toLowerCase() === catNeedle;
    const byMerchant = merNeedle.length > 0 && merchantKey(r.description).includes(merNeedle);
    if (byCategory || byMerchant) ids.push(String(r.id));
  }
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    await db(env).batch(
      chunk.map((id) =>
        db(env).prepare('UPDATE transactions SET category = ? WHERE id = ?').bind(category, id),
      ),
    );
  }
  return ids.length;
}
