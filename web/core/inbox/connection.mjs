// Підключення Telegram Business (ADR-013, S-2-1, S-2-2, S-2-10, етап 6 PR-3).
//
// Порядок бар'єрів дзеркалить вебхук Mono, і з тієї ж причини - вміст пише
// не власник:
//   1. `business_connection` мусить прийти ВІД власника (у ньому `user` - це
//      він); чужий user_id - ігнор і алерт (S-2-1);
//   2. `business_message` перевіряється НЕ за `from` (там співрозмовник), а за
//      `business_connection_id`: він мусить дорівнювати тому, що власник
//      підключив. Невідомий - відкинути;
//   3. далі - лише запис у D1. Жодного прогону моделі на вході (01 §3.5).
//
// Стан підключення живе у `facts.setting.business`:
// `{ id, enabled, user_id, at }` - і воно ж вимикач для всього шляху.

import { runFactsGet, runFactsSet } from '../tools/facts.mjs';
import { enqueueOutbox, drainOutbox, sendSystemAlert } from '../tg/outbox.mjs';
import { deleteInboxMessages, saveInboxMessage } from './store.mjs';

/** Ключ факту зі станом підключення. */
export const BUSINESS_FACT_KEY = 'business';

/**
 * @typedef {{ id: string, enabled: boolean, user_id: string | null, at: string } | null} BusinessState
 */

/** @param {Env} env @returns {Promise<BusinessState>} */
export async function readBusinessState(env) {
  const { result } = await runFactsGet(env, { kind: 'setting', key: BUSINESS_FACT_KEY });
  const value = /** @type {any} */ (result)?.[0]?.value;
  if (!value || typeof value.id !== 'string' || !value.id) return null;
  return {
    id: String(value.id),
    enabled: value.enabled !== false,
    user_id: value.user_id == null ? null : String(value.user_id),
    at: String(value.at ?? ''),
  };
}

/**
 * S-2-1 / S-2-10: власник підключив або відключив бота в Telegram Business.
 * @param {Env} env
 * @param {import('../../tg-core.mjs').ParsedBusinessConnection} parsed
 * @param {number} nowMs
 */
export async function handleBusinessConnection(env, parsed, nowMs) {
  if (!parsed.connectionId) return { skipped: 'no-id' };
  const ownerId = String(env.TELEGRAM_OWNER_USER_ID ?? '').trim();
  if (ownerId && String(parsed.fromId ?? '') !== ownerId) {
    // S-2-1: підключення від чужого акаунта - не наша справа, і про це варто
    // знати (хтось із доступом до бота підключив його до СВОГО Telegram).
    console.error(`inbox: business_connection від чужого user_id ${String(parsed.fromId)}`);
    await sendSystemAlert(
      env,
      '⚠️ Хтось інший підключив бота до свого Telegram Business - проігнорував.',
      nowMs,
    );
    return { skipped: 'not-owner' };
  }

  await runFactsSet(
    env,
    {
      kind: 'setting',
      key: BUSINESS_FACT_KEY,
      value: {
        id: parsed.connectionId,
        enabled: parsed.isEnabled,
        user_id: parsed.fromId == null ? null : String(parsed.fromId),
        at: new Date(nowMs).toISOString(),
      },
      source: 'owner',
    },
    nowMs,
  );
  const text = parsed.isEnabled
    ? 'Підключено. Бачу нові повідомлення з чатів, які ти дозволив.'
    : 'Відключено від Telegram Business.';
  await say(env, text, nowMs);
  return { enabled: parsed.isEnabled };
}

/**
 * S-2-2: нове (або виправлене) повідомлення з дозволеного чату. Без моделі,
 * без відповіді, лише запис.
 * @param {Env} env
 * @param {import('../../tg-core.mjs').ParsedBusinessMessage} parsed
 * @param {number} nowMs
 */
export async function handleBusinessMessage(env, parsed, nowMs) {
  const state = await readBusinessState(env);
  if (!state || !state.enabled) return { skipped: 'not-connected' };
  if (!parsed.connectionId || parsed.connectionId !== state.id) {
    // Чуже підключення: або стара підписка, або підробка. Мовчазний ігнор із
    // логом - алерт тут дав би зловмиснику ще й спосіб шуміти власнику.
    console.error('inbox: business_message з невідомого підключення - відкинув');
    return { skipped: 'unknown-connection' };
  }
  if (parsed.chatId == null || parsed.messageId == null) return { skipped: 'no-ids' };
  // Порожнє повідомлення без вкладення нічого не додає до пошуку.
  if (!parsed.text && !parsed.mediaKind) return { skipped: 'empty' };
  return saveInboxMessage(
    env,
    {
      chatId: parsed.chatId,
      chatTitle: parsed.chatTitle,
      fromId: parsed.fromId,
      fromName: parsed.fromName,
      messageId: parsed.messageId,
      dateS: parsed.dateS,
      text: parsed.text,
      mediaKind: parsed.mediaKind,
      replyTo: parsed.replyTo,
      edited: parsed.edited,
    },
    nowMs,
  );
}

/**
 * Повідомлення стерли в самому Telegram - стираємо і в себе.
 * @param {Env} env
 * @param {import('../../tg-core.mjs').ParsedBusinessDeleted} parsed
 */
export async function handleBusinessDeleted(env, parsed) {
  const state = await readBusinessState(env);
  if (!state) return { skipped: 'not-connected' };
  if (!parsed.connectionId || parsed.connectionId !== state.id) {
    return { skipped: 'unknown-connection' };
  }
  if (parsed.chatId == null || !parsed.messageIds.length) return { skipped: 'empty' };
  return deleteInboxMessages(env, parsed.chatId, parsed.messageIds);
}

/** @param {Env} env @param {string} text @param {number} nowMs */
async function say(env, text, nowMs) {
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('inbox: TELEGRAM_CHAT_ID немає - нікуди слати підтвердження');
    return;
  }
  await enqueueOutbox(
    env,
    {
      chatId: env.TELEGRAM_CHAT_ID,
      threadId: env.TOPIC_ASSISTANT ?? null,
      kind: 'send',
      payload: { text },
    },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
    console.error('inbox: драйн outbox впав, добере sweeper', e?.message),
  );
}
