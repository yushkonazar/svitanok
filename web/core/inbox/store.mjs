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
import { inboxQuotaTake } from '../inbox-quota/client.mjs';
import { INBOX_COUNT_KEY } from '../inbox-quota/contract.mjs';

/** Добова стеля повідомлень (S-2-2). */
export const DAILY_CAP = 5000;
/** Лічильник доби у KV: {date, n, alerted}. */
export { INBOX_COUNT_KEY };
/** Стеля тексту одного повідомлення в базі. */
export const TEXT_MAX = 4000;
/** Ретенція вхідних (07 §1). */
export const RETENTION_DAYS = 30;
/** Стеля звʼязаних параметрів на один запит D1 - платформна, не наша. */
export const SQL_PARAMS_MAX = 100;
/** Скільки чатів беремо в один `IN (...)` (половина стелі - решта під інші поля). */
export const CHATS_MAX = 50;
/** Скільки повідомлень в одній пачці імпорту (50 id у SELECT + до 150 тверджень). */
export const BATCH_ROWS = 50;

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
 * `viaImport` - імпорт експорту (InboxExport, PR-4): добова стеля не діє,
 * бо вона захищає від ЧУЖОГО потоку, а імпорт - свідома дія власника.
 * @param {Env} env @param {InboxInput & { edited?: boolean, viaImport?: boolean }} msg
 * @param {number} nowMs
 */
export async function saveInboxMessage(env, msg, nowMs) {
  const id = inboxId(msg.chatId, msg.messageId);
  const at = new Date(msg.dateS ? msg.dateS * 1000 : nowMs).toISOString();
  const text = normalizeText(msg.text);

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
  if (!msg.viaImport && !(await takeDailyRoom(env, nowMs))) {
    return { saved: false, capped: true };
  }

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

/**
 * Пакетна вставка (InboxExport): на Workers Free - 50 ПІДЗАПИТІВ на виклик, а
 * `saveInboxMessage` коштує два (INSERT + реіндекс FTS). Півтисячі повідомлень
 * поштучно не пролізли б у жоден крок Workflow, тож імпорт іде пачками:
 * один SELECT «що вже є» + один `batch` на пачку = два підзапити на 50 рядків.
 *
 * Повертає `inserted` (нових) і `present` (уже були). Друге - не дрібниця:
 * крок Workflow може повторитись, і тоді власнику треба сказати, скільки
 * повідомлень ТЕПЕР у базі, а не скільки з них додав саме цей прогін.
 * @param {Env} env @param {InboxInput[]} msgs @param {number} nowMs
 * @returns {Promise<{ inserted: number, present: number }>}
 */
export async function saveInboxBatch(env, msgs, nowMs) {
  let inserted = 0;
  let present = 0;
  for (let i = 0; i < msgs.length; i += BATCH_ROWS) {
    const chunk = msgs.slice(i, i + BATCH_ROWS);
    const ids = chunk.map((m) => inboxId(m.chatId, m.messageId));
    const marks = ids.map(() => '?').join(', ');
    const { results } = await db(env)
      .prepare(`SELECT id FROM inbox_messages WHERE id IN (${marks})`)
      .bind(...ids)
      .all();
    const known = new Set((results ?? []).map((r) => String(r.id)));
    /** @type {any[]} */
    const statements = [];
    for (const msg of chunk) {
      const id = inboxId(msg.chatId, msg.messageId);
      if (known.has(id)) {
        present += 1;
        continue;
      }
      const text = normalizeText(msg.text);
      statements.push(
        db(env)
          .prepare(
            `INSERT INTO inbox_messages
               (id, chat_id, chat_title, from_name, from_id, at, text, media_kind, reply_to, tainted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          )
          .bind(
            id,
            String(msg.chatId),
            String(msg.chatTitle ?? '').slice(0, 120),
            String(msg.fromName ?? '').slice(0, 120),
            msg.fromId == null ? null : String(msg.fromId),
            new Date(msg.dateS ? msg.dateS * 1000 : nowMs).toISOString(),
            text,
            msg.mediaKind,
            msg.replyTo == null ? null : String(msg.replyTo),
          ),
      );
      if (text) {
        statements.push(db(env).prepare('DELETE FROM inbox_fts WHERE id = ?').bind(id));
        statements.push(
          db(env).prepare('INSERT INTO inbox_fts (id, text) VALUES (?, ?)').bind(id, text),
        );
      }
      inserted += 1;
    }
    if (statements.length) await db(env).batch(statements);
  }
  return { inserted, present };
}

/** Текст повідомлення під капом бази. @param {unknown} raw */
function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_MAX);
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
  let legacyState;
  try {
    legacyState = JSON.parse((await env.BRIEFING.get(INBOX_COUNT_KEY)) ?? 'null');
  } catch {
    // Битий compatibility mirror не має глушити запис; canonical DO, якщо
    // увімкнений, все одно вже має свій власний стан.
    legacyState = null;
  }
  const reservation = await inboxQuotaTake(env, legacyState, today, DAILY_CAP);
  if (reservation.allowed) return true;
  if (reservation.alert) {
    console.error(`inbox: добова стеля ${DAILY_CAP} вичерпана - нові повідомлення не пишу`);
    await sendSystemAlert(
      env,
      `⚠️ Вхідних із чатів за добу більше ${DAILY_CAP} - решту сьогодні не зберігаю.`,
      nowMs,
    );
  }
  return false;
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
  let deleted = 0;
  // Пачками по SQL_PARAMS_MAX: D1 приймає не більше 100 звʼязаних параметрів
  // на запит, а Telegram шле до 100 id за раз (parseUpdate ріже до 200).
  for (let i = 0; i < ids.length; i += SQL_PARAMS_MAX) {
    const chunk = ids.slice(i, i + SQL_PARAMS_MAX);
    const marks = chunk.map(() => '?').join(', ');
    const { meta } = await db(env)
      .prepare(`DELETE FROM inbox_messages WHERE id IN (${marks})`)
      .bind(...chunk)
      .run();
    await db(env)
      .prepare(`DELETE FROM inbox_fts WHERE id IN (${marks})`)
      .bind(...chunk)
      .run();
    deleted += Number(meta?.changes ?? 0);
  }
  return { deleted };
}

/**
 * Стерти чат цілком (S-2-8, T2 `forget`): повідомлення, індекс і дайджести,
 * у яких він згаданий.
 * @param {Env} env @param {string} chat - назва чату або його id
 */
export async function forgetChat(env, chat) {
  const needle = String(chat ?? '').trim();
  if (!needle) throw new Error('forget: не сказано, який чат стерти');
  const { ids: chats } = await resolveChats(env, needle);
  if (!chats.length) throw new Error(`forget: чату «${needle}» у вхідних немає`);
  let messages = 0;
  for (const chatId of chats) {
    const ids = /** @type {{ id: string }[]} */ (
      (await db(env).prepare('SELECT id FROM inbox_messages WHERE chat_id = ?').bind(chatId).all())
        .results ?? []
    );
    for (let i = 0; i < ids.length; i += SQL_PARAMS_MAX) {
      const chunk = ids.slice(i, i + SQL_PARAMS_MAX).map((r) => String(r.id));
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

/**
 * Чати з кількістю повідомлень - для меню `/forget` (S-0-5, S-2-8).
 * @param {Env} env @param {number} [limit]
 */
export async function listInboxChats(env, limit = 10) {
  const { results } = await db(env)
    .prepare(
      `SELECT chat_id, chat_title, COUNT(*) AS n FROM inbox_messages
       GROUP BY chat_id ORDER BY n DESC LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(50, limit)))
    .all();
  return (results ?? []).map((r) => ({
    id: String(r.chat_id),
    title: String(r.chat_title ?? r.chat_id),
    messages: Number(r.n ?? 0),
  }));
}

/**
 * Чати за назвою (без регістру) або за id. Повертає й ЗАГАЛЬНУ кількість
 * збігів - щоб викликач міг сказати, що список урізано.
 * @param {Env} env @param {string} needle
 * @returns {Promise<{ ids: string[], total: number }>}
 */
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
  // Стеля - та сама, платформна: список іде далі в `IN (...)` (inbox.search).
  // Урізання видиме викликачу: мовчазний пошук «по перших 50» гірший за
  // чесний рядок про те, що збігів більше.
  return { ids: hits.map((r) => String(r.chat_id)).slice(0, CHATS_MAX), total: hits.length };
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
