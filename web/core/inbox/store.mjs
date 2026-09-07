// Вхідні Business-повідомлення (07 §1 `inbox_messages`, 01 §3.5, S-2-2, S-2-9).
//
// ⚠️ Це НЕДОВІРЕНИЙ вміст: його пишуть інші люди. Тому три правила без
// винятків:
//   1. на вході НЕМАЄ моделі - повідомлення просто лягає в D1 (жодного
//      прогону, жодного інструмента, жодної реакції бота);
//   2. рядок завжди `tainted = 1` - коли власник ПОПРОСИТЬ пошук, `inbox.search`
//      віддасть його як зовнішній вміст і підніме taint сесії;
//   3. добова стеля 5 000: чужий чат не має права заповнити базу власника, і
//      перевищення видно алертом, а не тишею.
//
// Ретенція - 30 діб (`retention-cleanup`, PR-4); дайджести лишаються назавжди.

import { kyivDateKey } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';

/** Добова стеля повідомлень (S-2-2). */
export const DAILY_CAP = 5000;
/** Лічильник доби у KV: {date, n, alerted}. */
export const INBOX_COUNT_KEY = 'inboxDayCount';
/** Стеля тексту одного повідомлення в базі. */
export const TEXT_MAX = 4000;
/** Ретенція вхідних (07 §1). */
export const RETENTION_DAYS = 30;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - вхідні недоступні');
  return env.DB;
}

/** id рядка - `chat_id:msg_id` (07 §1): дедуп повторної доставки апдейту.
 *  @param {string | number} chatId @param {string | number} messageId */
export function inboxId(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

/**
 * @typedef {{ chatId: string | number, chatTitle: string, fromId: string | number | null,
 *   fromName: string, messageId: string | number, dateS: number | null, text: string,
 *   mediaKind: string | null, replyTo: string | number | null }} InboxInput
 */

/**
 * Записати повідомлення. Повертає, чи додано (повтор і перевищення стелі -
 * false). `edited: true` - правка вже наявного рядка.
 * @param {Env} env @param {InboxInput & { edited?: boolean }} msg @param {number} nowMs
 */
export async function saveInboxMessage(env, msg, nowMs) {
  const id = inboxId(msg.chatId, msg.messageId);
  const at = new Date(msg.dateS ? msg.dateS * 1000 : nowMs).toISOString();
  const text = String(msg.text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_MAX);

  if (msg.edited) {
    const { meta } = await db(env)
      .prepare('UPDATE inbox_messages SET text = ? WHERE id = ?')
      .bind(text, id)
      .run();
    if (meta?.changes) await reindex(env, id, text);
    return { saved: false, edited: Boolean(meta?.changes) };
  }

  // Стеля рахується ДО запису: інакше «ліміт» означав би «пишемо все, потім
  // жаліємось».
  const room = await takeDailyRoom(env, nowMs);
  if (!room) return { saved: false, capped: true };

  const { meta } = await db(env)
    .prepare(
      `INSERT INTO inbox_messages
         (id, chat_id, chat_title, from_name, from_id, at, text, media_kind, reply_to, tainted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      id,
      String(msg.chatId),
      String(msg.chatTitle ?? '').slice(0, 120),
      String(msg.fromName ?? '').slice(0, 120),
      msg.fromId == null ? null : String(msg.fromId),
      at,
      text,
      msg.mediaKind,
      msg.replyTo == null ? null : String(msg.replyTo),
    )
    .run();
  if (!meta?.changes) return { saved: false, duplicate: true };
  if (text) await reindex(env, id, text);
  return { saved: true, id };
}

/** FTS standalone: синхронізацію веде код (ADR-036). @param {Env} env @param {string} id @param {string} text */
async function reindex(env, id, text) {
  await db(env).batch([
    db(env).prepare('DELETE FROM inbox_fts WHERE id = ?').bind(id),
    db(env).prepare('INSERT INTO inbox_fts (id, text) VALUES (?, ?)').bind(id, text),
  ]);
}

/**
 * Взяти одиницю добової стелі. Перевищення - алерт РАЗ на добу і далі тиша в
 * логах: сенс стелі в тому, щоб не заповнити базу, а не в тому, щоб замінити
 * потік повідомлень потоком алертів.
 * @param {Env} env @param {number} nowMs
 */
async function takeDailyRoom(env, nowMs) {
  const today = kyivDateKey(new Date(nowMs));
  /** @type {any} */
  let state;
  try {
    state = JSON.parse((await env.BRIEFING.get(INBOX_COUNT_KEY)) ?? 'null');
  } catch {
    // Битий лічильник - починаємо добу з нуля, а не глушимо запис.
    state = null;
  }
  const n = state?.date === today ? Number(state.n) || 0 : 0;
  const alerted = state?.date === today ? state.alerted === true : false;
  if (n >= DAILY_CAP) {
    if (!alerted) {
      console.error(`inbox: добова стеля ${DAILY_CAP} вичерпана - нові повідомлення не пишу`);
      await env.BRIEFING.put(INBOX_COUNT_KEY, JSON.stringify({ date: today, n, alerted: true }));
      await sendSystemAlert(
        env,
        `⚠️ Вхідних із чатів за добу більше ${DAILY_CAP} - решту сьогодні не зберігаю.`,
        nowMs,
      );
    }
    return false;
  }
  await env.BRIEFING.put(INBOX_COUNT_KEY, JSON.stringify({ date: today, n: n + 1, alerted }));
  return true;
}

/**
 * Видалити повідомлення, стерті у самому Telegram (S-2-9 сусідить із
 * ретенцією, але це інше: людина стерла зараз, і в нас воно теж не має
 * лишатись).
 * @param {Env} env @param {string | number} chatId @param {(string | number)[]} messageIds
 */
export async function deleteInboxMessages(env, chatId, messageIds) {
  const ids = (messageIds ?? []).map((m) => inboxId(chatId, m));
  if (!ids.length) return { deleted: 0 };
  const marks = ids.map(() => '?').join(', ');
  const { meta } = await db(env)
    .prepare(`DELETE FROM inbox_messages WHERE id IN (${marks})`)
    .bind(...ids)
    .run();
  await db(env)
    .prepare(`DELETE FROM inbox_fts WHERE id IN (${marks})`)
    .bind(...ids)
    .run();
  return { deleted: Number(meta?.changes ?? 0) };
}

/**
 * Стерти чат цілком (S-2-8, T2 `forget`): повідомлення, індекс і дайджести,
 * у яких він згаданий.
 * @param {Env} env @param {string} chat - назва чату або його id
 */
export async function forgetChat(env, chat) {
  const needle = String(chat ?? '').trim();
  if (!needle) throw new Error('forget: не сказано, який чат стерти');
  const chats = await resolveChats(env, needle);
  if (!chats.length) throw new Error(`forget: чату «${needle}» у вхідних немає`);
  let messages = 0;
  for (const chatId of chats) {
    const ids = /** @type {{ id: string }[]} */ (
      (await db(env).prepare('SELECT id FROM inbox_messages WHERE chat_id = ?').bind(chatId).all())
        .results ?? []
    );
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).map((r) => String(r.id));
      const marks = chunk.map(() => '?').join(', ');
      await db(env)
        .prepare(`DELETE FROM inbox_fts WHERE id IN (${marks})`)
        .bind(...chunk)
        .run();
    }
    const { meta } = await db(env)
      .prepare('DELETE FROM inbox_messages WHERE chat_id = ?')
      .bind(chatId)
      .run();
    messages += Number(meta?.changes ?? 0);
  }
  // Дайджести, що згадують лише ці чати, теж зникають: інакше «стерто» було б
  // неправдою - переказ розмови лишився б у базі.
  const digests = await deleteDigestsFor(env, chats);
  return { messages, digests, chats: chats.length };
}

/** Чати за назвою (без регістру) або за id. @param {Env} env @param {string} needle */
export async function resolveChats(env, needle) {
  const { results } = await db(env)
    .prepare('SELECT DISTINCT chat_id, chat_title FROM inbox_messages LIMIT 500')
    .bind()
    .all();
  const low = needle.toLowerCase();
  const hits = (results ?? []).filter(
    (r) =>
      String(r.chat_id) === needle ||
      String(r.chat_title ?? '')
        .toLowerCase()
        .includes(low),
  );
  return hits.map((r) => String(r.chat_id));
}

/** @param {Env} env @param {string[]} chatIds */
async function deleteDigestsFor(env, chatIds) {
  const { results } = await db(env)
    .prepare('SELECT id, chat_ids_json FROM inbox_digests LIMIT 500')
    .bind()
    .all();
  /** @type {string[]} */
  const doomed = [];
  for (const row of results ?? []) {
    /** @type {string[]} */
    let ids;
    try {
      ids = JSON.parse(String(row.chat_ids_json ?? '[]'));
    } catch {
      ids = [];
    }
    if (ids.length && ids.every((id) => chatIds.includes(String(id)))) doomed.push(String(row.id));
  }
  for (const id of doomed) {
    await db(env).prepare('DELETE FROM inbox_digests WHERE id = ?').bind(id).run();
  }
  return doomed.length;
}
