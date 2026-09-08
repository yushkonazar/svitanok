// Повідомлення про незвичну покупку (S-4-2, S-4-4). Будує ЯДРО детерміновано:
// модель у цьому шляху не бере участі взагалі - ані в класифікації, ані в
// формулюванні. Фінансист вмикається лише тоді, коли власник ПИТАЄ («чому це
// незвичне?») - і пояснює вже пораховані прапорці (ADR-029).
//
// Тиша - штатний результат: без гучних прапорців (new_merchant, over_threshold,
// duplicate) транзакція просто лягає в базу (S-4-1). `foreign` і `subscription`
// самі собою не будять власника: перший лише пояснює курс, про другий нагадує
// задача `subscription-remind` за два дні до списання.
//
// Назва мерчанта - ЗОВНІШНІЙ текст (його пише мерчант у полі description):
// через cleanSource, без розмітки й посилань, щоб чужий рядок не став ані
// кнопкою, ані лінком у чаті власника.

import { cleanSource, formatMoney } from '../format.mjs';
import { monthStartMs } from './query.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { FLAG_LABELS, isLoud } from './rules.mjs';
import { categoryMonthTotal } from './store.mjs';

/** Префікс кнопок фінансів у просторі `m:` (07 §9). */
export const FX_CB = 'm:fx:';
/** Стеля id транзакції в callback_data (Mono: base64-подібний рядок). */
export const TX_ID_RE = /^[A-Za-z0-9_=-]{1,44}$/;

/**
 * Кнопки під повідомленням. Дубль питає інше, ніж звичайна незвична покупка,
 * тож і кнопки в нього свої.
 * @param {string} txId @param {boolean} duplicate
 */
export function transactionButtons(txId, duplicate) {
  if (!TX_ID_RE.test(txId)) return [];
  if (duplicate) {
    return [
      [
        { text: 'Так, перевірю', callback_data: `${FX_CB}${txId}:dupy` },
        { text: 'Ні', callback_data: `${FX_CB}${txId}:ok` },
      ],
    ];
  }
  return [
    [
      { text: '🔎 Перевірити ціни', callback_data: `${FX_CB}${txId}:price` },
      { text: 'Ок', callback_data: `${FX_CB}${txId}:ok` },
    ],
    // «Це поїздка?» (PR-6 §2.2): великий чек у транспорті чи готелі - типовий
    // початок поїздки, і питати про це варто там, де воно видно, а не потім.
    [
      { text: '✏️ Категорія', callback_data: `${FX_CB}${txId}:cat` },
      { text: '🧳 Це поїздка', callback_data: `${FX_CB}${txId}:trip` },
    ],
  ];
}

/**
 * Текст повідомлення. Чисто: жодного D1 - місячна сума приходить аргументом,
 * тож таблиця «прапорці → рядок» перевіряється вичерпно.
 * @param {import('./store.mjs').StoredTx} tx
 * @param {{ monthTotal?: number | null, minutesApart?: number | null }} [extra]
 */
export function transactionText(tx, extra = {}) {
  const merchant = cleanSource(tx.merchant, 40) || 'без назви';
  // Списання в Mono відʼємні, але власнику пишемо суму покупки, не дельту
  // балансу: «💳 1 340 грн», а не «−1 340 грн» - мінус перед сумою покупки
  // читається як повернення коштів.
  const uah = tx.amount_uah == null ? null : formatMoney(Math.abs(tx.amount_uah), 'UAH');
  const own = formatMoney(Math.abs(tx.amount), tx.currency);
  // Валюта операції не гривня - показуємо обидві: «12,99 $ (537 грн)».
  const money = uah && tx.currency !== 'UAH' ? `${own} (${uah})` : (uah ?? own);

  if (tx.flags.includes('duplicate')) {
    const apart =
      extra.minutesApart != null && extra.minutesApart > 0
        ? ` за ${extra.minutesApart} хв`
        : ' поспіль';
    return `💳 Два списання по ${money} у «${merchant}»${apart} - дубль?`;
  }

  const named = tx.flags
    .filter((f) => f !== 'subscription')
    .map((f) => FLAG_LABELS[f])
    .filter(Boolean);
  const why = named.length ? ` · ${named.join(', ')}` : '';
  const total =
    extra.monthTotal != null && extra.monthTotal > 0
      ? ` ${capitalize(tx.category)} за місяць: ${formatMoney(extra.monthTotal, 'UAH')}.`
      : '';
  return `💳 ${money} · «${merchant}»${why}.${total}`;
}

/**
 * Сказати власнику про транзакцію, якщо є про що. Повертає, чи писали.
 * @param {Env} env @param {import('./store.mjs').StoredTx} tx @param {number} nowMs
 */
export async function announceTransaction(env, tx, nowMs) {
  if (!isLoud(tx.flags)) return false;
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('mono: TELEGRAM_CHAT_ID немає - нікуди слати незвичну покупку');
    return false;
  }
  const duplicate = tx.flags.includes('duplicate');
  /** @type {number | null} */
  let monthTotal = null;
  if (!duplicate) {
    // Той самий розрахунок, що у finance.query: інакше «Техніка за місяць»
    // під покупкою і відповідь на «скільки на техніку цього місяця» давали б
    // різні числа для покупок першої ночі місяця.
    const monthStart = new Date(monthStartMs(nowMs)).toISOString();
    monthTotal = await categoryMonthTotal(env, tx.category, monthStart, tx.at).catch(
      (/** @type {any} */ e) => {
        // Сума за місяць - приємне доповнення, а не сама новина: без неї
        // повідомлення все одно має сенс.
        console.error('mono: сума за місяць не порахована', e?.message);
        return null;
      },
    );
  }
  const buttons = transactionButtons(tx.id, duplicate);
  const minutesApart = tx.duplicateMinutes ?? null;
  await enqueueOutbox(
    env,
    {
      chatId: env.TELEGRAM_CHAT_ID,
      threadId: env.TOPIC_ASSISTANT ?? null,
      kind: 'send',
      payload: {
        text: transactionText(tx, { monthTotal, minutesApart }),
        ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      },
    },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
    console.error('mono: драйн outbox впав, добере sweeper', e?.message),
  );
  return true;
}

/** @param {string} s */
function capitalize(s) {
  return s ? `${s.slice(0, 1).toUpperCase()}${s.slice(1)}` : s;
}
