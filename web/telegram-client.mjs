// Клієнт Telegram Bot API (Фаза 5, модуляризація worker.js, план A2 §5).
//
// ЩО ТУТ: єдиний виклик API (`tgCall`), закріплена за чатом/темою відправка
// (`sendTo`) і трекінг message_id для `/clear`.
//
// ІНВАРІАНТ ВІДПРАВКИ: **збій Telegram не валить обробку апдейту**. `tgCall`
// логує не-2xx і повертає Response як є — рішення, що з ним робити, лишається
// викликачеві. Причина: більшість наших повідомлень — це реакція на дію
// власника, і краще виконати дію та не показати підтвердження, ніж кинути
// виняток посеред мутації стану.
//
// ІНВАРІАНТ ТРЕКІНГУ: у ring-buffer `sentMessages` (§C5, /clear) потрапляють і
// репліки бота, і вхідні повідомлення власника — тому обидва писарі йдуть
// через atomic `recordTrackedMessage`, а не пишуть KV напряму. Збій трекінгу
// теж нікого не валить: не вдалось запамʼятати id — просто /clear його не зачепить.

import { recordTrackedMessage } from './kv-store.mjs';

/** @typedef {import('./tg-core.mjs').SendTarget} SendTarget */

/** Тонкий клієнт Telegram Bot API (порт src/core/telegram.ts:call — Worker не імпортує TS).
 *  @param {Env} env
 *  @param {string} method
 *  @param {unknown} body */
export async function tgCall(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Telegram ${method} HTTP ${res.status}`, await res.text().catch(() => ''));
  }
  return res;
}

/**
 * Спільна логіка трекінгу для /clear (§C5): якщо sendMessage вдався, записати
 * message_id у ring buffer. Викликається і з sendTo() (webhook-контекст), і з
 * checkReminders() (cron-контекст, немає вхідного parsed) — тому приймає
 * chatId/threadId явно, а не через parsed. res.clone() перед .json(), щоб не
 * спожити тіло Response для можливих майбутніх консюмерів повернутого значення.
 * @param {Env} env
 * @param {Response} res
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 */
export async function trackSentMessage(env, res, chatId, threadId) {
  if (!res.ok) return;
  try {
    const json = /** @type {any} */ (await res.clone().json());
    const messageId = json?.result?.message_id;
    if (typeof messageId === 'number') {
      await recordTrackedMessage(env, chatId, threadId, messageId);
    }
  } catch (e) {
    console.error('sentMessages tracking failed (не блокує відповідь)', e);
  }
}

/** G1: записати message_id ВХІДНОГО повідомлення власника в той самий ring-buffer
 *  sentMessages, щоб /clear видаляв і його репліки, не лише відповіді бота (у
 *  супергрупі бот-адмін із can_delete_messages може; у DM Telegram не дає
 *  видаляти повідомлення користувача — тоді deleteMessage просто відмовить,
 *  оброблено як звичайну відмову). Merge-before-flush, як trackSentMessage.
 *  @param {Env} env
 *  @param {SendTarget} parsed */
export async function trackIncomingMessage(env, parsed) {
  if (typeof parsed.messageId !== 'number') return;
  try {
    await recordTrackedMessage(env, parsed.chatId, parsed.threadId, parsed.messageId, true);
  } catch (e) {
    console.error('incoming message tracking failed (не блокує обробку)', e);
  }
}

/** sendMessage-closure з chat_id/thread_id вже зашитими (спільна для 4 хендлерів нижче).
 *  @param {Env} env
 *  @param {SendTarget} parsed */
export function sendTo(env, parsed) {
  return async (/** @type {string} */ text, /** @type {KvBlob|undefined} */ extra = undefined) => {
    const res = await tgCall(env, 'sendMessage', {
      chat_id: parsed.chatId,
      message_thread_id: parsed.threadId ?? undefined,
      text,
      ...extra,
    });
    await trackSentMessage(env, res, parsed.chatId, parsed.threadId);
    return res;
  };
}
