// `inbox.search` (07 §4, S-2-3, S-2-4): пошук у чужих чатах, збережених через
// Telegram Business.
//
// Інструмент TAINTING: усе, що він віддає, написали інші люди. Тому кожне
// повідомлення йде моделі в `<external source="inbox">`, а роутер після
// виклику піднімає `sessions.tainted` - далі будь-який запис у цьому треді
// стає пропозицією з ✅ (01 §4.2). Це не перестраховка: «знайди в чаті з
// Олею» - типовий шлях, яким чужий текст потрапляє в контекст.
//
// Пошук - FTS5 (`inbox_fts`), коли є `q`; без `q` це перегляд чату за період
// (S-2-4 «найважливіше за сьогодні» - модель ранжує сама).

import { ftsQuery } from './ideas.mjs';
import { wrapExternal } from './markup.mjs';
import { resolveChats } from '../inbox/store.mjs';

/** Скільки повідомлень віддаємо за раз. */
export const INBOX_SEARCH_MAX = 30;
/** Стеля тексту одного повідомлення у виводі (довші - зрізаємо з «…»). */
export const SNIPPET_MAX = 500;
/** Скільки діб дивимось, якщо `since` не задано. */
export const DEFAULT_DAYS = 7;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - вхідні недоступні');
  return env.DB;
}

/**
 * @param {Env} env
 * @param {{ chat?: string, q?: string, since?: string, limit?: number }} args
 * @param {number} nowMs
 */
export async function runInboxSearch(env, args, nowMs) {
  const limit = Math.max(1, Math.min(INBOX_SEARCH_MAX, Number(args.limit) || INBOX_SEARCH_MAX));
  const since = resolveSince(args.since, nowMs);
  /** @type {string[] | null} */
  let chatIds = null;
  if (args.chat) {
    chatIds = await resolveChats(env, String(args.chat));
    // Чесна відмова: «нічого не знайшов» і «такого чату немає» - різні
    // відповіді, і власник має бачити другу.
    if (!chatIds.length) {
      return {
        result: { chats: [], messages: [], note: `Чату «${String(args.chat)}» у вхідних немає.` },
      };
    }
  }

  const where = ['m.at >= ?'];
  /** @type {unknown[]} */
  const binds = [since];
  if (chatIds?.length) {
    where.push(`m.chat_id IN (${chatIds.map(() => '?').join(', ')})`);
    binds.push(...chatIds);
  }

  const match = args.q ? ftsQuery(String(args.q)) : '';
  const sql = match
    ? `SELECT m.id, m.chat_id, m.chat_title, m.from_name, m.at, m.text, m.media_kind
       FROM inbox_fts f JOIN inbox_messages m ON m.id = f.id
       WHERE inbox_fts MATCH ? AND ${where.join(' AND ')}
       ORDER BY m.at DESC LIMIT ${limit}`
    : `SELECT m.id, m.chat_id, m.chat_title, m.from_name, m.at, m.text, m.media_kind
       FROM inbox_messages m
       WHERE ${where.join(' AND ')}
       ORDER BY m.at DESC LIMIT ${limit}`;
  if (args.q && !match) throw new Error('q має містити хоч одне слово');
  const { results } = await db(env)
    .prepare(sql)
    .bind(...(match ? [match, ...binds] : binds))
    .all();

  const rows = results ?? [];
  return {
    result: {
      since,
      chats: [...new Set(rows.map((r) => String(r.chat_title ?? '')))].filter(Boolean),
      messages: rows.map((r) => ({
        id: String(r.id),
        chat: String(r.chat_title ?? ''),
        from: String(r.from_name ?? ''),
        at: String(r.at),
        media: r.media_kind == null ? null : String(r.media_kind),
        // Текст - ЗОВНІШНІЙ: маркер джерела ставиться тут, у ядрі, а не
        // покладається на дисципліну промпта.
        text: wrapExternal('inbox', snippet(String(r.text ?? '')), String(r.id)),
      })),
    },
  };
}

/** @param {string} text */
function snippet(text) {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

/**
 * `since`: ISO-дата, `Nd`, або порожньо (типово тиждень). Невідоме -
 * помилка: тихий дефолт означав би відповідь про інший період.
 * @param {unknown} raw @param {number} nowMs
 */
export function resolveSince(raw, nowMs) {
  const text = String(raw ?? '').trim();
  if (!text) return new Date(nowMs - DEFAULT_DAYS * 86_400_000).toISOString();
  const rel = text.match(/^(\d{1,3})d$/);
  if (rel) return new Date(nowMs - Number(rel[1]) * 86_400_000).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00.000Z`;
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  throw new Error(`inbox.search: since «${text}» не розібрано (очікую YYYY-MM-DD або «7d»)`);
}
