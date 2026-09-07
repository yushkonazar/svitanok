// Ранковий дайджест чатів (07 §5 профіль `inbox-digest`, 07 §7, S-2-5).
//
// Вимикач - `facts.setting.inbox_digest` («08:30» або порожньо): без нього
// задача мовчить узагалі. Це не «проактивність за замовчуванням»: читання
// чужих чатів власник вмикає сам.
//
// Тиша - штатний результат: немає нових повідомлень - дайджест не йде
// («нічого важливого» теж не надсилається, S-2-5). Прогін стартує тим самим
// шляхом, що повідомлення власника (черга треду, статусник, ретраї), тільки
// профілем `inbox-digest`: Haiku з єдиним інструментом `inbox.search`.
//
// Профіль має РІВНО один інструмент - `inbox.search`, і жодного запису. Тому
// taint тут не «на всяк випадок»: перший же виклик інструмента позначає тред
// (роутер), і будь-який наступний запис у ньому стане пропозицією з ✅.

import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { runFactsGet } from '../tools/facts.mjs';
import { startOrQueueThreadText, THREAD_DM } from '../prerouter.mjs';
import { readBusinessState } from './connection.mjs';

/** Ключ налаштування-вимикача (07 §5). */
export const DIGEST_SETTING_KEY = 'inbox_digest';
/** Типовий час, якщо у факті лише «on». */
export const DEFAULT_TIME = '08:30';
/** Мітка «сьогодні вже слали». */
export const DIGEST_MARKER_KEY = 'inboxDigestDay';
/** Скільки хвилин після часу ще пробуємо (тік планувальника - 5 хв). */
export const WINDOW_MIN = 30;
/** Текст задачі для профілю: правило дайджесту (07 §5 «persona + правило»). */
export const DIGEST_TASK =
  'Ранковий дайджест чатів. Візьми inbox.search за добу (since «1d»), ' +
  'відбери те, що стосується власника: питання до нього, гроші, дати й домовленості. ' +
  'Не більше 10 рядків, кожен - «Чат · хто: суть». Порожньо - відповідай рівно «нічого важливого».';
/** Відповідь моделі, яка означає «нема про що писати». */
export const NOTHING_RE = /^\s*нічого важливого\s*[.!]?\s*$/i;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - дайджест недоступний');
  return env.DB;
}

/**
 * Час дайджесту з факту: «08:30», «8:30», true/«on» → типовий, порожньо → null.
 * @param {unknown} value @returns {{ hour: number, minute: number } | null}
 */
export function digestTime(value) {
  if (value == null || value === false || value === '' || value === 'off') return null;
  const raw =
    typeof value === 'object' ? String(/** @type {any} */ (value).time ?? '') : String(value);
  const text = raw === 'true' || raw === 'on' || !raw ? DEFAULT_TIME : raw;
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** @param {Env} env */
export async function readDigestSetting(env) {
  const { result } = await runFactsGet(env, { kind: 'setting', key: DIGEST_SETTING_KEY });
  return digestTime(/** @type {any} */ (result)?.[0]?.value);
}

/**
 * Задача `inbox-digest`.
 * @param {Env} env @param {number} [nowMs]
 */
export async function inboxDigestTask(env, nowMs = Date.now()) {
  if (!env.DB) return { skipped: 'no-db' };
  const time = await readDigestSetting(env);
  if (!time) return { skipped: 'off' };
  const now = new Date(nowMs);
  const minuteOfDay = kyivMinuteOfDay(now);
  const target = time.hour * 60 + time.minute;
  if (minuteOfDay < target || minuteOfDay > target + WINDOW_MIN) return { skipped: 'window' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(DIGEST_MARKER_KEY)) === today) return { skipped: 'done' };

  const state = await readBusinessState(env);
  if (!state?.enabled) {
    // Налаштування є, підключення немає - це видима неузгодженість, а не
    // привід мовчати щоранку.
    console.error('inbox-digest: дайджест увімкнено, а Business не підключено');
    await env.BRIEFING.put(DIGEST_MARKER_KEY, today);
    return { skipped: 'not-connected' };
  }
  const since = new Date(nowMs - 86_400_000).toISOString();
  const fresh = await db(env)
    .prepare('SELECT id FROM inbox_messages WHERE at >= ? LIMIT 1')
    .bind(since)
    .first();
  // Мітка ставиться в обох випадках: доба закрита - і коли писали, і коли
  // не було про що.
  await env.BRIEFING.put(DIGEST_MARKER_KEY, today);
  if (!fresh) return { sent: false, reason: 'no-messages' };
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('inbox-digest: TELEGRAM_CHAT_ID немає - нікуди слати');
    return { skipped: 'no-chat' };
  }

  const threadKey = env.TOPIC_ASSISTANT == null ? THREAD_DM : String(env.TOPIC_ASSISTANT);
  const target2 = {
    chatId: Number(env.TELEGRAM_CHAT_ID),
    threadId: env.TOPIC_ASSISTANT == null ? null : Number(env.TOPIC_ASSISTANT),
  };
  const runId = await startOrQueueThreadText(
    env,
    target2,
    threadKey,
    DIGEST_TASK,
    'inbox-digest',
    nowMs,
  );
  return { started: runId != null };
}

/**
 * Зберегти доставлений дайджест (роутер кличе це після deliver прогону
 * профілю `inbox-digest`). «нічого важливого» у базу не пишемо: дайджест -
 * це переказ розмов, а не журнал тиші.
 * @param {Env} env @param {string} text @param {number} nowMs
 */
export async function saveInboxDigest(env, text, nowMs) {
  if (NOTHING_RE.test(text)) return null;
  const to = new Date(nowMs).toISOString();
  const from = new Date(nowMs - 86_400_000).toISOString();
  const { results } = await db(env)
    .prepare('SELECT DISTINCT chat_id FROM inbox_messages WHERE at >= ? LIMIT 100')
    .bind(from)
    .all();
  const chatIds = (results ?? []).map((r) => String(r.chat_id));
  const id = crypto.randomUUID();
  await db(env)
    .prepare(
      `INSERT INTO inbox_digests (id, chat_ids_json, period_from, period_to, text_md, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, JSON.stringify(chatIds), from, to, text, to)
    .run();
  return { id, chats: chatIds.length };
}
