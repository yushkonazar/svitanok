// Доставка нагадувань із D1 (етап 2 PR-7). Дзеркалить чинний checkReminders
// (web/cron.mjs) з трьома відмінностями, і кожна свідома:
//
//  1. Джерело - D1, не KV: нагадування нового шляху живуть там (PR-6).
//  2. Відправка через outbox, а не прямим tgCall: порядок і 429 - як у решти
//     нового шляху (01 §2.1 «усі відправки через outbox»).
//  3. Claim перед відправкою: два тіки планувальника не мають слати те саме
//     двічі, і UPDATE…WHERE status IN (pending, snoozed) це вирішує атомарно.
//
// Тихі години поводяться як у кроні: у вікні НЕ шлемо і статус НЕ рухаємо,
// тож прострочене піде першим тіком після вікна - нічого не губиться.

import { loadSettings } from '../../kv-store.mjs';
import { isQuietMinute } from '../../settings-core.mjs';
import { kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { formatReminderFired, buildSnoozeRow } from '../../reminders-core.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { dueReminders, claimReminderSent, releaseSentClaim } from './store.mjs';

/**
 * Надіслати те, що вже мало спрацювати. Повертає скільки відправлено -
 * телеметрія задачі, не побічний ефект.
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function deliverDueReminders(env, nowMs = Date.now()) {
  if (!env.DB || !env.TELEGRAM_CHAT_ID) return { sent: 0 };

  const settings = await loadSettings(env);
  if (isQuietMinute(settings, kyivMinuteOfDay(new Date(nowMs)))) return { sent: 0, quiet: true };

  const due = await dueReminders(env, nowMs);
  if (due.length === 0) return { sent: 0 };

  let sent = 0;
  for (const r of due) {
    // Claim ПЕРЕД відправкою: якщо ізолят помре між claim і enqueue, втратимо
    // одне нагадування - гірше було б надіслати те саме двічі (власник не
    // може відрізнити повтор від нового).
    if (!(await claimReminderSent(env, r.id))) continue;

    // Адреса створення (B12); без неї - фолбек, як у кроні.
    const chatId = r.chatId ?? env.TELEGRAM_CHAT_ID;
    const threadId = r.chatId != null ? r.threadId : (env.TOPIC_ASSISTANT ?? null);
    try {
      await enqueueOutbox(
        env,
        {
          chatId,
          threadId,
          kind: 'send',
          payload: {
            text: formatReminderFired(r.text),
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [buildSnoozeRow(r.id)] },
          },
        },
        nowMs,
      );
      sent += 1;
    } catch (/** @type {any} */ e) {
      // Claim уже стоїть, а в чергу не лягло. Лог тут недостатній: власник
      // логів не читає, а нагадування зникло б назавжди. Знімаємо claim -
      // наступний тік спробує ще раз (ревʼю PR-7).
      console.error(`reminders: ${r.id} не покладено в чергу після claim`, e?.message);
      await releaseSentClaim(env, r.id).catch((/** @type {any} */ e2) =>
        console.error(`reminders: claim ${r.id} не знято - нагадування втрачено`, e2?.message),
      );
    }
  }

  if (sent > 0) {
    await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
      console.error('reminders: драйн черги впав (sweeper добере)', e?.message),
    );
  }
  return { sent };
}
