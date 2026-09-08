// Правила «незвичного» і нормалізація мерчанта (ADR-029, S-4-1…S-4-6).
//
// ЯДРО рахує прапорці детерміновано - модель у цьому шляху не бере участі
// взагалі: повідомлення про незвичну покупку будується з полів транзакції, а
// Фінансист лише ПОЯСНЮЄ вже пораховане, коли власник питає. Тому весь
// розрахунок тут - чисті функції без D1 і без мережі: таблиця «умова →
// прапорець» перевіряється вичерпно.
//
// Прапорці (07 §1 flags_json, docs/assistant/agents/finance.md «крок 3»):
//   new_merchant   - мерчанта не було за 24 міс
//   over_threshold - понад поріг (типово 1 000 грн) у гривневому еквіваленті
//   duplicate      - той самий мерчант і сума протягом 5 хв
//   foreign        - операція не в гривні
//   subscription   - мерчант в обліку підписок або сума повторюється з
//                    кроком 7 / 28-31 / 365 діб (± 2)

import { categoryByMcc, FALLBACK_CATEGORY } from './mcc.mjs';

/** Поріг «велика покупка» в копійках (S-4-2); власник міняє facts.setting.finance_threshold. */
export const THRESHOLD_DEFAULT = 100_000;
/** Вікно дубля (S-4-4). */
export const DUPLICATE_WINDOW_MS = 5 * 60_000;
/** Глибина історії для «новий мерчант» - та сама, що ретенція транзакцій. */
export const HISTORY_MONTHS = 24;
/**
 * Кроки повтору, що читаються як підписка, у добах (S-4-6). Двотижневого
 * кроку тут свідомо немає: два однакові чеки за 13-15 днів - радше збіг
 * (та сама кава), ніж підписка, а хибний прапорець псує облік.
 */
export const SUBSCRIPTION_STEPS = [7, 30, 91, 182, 365];
/** Допуск до кроку в добах (місяць 28-31 накривається кроком 30 ± 2). */
export const SUBSCRIPTION_TOLERANCE = 2;
/** Стеля назви мерчанта в тексті власнику і в ключі порівняння. */
export const MERCHANT_MAX = 60;

/**
 * Опис транзакції → назва мерчанта для ЛЮДИНИ. Опис пише мерчант, тобто це
 * зовнішній текст: ріжемо довжину, знімаємо префікс агрегатора («IN*», «SP *»,
 * «PAYPAL *») і службові символи, лишаємо літери/цифри/крапку/дефіс.
 * @param {unknown} description
 */
export function normalizeMerchant(description) {
  const raw = String(description ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const noAgg = raw.replace(/^[A-Za-z0-9]{2,8}\s*\*\s*/, '');
  return noAgg
    .replace(/[^\p{L}\p{N} .,'&()/-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MERCHANT_MAX);
}

/**
 * Ключ порівняння мерчантів: без регістру, пробілів і пунктуації. «Сільпо
 * 315» і «СІЛЬПО-315» - той самий мерчант, інакше кожна нова торгова точка
 * була б «новим мерчантом».
 * @param {unknown} description
 */
export function merchantKey(description) {
  return normalizeMerchant(description)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, MERCHANT_MAX);
}

/**
 * Правило власника для мерчанта (`merchant_rules`). `pattern` - ПІДРЯДОК без
 * регістру, не регулярка: власний regexp у базі означав би ReDoS на кожній
 * транзакції. Перше правило, що збіглося (порядок - як прийшли рядки).
 * @template {{ pattern: string, category: string | null, is_subscription: number | null }} R
 * @param {R[]} rules
 * @param {string} merchant - нормалізована назва
 * @returns {R | null}
 */
export function matchRule(rules, merchant) {
  const hay = merchant.toLowerCase();
  for (const rule of rules ?? []) {
    const needle = String(rule?.pattern ?? '')
      .trim()
      .toLowerCase();
    if (needle && hay.includes(needle)) return rule;
  }
  return null;
}

/**
 * Категорія транзакції: правило власника має пріоритет над довідником MCC
 * (ADR-029).
 * @param {{ mcc: number, merchant: string }} tx
 * @param {{ pattern: string, category: string | null, is_subscription: number | null }[]} rules
 */
export function categoryOf(tx, rules) {
  const rule = matchRule(rules, tx.merchant);
  if (rule?.category) return String(rule.category);
  return categoryByMcc(tx.mcc) || FALLBACK_CATEGORY;
}

/**
 * Різниця в добах читається як крок підписки?
 * @param {number} days
 */
export function isSubscriptionStep(days) {
  return SUBSCRIPTION_STEPS.some((step) => Math.abs(days - step) <= SUBSCRIPTION_TOLERANCE);
}

/**
 * Дати попередніх операцій того самого мерчанта з тією самою сумою складають
 * ряд із кроком підписки? Досить ОДНОГО збігу кроку до найближчої попередньої
 * операції: два списання Spotify 19.07 і 19.08 - уже підписка.
 * @param {number} atMs - час поточної операції
 * @param {number[]} prevMs - часи попередніх операцій із тією самою сумою, новіші перші
 */
export function looksPeriodic(atMs, prevMs) {
  for (const prev of prevMs ?? []) {
    const days = (atMs - prev) / 86_400_000;
    if (days > 0 && isSubscriptionStep(days)) return true;
  }
  return false;
}

/**
 * @typedef {{
 *   amountUah: number | null,   // гривневий еквівалент у копійках (модуль)
 *   currency: string,           // валюта операції за Mono (currencyCode)
 *   accountCurrency: string,    // валюта рахунку (типово UAH)
 *   isSpending: boolean,        // списання (Mono: amount < 0)
 *   knownMerchant: boolean,     // мерчант траплявся за HISTORY_MONTHS
 *   duplicate: boolean,         // той самий мерчант і сума за DUPLICATE_WINDOW_MS
 *   inSubscriptions: boolean,   // мерчант є в обліку підписок
 *   periodic: boolean,          // сума повторюється з кроком підписки
 *   ruleSubscription: boolean,  // власник позначив мерчанта підпискою
 *   threshold: number,          // поріг «велика покупка» в копійках
 * }} FlagInput
 */

/**
 * Прапорці транзакції. Порядок стабільний - він видно власнику в тексті.
 * ЗАРАХУВАННЯ прапорців не отримують: «новий мерчант» на зарплаті чи
 * «велика сума» на поверненні - шум, а не сигнал.
 * @param {FlagInput} input
 * @returns {string[]}
 */
export function computeFlags(input) {
  if (!input.isSpending) return [];
  /** @type {string[]} */
  const flags = [];
  if (!input.knownMerchant) flags.push('new_merchant');
  if (input.amountUah != null && Math.abs(input.amountUah) > input.threshold) {
    flags.push('over_threshold');
  }
  if (input.duplicate) flags.push('duplicate');
  // Контракт Фінансиста (agents/finance.md крок 3): «foreign - валюта не
  // UAH». Саме так, а не «валюта операції ≠ валюта рахунку»: купівля доларами
  // з доларового рахунку - теж не гривня, і у звіт вона мусить потрапити.
  // Різницю `amount`/`operationAmount` сюди НЕ додаємо: Mono кладе в неї ще й
  // комісію за зняття, тож гривнева операція діставала б ярлик «у чужій
  // валюті». Чи є `currencyCode` валютою операції - вирішить перша реальна
  // закордонна покупка на прийманні (п. 9 чекліста), а не здогад у коді.
  if (input.currency !== 'UAH') flags.push('foreign');
  if (input.inSubscriptions || input.ruleSubscription || input.periodic) {
    flags.push('subscription');
  }
  return flags;
}

/** Людські назви прапорців для повідомлення власнику (S-4-2). */
export const FLAG_LABELS = /** @type {Record<string, string>} */ ({
  new_merchant: 'новий мерчант',
  over_threshold: 'велика сума',
  duplicate: 'схоже на дубль',
  foreign: 'у чужій валюті',
  subscription: 'підписка',
});

/**
 * Про які прапорці варто написати ВІДРАЗУ. `subscription` сам собою не привід
 * будити власника (про підписку нагадує `subscription-remind` за два дні до
 * списання), `foreign` - теж: закордонна покупка не аномалія, вона лише
 * пояснює курс. Гучні - ті три, що означають «глянь на це».
 */
export const LOUD_FLAGS = ['new_merchant', 'over_threshold', 'duplicate'];

/** @param {string[]} flags */
export function isLoud(flags) {
  return flags.some((f) => LOUD_FLAGS.includes(f));
}
