// Повідомлення про незвичну покупку (S-4-2, S-4-4). Будує ЯДРО детерміновано:
// модель у цьому шляху не бере участі взагалі - ані в класифікації, ані в
// формулюванні. Фінансист вмикається лише тоді, коли власник ПИТАЄ («чому це
// незвичне?») - і пояснює вже пораховані прапорці (ADR-029).
//
// Тиша — штатний результат. Новий продавець і велика сума залишаються
// аналітичними ознаками, а не причиною переривати власника. Наразі повідомляємо
// лише про можливий дубль. Планові платежі веде спільний облік Mini App.
//
// Назва мерчанта - ЗОВНІШНІЙ текст (його пише мерчант у полі description):
// через cleanSource, без розмітки й посилань, щоб чужий рядок не став ані
// кнопкою, ані лінком у чаті власника.

import { cleanSource, formatMoney } from '../format.mjs';
import { monthStartMs } from './query.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import { FLAG_LABELS, isLoud } from './rules.mjs';
import { categoryMonthTotal } from './store.mjs';
import { financeMiniAppButton } from './links.mjs';

/** Префікс кнопок фінансів у просторі `m:` (07 §9). */
export const FX_CB = 'm:fx:';
/** Стеля id транзакції в callback_data (Mono: base64-подібний рядок). */
export const TX_ID_RE = /^[A-Za-z0-9_=-]{1,44}$/;

/**
 * Кнопки під повідомленням. Дубль питає інше, ніж звичайна незвична покупка,
 * тож і кнопки в нього свої.
 * @param {string} txId @param {boolean} duplicate @param {Env} [env] @param {string|number|null} [chatId]
 */
export function transactionButtons(txId, duplicate, env, chatId = null) {
  if (!TX_ID_RE.test(txId)) return [];
  const open = env && financeMiniAppButton(env, 'Відкрити операцію', 'transaction', txId, chatId);
  if (duplicate) {
    return [
      ...(open ? [[open]] : []),
      [
        { text: 'Перевірю списання', callback_data: `${FX_CB}${txId}:review` },
        { text: 'Це різні покупки', callback_data: `${FX_CB}${txId}:different` },
      ],
    ];
  }
  return open ? [[open]] : [];
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
    return `💳 Два списання по ${money} у «${merchant}»${apart}.\nЦе можуть бути різні покупки. Перевір, чи обидва списання очікувані.`;
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
  const home = assistantHomeTarget(env);
  if (!home) {
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
  const buttons = transactionButtons(tx.id, duplicate, env, home.chatId);
  const minutesApart = tx.duplicateMinutes ?? null;
  await enqueueOutbox(
    env,
    {
      chatId: home.chatId,
      threadId: home.threadId,
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
