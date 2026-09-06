// Задача `chain-nudge` (07 §7, S-1-6): «не натиснув кнопку» - нагадати
// через +5 і +20 хв від початку очікування, далі тиша (Workflow лишається
// waiting). Стан нагадувань - у state_json ланцюга (`nudge: {at, n}`): його
// ставить машина станів, коли починає чекати, і стирає, коли дочекалась.
// Кілька ланцюгів на той самий час - одне повідомлення списком (S-1-13).
// Мʼякий рядок «ланцюг чекає» після доби тиші - softWaitingLine (prerouter,
// раз на день, у відповідь на повідомлення власника, не сам по собі).

import { kyivDateKey } from '../../kyiv-time.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { NUDGE_SECOND_MS, NUDGES_MAX } from './table.mjs';

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * Ланцюги столика, чиє нагадування настало.
 * @param {Env} env @param {number} nowMs
 * @returns {Promise<{ id: string, venue: string, n: number, chat_id: string | null, thread_id: string | null }[]>}
 */
export async function dueNudges(env, nowMs) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, json_extract(state_json, '$.venue') AS venue, json_extract(state_json, '$.nudge.n') AS n,
              json_extract(state_json, '$.chat_id') AS chat_id, json_extract(state_json, '$.thread_id') AS thread_id
       FROM chains WHERE kind = 'table' AND status = 'waiting'
         AND json_extract(state_json, '$.nudge.at') IS NOT NULL
         AND json_extract(state_json, '$.nudge.at') <= ? ORDER BY updated_at`,
    )
    .bind(new Date(nowMs).toISOString())
    .all();
  return (results ?? []).map((r) => ({
    id: String(r.id),
    venue: String(r.venue ?? ''),
    n: Number(r.n) || 0,
    chat_id: r.chat_id == null ? null : String(r.chat_id),
    thread_id: r.thread_id == null ? null : String(r.thread_id),
  }));
}

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function chainNudgeTask(env, nowMs = Date.now()) {
  if (!env.DB) return { sent: 0, skipped: 'no-db' };
  const due = await dueNudges(env, nowMs);
  if (due.length === 0) return { sent: 0 };
  // Клейм ДО відправки: наступне нагадування або кінець (n ≥ NUDGES_MAX →
  // nudge стирається, Workflow далі чекає мовчки).
  /** @type {typeof due} */
  const claimed = [];
  for (const c of due) {
    if (await claimNudge(env, c, nowMs)) claimed.push(c);
  }
  if (claimed.length === 0) return { sent: 0 };
  // Одне повідомлення на адресу (чат/тред): ланцюги на той самий час - списком.
  /** @type {Map<string, typeof due>} */
  const byTarget = new Map();
  for (const c of claimed) {
    const chatId = c.chat_id ?? env.TELEGRAM_CHAT_ID ?? null;
    if (chatId == null) continue;
    const threadId = c.thread_id === 'dm' ? null : (c.thread_id ?? env.TOPIC_ASSISTANT ?? null);
    const key = `${chatId}:${threadId ?? ''}`;
    const list = byTarget.get(key) ?? [];
    list.push({
      ...c,
      chat_id: String(chatId),
      thread_id: threadId == null ? null : String(threadId),
    });
    byTarget.set(key, list);
  }
  let sent = 0;
  for (const list of byTarget.values()) {
    const first = list[0];
    if (!first) continue;
    const text =
      list.length === 1
        ? `Нагадую: столик у ${first.venue} - обери заклад або напиши назву.`
        : `Нагадую про столики:\n${list.map((c) => `• ${c.venue}`).join('\n')}\nОбери заклад у кожному або напиши назву.`;
    await enqueueOutbox(
      env,
      { chatId: first.chat_id ?? '', threadId: first.thread_id, kind: 'send', payload: { text } },
      nowMs,
    );
    sent += 1;
  }
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
    console.error('chain-nudge: драйн outbox впав (sweeper добере)', e?.message),
  );
  return { sent };
}

/**
 * Клейм нагадування (CAS за n): два тіки з тим самим списком due шлють
 * одне повідомлення. Наступне нагадування або кінець (n ≥ NUDGES_MAX →
 * nudge стирається, Workflow далі чекає мовчки).
 * @param {Env} env @param {{ id: string, n: number }} c @param {number} nowMs
 */
export async function claimNudge(env, c, nowMs) {
  const next = c.n + 1;
  const patch =
    next >= NUDGES_MAX
      ? { nudge: null }
      : { nudge: { at: new Date(nowMs + NUDGE_SECOND_MS).toISOString(), n: next } };
  const { meta } = await db(env)
    .prepare(
      `UPDATE chains SET state_json = json_patch(state_json, ?), updated_at = ? WHERE id = ? AND status = 'waiting'
         AND json_extract(state_json, '$.nudge.n') = ?`,
    )
    .bind(JSON.stringify(patch), new Date(nowMs).toISOString(), c.id, c.n)
    .run();
  return Boolean(meta?.changes);
}

/**
 * Мʼякий рядок S-1-6: ланцюг столика чекає понад добу - один раз на
 * київський день, у відповідь на повідомлення власника. Повертає текст або
 * null; мітку дня ставить сам.
 * @param {Env} env @param {number} nowMs
 */
export async function softWaitingLine(env, nowMs) {
  if (!env.DB) return null;
  const today = kyivDateKey(new Date(nowMs));
  const since = new Date(nowMs - 24 * 3_600_000).toISOString();
  const { results } = await db(env)
    .prepare(
      `SELECT id, json_extract(state_json, '$.venue') AS venue FROM chains
       WHERE kind = 'table' AND status = 'waiting'
         AND json_extract(state_json, '$.awaiting_since') <= ?
         AND COALESCE(json_extract(state_json, '$.soft_day'), '') != ? ORDER BY updated_at LIMIT 3`,
    )
    .bind(since, today)
    .all();
  const rows = results ?? [];
  if (rows.length === 0) return null;
  for (const r of rows) {
    await db(env)
      .prepare(`UPDATE chains SET state_json = json_patch(state_json, ?) WHERE id = ?`)
      .bind(JSON.stringify({ soft_day: today }), String(r.id))
      .run();
  }
  return rows.length === 1
    ? `Ланцюг «столик у ${String(rows[0]?.venue ?? '')}» чекає вибору - кнопки вище або «скасуй столик».`
    : `Ланцюги столиків чекають вибору: ${rows.map((r) => String(r.venue ?? '')).join(', ')}.`;
}
