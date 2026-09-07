// Задача `chain-nudge` (07 §7, S-1-6): «не натиснув кнопку» - нагадати
// через +5 і +20 хв від початку очікування, далі тиша (Workflow лишається
// waiting). Стан нагадувань - у state_json ланцюга (`nudge: {at, n}`): його
// ставить машина станів, коли починає чекати, і стирає, коли дочекалась.
// Сканування D1 раз на 5 хв, а не сон у Workflow: так кілька ланцюгів на той
// самий час ідуть одним повідомленням (S-1-13), а «+5 хв» означає «+5…+10».
// Мʼякий рядок «ланцюг чекає» після доби тиші - softWaitingLine (prerouter,
// раз на день, у відповідь на повідомлення власника в тому ж треді).

import { kyivDateKey } from '../../kyiv-time.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { chainTarget, db } from './state.mjs';
import { CHAIN_KIND, NUDGE_SECOND_MS, NUDGES_MAX } from './table.mjs';

/** @typedef {{ id: string, venue: string, n: number, awaiting: string | null, chat_id: string | null, thread_id: string | null }} DueNudge */

/**
 * Ланцюги столика, чиє нагадування настало.
 * @param {Env} env @param {number} nowMs
 * @returns {Promise<DueNudge[]>}
 */
export async function dueNudges(env, nowMs) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, json_extract(state_json, '$.venue') AS venue, json_extract(state_json, '$.nudge.n') AS n,
              json_extract(state_json, '$.awaiting') AS awaiting,
              json_extract(state_json, '$.chat_id') AS chat_id, json_extract(state_json, '$.thread_id') AS thread_id
       FROM chains WHERE kind = ? AND status = 'waiting'
         AND json_extract(state_json, '$.nudge.at') IS NOT NULL
         AND json_extract(state_json, '$.nudge.at') <= ? ORDER BY updated_at`,
    )
    .bind(CHAIN_KIND, new Date(nowMs).toISOString())
    .all();
  return (results ?? []).map((r) => ({
    id: String(r.id),
    venue: String(r.venue ?? ''),
    n: Number(r.n) || 0,
    awaiting: r.awaiting == null ? null : String(r.awaiting),
    chat_id: r.chat_id == null ? null : String(r.chat_id),
    thread_id: r.thread_id == null ? null : String(r.thread_id),
  }));
}

/**
 * Клейм нагадувань (CAS за n, одним batch): два тіки з тим самим списком
 * due шлють одне повідомлення. Наступне нагадування або кінець (n ≥
 * NUDGES_MAX → nudge стирається, Workflow далі чекає мовчки). RETURNING id,
 * а не meta.changes: результат batch читається однаково в D1 і в тестовому
 * стабі.
 * @param {Env} env @param {{ id: string, n: number }[]} due @param {number} nowMs
 * @returns {Promise<boolean[]>} по кожному - чи клейм узято
 */
export async function claimNudges(env, due, nowMs) {
  if (due.length === 0) return [];
  const stmt = db(env).prepare(
    `UPDATE chains SET state_json = json_patch(state_json, ?), updated_at = ? WHERE id = ? AND status = 'waiting'
       AND json_extract(state_json, '$.nudge.n') = ? RETURNING id`,
  );
  const iso = new Date(nowMs).toISOString();
  const rows = await db(env).batch(
    due.map((c) => {
      const next = c.n + 1;
      const patch =
        next >= NUDGES_MAX
          ? { nudge: null }
          : { nudge: { at: new Date(nowMs + NUDGE_SECOND_MS).toISOString(), n: next } };
      return stmt.bind(JSON.stringify(patch), iso, c.id, c.n);
    }),
  );
  return rows.map((r) => /** @type {any} */ (r?.results?.length ?? 0) > 0);
}

/** Що саме просимо - за станом очікування. @param {string | null} awaiting */
function askOf(awaiting) {
  if (awaiting === 'contact') return 'натисни «Подзвонив» або «Пізніше»';
  if (awaiting === 'next') return 'кнопки під закладом: маршрут, вихід, запросити або «Готово»';
  return 'обери заклад або напиши назву';
}

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function chainNudgeTask(env, nowMs = Date.now()) {
  if (!env.DB) return { sent: 0, skipped: 'no-db' };
  const due = await dueNudges(env, nowMs);
  if (due.length === 0) return { sent: 0 };
  const taken = await claimNudges(env, due, nowMs);
  const claimed = due.filter((_, i) => taken[i]);
  if (claimed.length === 0) return { sent: 0 };
  // Одне повідомлення на адресу (чат/тред): ланцюги на той самий час - списком.
  /** @type {Map<string, { chatId: string, threadId: string | null, items: DueNudge[] }>} */
  const byTarget = new Map();
  for (const c of claimed) {
    let target;
    try {
      target = chainTarget(env, c);
    } catch (/** @type {any} */ e) {
      console.error(`chain-nudge ${c.id}: адреси немає`, e?.message);
      continue;
    }
    const key = `${target.chatId}:${target.threadId ?? ''}`;
    const group = byTarget.get(key) ?? { ...target, items: [] };
    group.items.push(c);
    byTarget.set(key, group);
  }
  let sent = 0;
  for (const group of byTarget.values()) {
    const first = group.items[0];
    if (!first) continue;
    const text =
      group.items.length === 1
        ? `Нагадую: столик у ${first.venue} - ${askOf(first.awaiting)}.`
        : `Нагадую про столики:\n${group.items.map((c) => `• ${c.venue} - ${askOf(c.awaiting)}`).join('\n')}`;
    await enqueueOutbox(
      env,
      { chatId: group.chatId, threadId: group.threadId, kind: 'send', payload: { text } },
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
 * Мʼякий рядок S-1-6: ланцюг столика в цьому треді чекає понад добу - один
 * раз на київський день, у відповідь на повідомлення власника. Повертає
 * текст або null; мітку дня ставить тим самим UPDATE.
 * @param {Env} env @param {number} nowMs @param {string} threadKey - 'dm' або id теми
 */
export async function softWaitingLine(env, nowMs, threadKey) {
  if (!env.DB) return null;
  const today = kyivDateKey(new Date(nowMs));
  const since = new Date(nowMs - 24 * 3_600_000).toISOString();
  const { results } = await db(env)
    .prepare(
      `UPDATE chains SET state_json = json_patch(state_json, ?)
       WHERE kind = ? AND status = 'waiting'
         AND json_extract(state_json, '$.awaiting_since') <= ?
         AND COALESCE(json_extract(state_json, '$.thread_id'), ?) = ?
         AND COALESCE(json_extract(state_json, '$.soft_day'), '') != ?
       RETURNING json_extract(state_json, '$.venue') AS venue`,
    )
    .bind(JSON.stringify({ soft_day: today }), CHAIN_KIND, since, threadKey, threadKey, today)
    .all();
  const venues = (results ?? []).map((r) => String(r.venue ?? ''));
  if (venues.length === 0) return null;
  return venues.length === 1
    ? `Ланцюг «столик у ${venues[0]}» чекає вибору - кнопки вище або «скасуй столик».`
    : `Ланцюги столиків чекають вибору: ${venues.join(', ')}.`;
}
