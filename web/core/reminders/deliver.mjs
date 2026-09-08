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
import {
  dueReminders,
  claimReminderSent,
  releaseSentClaim,
  createReminder,
  clearRecurrence,
} from './store.mjs';
import { nextOccurrence } from './recurrence.mjs';

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
      // ⚠️ ПОВТОР ПЛАНУЄМО ПІСЛЯ УСПІШНОЇ ВІДПРАВКИ (§3.1). Порядок саме
      // такий: якщо наступна поява не запишеться, власник уже отримав цю - і
      // ряд обірветься на видимому місці, а не тихо. Зворотний порядок міг би
      // дати дві появи на один тік.
      if (r.rrule) await scheduleNext(env, r, nowMs);
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

/**
 * Наступна поява повторюваного нагадування - окремим рядком.
 *
 * ⚠️ ЧОМУ НОВИЙ РЯДОК, А НЕ ЗСУВ ЦЬОГО. Спрацьоване нагадування лишається в
 * історії зі статусом `sent`; зсунувши час, ми стерли б слід, що воно взагалі
 * приходило. Заразом це робить «скасуй» простим: поки наступний рядок не
 * створено, ряд обривається сам - скасовувати нічого, крім поточного.
 *
 * Правило нечитабельне (ручна правка в базі, майбутній формат) - ряд тихо
 * закінчується, і про це є слід у лозі: повторювати за здогадом гірше.
 * @param {Env} env
 * @param {{ id: string, text: string, dueAt: string, rrule: string | null,
 *   recurCount: number, chatId: unknown, threadId: unknown }} r
 * @param {number} nowMs
 */
async function scheduleNext(env, r, nowMs) {
  try {
    const prevMs = Date.parse(r.dueAt);
    const nextMs = nextAfterNow(r.rrule, Number.isFinite(prevMs) ? prevMs : nowMs, nowMs);
    if (nextMs == null) {
      console.error(`reminders: правило «${r.rrule}» не читається - ряд ${r.id} закінчено`);
      return;
    }
    await createReminder(env, {
      // ⚠️ ДЕТЕРМІНОВАНИЙ id, не випадковий (security-ревʼю). Якщо ту саму
      // строку доставили вдруге (відкладене «+10 хв» повертає її в чергу, а
      // зняття правила не пройшло), спадкоємець вийде з тим самим id - і
      // `ifAbsent` перетворить другу спробу на нуль-дію замість ДРУГОГО ряду.
      id: seriesId(r.id, nextMs),
      text: r.text,
      dueAtMs: nextMs,
      chatId: r.chatId == null ? null : String(r.chatId),
      threadId: r.threadId == null ? null : String(r.threadId),
      rrule: r.rrule,
      recurCount: r.recurCount + 1,
      ifAbsent: true,
    });
    // Естафету передано - ця строка більше не є носієм правила. Порядок саме
    // такий: спадкоємець уже існує, тож навіть якщо зняття не пройде, ряд не
    // урветься (гірший наслідок - зайва поява після відкладення).
    await clearRecurrence(env, r.id);
  } catch (/** @type {any} */ e) {
    // Ряд обірвався - але власник ЦЮ появу вже отримав, тож мовчазна втрата
    // тут не така, як утрата самого нагадування. Слід у лозі обовʼязковий.
    console.error(`reminders: наступну появу ${r.id} не заплановано`, e?.message);
  }
}

/** Скільки появ поспіль дозволено пропустити, наздоганяючи простій. Стеля -
 *  щоб зіпсоване правило («наступна поява дорівнює попередній») не крутило
 *  цикл у воркері з 10 мс CPU. 400 днів покривають будь-який реальний простій. */
const CATCH_UP_MAX = 400;

/**
 * Перша поява СУВОРО після `nowMs`.
 *
 * ⚠️ НАВІЩО (ревʼю). Гола `nextOccurrence` рахує від попередньої появи, тож
 * після простою воркера на три доби щоденний ряд віддав би прострочену появу,
 * її ж доставили б наступним тіком, і власник дістав би три повідомлення
 * поспіль замість одного. Пропущене - пропущене: ряд наздоганяє мовчки.
 * @param {unknown} rrule @param {number} prevMs @param {number} nowMs
 * @returns {number | null} null = правило нечитабельне або не рухається вперед
 */
function nextAfterNow(rrule, prevMs, nowMs) {
  let at = prevMs;
  for (let i = 0; i < CATCH_UP_MAX; i += 1) {
    const next = nextOccurrence(rrule, at);
    if (next == null || !Number.isFinite(next) || next <= at) return null;
    at = next;
    if (at > nowMs) return at;
  }
  return null;
}

/** Детермінований id появи: та сама ланка ряду завжди дає той самий рядок.
 *  FNV-1a - тут не треба криптостійкості, треба стабільність і 8 символів.
 *  @param {string} prevId @param {number} atMs */
function seriesId(prevId, atMs) {
  let h = 0x811c9dc5;
  const src = `${prevId}:${atMs}`;
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
