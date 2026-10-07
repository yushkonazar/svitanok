import { kyivDateKey } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';

const SHIFT_MS = 20 * 60 * 60_000;
const EDIT_MS = 10 * 60_000;
const MAX_ACTIVE = 20;
/** @typedef {{chatId: string|number|null, threadId?: string|number|null}} Target */
/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('Context reminders require D1');
  return env.DB;
}
/** @param {Target} target */
function scope(target) {
  return [String(target.chatId), target.threadId == null ? '' : String(target.threadId)];
}
/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();
/** @param {string} text */
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Our generated HTML has only escaped owner text, no HTML tags. @param {string} text */
const plain = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Strict anchored owner utterances; quotes, future, negation and breaks don't match.
 * @param {string} text @param {number} nowMs */
export function parseContextIntent(text, nowMs) {
  const normalized = text
    .trim()
    .replace(/[.!]+$/u, '')
    .trim();
  if (
    /^(?:нагадай(?:\s+мені)?|нагадати)\s/iu.test(normalized) &&
    /після\s+роботи/iu.test(normalized) &&
    /(?:^|\s)(?:щодня|щотижня|щопонеділка|кожного\s+дня)(?:\s|$)/iu.test(normalized)
  )
    return { kind: 'recurring' };
  const reminder =
    /^(?:нагадай(?:\s+мені)?|нагадати)\s+(?:(сьогодні|завтра)\s+)?після\s+роботи\s*[:,—-]?\s+(?:(сьогодні|завтра)\s+)?(.+)$/iu.exec(
      normalized,
    );
  if (reminder) {
    const title = String(reminder[3]).trim();
    if (reminder[1] && reminder[2] && reminder[1].toLowerCase() !== reminder[2].toLowerCase())
      return { kind: 'invalid' };
    if (!title || title.length > 140) return { kind: 'invalid' };
    if (/^(?:щодня|щопонеділка|кожн)/iu.test(title)) return { kind: 'recurring' };
    return {
      kind: 'create',
      text: title,
      date:
        (reminder[1] ?? reminder[2])
          ? addDaysToDateKey(
              kyivDateKey(new Date(nowMs)),
              String(reminder[1] ?? reminder[2]).toLowerCase() === 'завтра' ? 1 : 0,
            )
          : null,
    };
  }
  if (
    /^(?:нагадай(?:\s+мені)?\s+)(?:щодня|кожного\s+дня)\s+після\s+роботи(?:\s|$)/iu.test(normalized)
  )
    return { kind: 'recurring' };
  if (
    /^(?:я\s+)?(?:закінчив\s+працювати|завершив\s+роботу|роботу\s+завершено|закінчив\s+роботу)$/iu.test(
      normalized,
    )
  )
    return { kind: 'finish' };
  if (/^(?:я\s+)?(?:їду|йду|повертаюсь|повертаюся)\s+додому$/iu.test(normalized))
    return { kind: 'home' };
  if (/^(?:я\s+)?(?:почав\s+працювати|розпочав\s+роботу)$/iu.test(normalized))
    return { kind: 'start' };
  const edit = /^нова\s+справа\s*:\s*(.+)$/iu.exec(normalized);
  if (edit)
    return String(edit[1]).trim().length > 140
      ? { kind: 'invalid' }
      : { kind: 'edit', text: String(edit[1]).trim() };
  return null;
}

/** @param {Env} env @param {Target} target @param {number} nowMs */
export async function currentWorkContext(env, target, nowMs) {
  return /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT * FROM work_contexts WHERE chat_id=? AND thread_id=? AND work_date<=?
      AND (work_date=? OR activated_at>=? OR finished_at>=?)
      ORDER BY CASE WHEN finished_at IS NULL AND activated_at IS NOT NULL THEN 2
        WHEN finished_at>=? THEN 1 ELSE 0 END DESC,
        COALESCE(finished_at,activated_at,opened_at) DESC,id DESC LIMIT 1`,
      )
      .bind(
        ...scope(target),
        kyivDateKey(new Date(nowMs)),
        kyivDateKey(new Date(nowMs)),
        iso(nowMs - SHIFT_MS),
        iso(nowMs - SHIFT_MS),
        iso(nowMs - SHIFT_MS),
      )
      .first()
  );
}

/** @param {Env} env @param {Target} target @param {string} date @param {number} nowMs @param {string} [shiftKey] */
export async function ensureWorkContext(env, target, date, nowMs, shiftKey = '') {
  const key = JSON.stringify([...scope(target), date, shiftKey]);
  await db(env)
    .prepare(
      `INSERT OR IGNORE INTO work_contexts
    (id,scope_key,chat_id,thread_id,work_date,opened_at,activated_at,started_at)
    VALUES(?,?,?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID().replaceAll('-', ''),
      key,
      ...scope(target),
      date,
      iso(nowMs),
      date <= kyivDateKey(new Date(nowMs)) ? iso(nowMs) : null,
      shiftKey ? iso(nowMs) : null,
    )
    .run();
  return /** @type {any} */ (
    await db(env).prepare('SELECT * FROM work_contexts WHERE scope_key=?').bind(key).first()
  );
}

/** Reminder creation and its acknowledgement share a transaction and a webhook key.
 * @param {Env} env @param {Target} target @param {{text:string,date?:string|null}} input
 * @param {string} sourceKey @param {number} nowMs */
export async function createContextReminder(env, target, input, sourceKey, nowMs) {
  if (!input.text.trim() || input.text.length > 140 || target.chatId == null)
    throw new Error('invalid-context-reminder');
  const previous = /** @type {any} */ (
    await db(env)
      .prepare('SELECT * FROM context_reminders WHERE source_key=?')
      .bind(sourceKey)
      .first()
  );
  if (previous) return previous;
  let context = input.date ? null : await currentWorkContext(env, target, nowMs);
  context ??= await ensureWorkContext(
    env,
    target,
    input.date ?? kyivDateKey(new Date(nowMs)),
    nowMs,
  );
  const count = /** @type {any} */ (
    await db(env)
      .prepare(
        "SELECT COUNT(*) n FROM context_reminders WHERE context_id=? AND status NOT IN ('done','cancelled')",
      )
      .bind(context.id)
      .first()
  );
  if (Number(count?.n) >= MAX_ACTIVE) throw new Error('context-full');
  const id = crypto.randomUUID().replaceAll('-', '');
  const status = context.finished_at ? 'awaiting_scope' : 'pending';
  const row = { id, text: input.text, status, context_id: context.id };
  const card = contextReminderCard(row, context);
  await db(env).batch([
    db(env)
      .prepare(
        `INSERT OR IGNORE INTO context_reminders
      (id,context_id,text,source_key,status,created_at,updated_at) SELECT ?,?,?,?,?,?,?
      WHERE (SELECT COUNT(*) FROM context_reminders WHERE context_id=? AND status NOT IN ('done','cancelled')) < ${MAX_ACTIVE}`,
      )
      .bind(id, context.id, input.text, sourceKey, status, iso(nowMs), iso(nowMs), context.id),
    db(env)
      .prepare(
        `INSERT INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status)
      SELECT ?,?,?, 'send',?,0,?,'pending' WHERE EXISTS(SELECT 1 FROM context_reminders WHERE id=?)`,
      )
      .bind(
        `context-ack-${id}`,
        String(target.chatId),
        target.threadId == null ? null : String(target.threadId),
        JSON.stringify(card),
        iso(nowMs),
        id,
      ),
  ]);
  const saved = /** @type {any} */ (
    await db(env)
      .prepare('SELECT * FROM context_reminders WHERE source_key=?')
      .bind(sourceKey)
      .first()
  );
  if (!saved) throw new Error('context-full');
  return saved;
}

/** Recover a crash between a finish confirmation and queueing. Only explicit
 * recorded finish events qualify: elapsed planned hours never qualify.
 * @param {Env} env @param {number} nowMs */
export async function recoverContextDeliveries(env, nowMs) {
  if (!env.DB) return;
  try {
    const { results } = await db(env)
      .prepare(
        `SELECT DISTINCT c.id FROM work_contexts c JOIN context_reminders r
      ON r.context_id=c.id WHERE c.finished_at IS NOT NULL AND r.status='pending' AND r.delivery_id IS NULL LIMIT 4`,
      )
      .bind()
      .all();
    for (const row of results ?? []) await queueContextDelivery(env, String(row.id), nowMs);
  } catch (error) {
    if (!String(error).includes('no such table')) throw error;
  }
}

/** Atomically register finish AND queue all currently unclaimed tasks. A concurrent
 * creator runs this again, closing the registration/trigger race. No clock trigger.
 * @param {Env} env @param {string} contextId @param {number} nowMs @param {boolean} [finish] @param {number|null} [messageId] */
export async function queueContextDelivery(
  env,
  contextId,
  nowMs,
  finish = false,
  messageId = /** @type {number|null} */ (null),
) {
  const id = crypto.randomUUID().replaceAll('-', '');
  const rows = await db(env).batch([
    db(env)
      .prepare(
        `UPDATE work_contexts SET finished_at=COALESCE(finished_at,?),activated_at=COALESCE(activated_at,?),confirmation_at=NULL
      WHERE id=? AND ?=1`,
      )
      .bind(iso(nowMs), iso(nowMs), contextId, finish ? 1 : 0),
    db(env)
      .prepare(`INSERT INTO context_deliveries(id,context_id,created_at) VALUES(?,?,?)`)
      .bind(id, contextId, iso(nowMs)),
    db(env)
      .prepare(
        `UPDATE context_reminders SET delivery_id=?,status='notified',updated_at=?
      WHERE id IN (SELECT r.id FROM context_reminders r JOIN work_contexts c ON c.id=r.context_id
        WHERE c.id=? AND c.finished_at IS NOT NULL AND r.status='pending' AND r.delivery_id IS NULL
        ORDER BY r.created_at,r.id LIMIT ${MAX_ACTIVE})`,
      )
      .bind(id, iso(nowMs), contextId),
    db(env)
      .prepare(
        `UPDATE context_deliveries SET snapshot_json=(SELECT json_group_array(json_object('id',id,'text',text))
      FROM (SELECT id,text FROM context_reminders WHERE delivery_id=? ORDER BY created_at,id)) WHERE id=?`,
      )
      .bind(id, id),
    db(env)
      .prepare(
        `INSERT INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status)
      SELECT ?,c.chat_id,NULLIF(c.thread_id,''),?, ?,0,?,'pending' FROM work_contexts c
      WHERE c.id=? AND EXISTS(SELECT 1 FROM context_reminders WHERE delivery_id=?)`,
      )
      .bind(
        `context-delivery-${id}`,
        messageId == null ? 'send' : 'edit',
        JSON.stringify({
          context_delivery_id: id,
          ...(messageId == null ? { delivery_safety: 'at-most-once' } : { message_id: messageId }),
        }),
        iso(nowMs),
        contextId,
        id,
      ),
    db(env).prepare(`DELETE FROM context_deliveries WHERE id=? AND snapshot_json='[]'`).bind(id),
  ]);
  return { id, queued: Number(rows[4]?.meta?.changes ?? 0) > 0 };
}

/** @param {any} row @param {any} context */
export function contextReminderCard(row, context) {
  const awaiting = row.status === 'awaiting_scope';
  const active = ['pending', 'notified', 'deferred', 'awaiting_scope'].includes(row.status);
  const prefix = awaiting
    ? 'Роботу вже завершено. Коли нагадати?'
    : row.status === 'done'
      ? '✅ Виконано'
      : row.status === 'cancelled'
        ? 'Скасовано'
        : `⏰ Після роботи, ${new Date(`${context.work_date}T12:00:00Z`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', timeZone: 'Europe/Kyiv' })}`;
  const button = (/** @type {string} */ text, /** @type {string} */ action) => ({
    text,
    callback_data: `er:i:${row.id}:${action}`,
  });
  return {
    text: `${prefix}\n${escape(row.text)}`,
    plain_text: `${prefix}\n${row.text}`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: !active
        ? []
        : awaiting
          ? [
              [button('Зараз', 'now'), button('Завтра після роботи', 'next')],
              [button('Скасувати', 'cancel')],
            ]
          : [
              [button('Змінити', 'edit'), button('Скасувати', 'cancel')],
              ...(row.status === 'pending'
                ? [[{ text: 'Роботу завершено', callback_data: `er:f:${row.context_id}` }]]
                : []),
            ],
    },
  };
}

/** @param {Env} env @param {string} id */
export async function renderContextDelivery(env, id) {
  const group = /** @type {any} */ (
    await db(env).prepare('SELECT * FROM context_deliveries WHERE id=?').bind(id).first()
  );
  if (!group) throw new Error('Context delivery unavailable');
  /** @type {{id:string,text:string}[]} */
  const snapshot = JSON.parse(group.snapshot_json);
  const lines = ['Перед дорогою додому:'];
  const receipt = /** @type {any} */ (
    await db(env)
      .prepare('SELECT status FROM outbox WHERE id=?')
      .bind(`context-delivery-${id}`)
      .first()
  );
  if (receipt?.status === 'uncertain')
    lines.push(
      'Попередню доставку не підтверджено. Справи збережені; повторно автоматично не надсилаю.',
    );
  if (receipt?.status === 'failed')
    lines.push('Попереднє повідомлення не доставлено. Справи збережені.');
  /** @type {{text:string,callback_data:string}[][]} */
  const buttons = [];
  const labels = {
    done: '✅ виконано',
    cancelled: 'скасовано',
    deferred: 'не зараз',
    pending: 'інша зміна',
    awaiting_scope: 'уточнення',
  };
  for (const [i, item] of snapshot.entries()) {
    const row = /** @type {any} */ (
      await db(env).prepare('SELECT * FROM context_reminders WHERE id=?').bind(item.id).first()
    );
    const state = !row
      ? 'скасовано'
      : row.delivery_id !== id
        ? 'інша зміна'
        : (labels[/** @type {keyof typeof labels} */ (row.status)] ?? '');
    lines.push(`${i + 1}. ${escape(row?.text ?? item.text)}${state ? ` — ${state}` : ''}`);
    if (row && row.delivery_id === id && ['notified', 'deferred'].includes(row.status)) {
      buttons.push(
        ['✅ Готово', 'Не зараз', 'Завтра', 'Прибрати'].map((text, j) => ({
          text: `${i + 1} · ${text}`,
          callback_data: `er:g:${id}:${i}:${['done', 'later', 'next', 'cancel'][j]}`,
        })),
      );
    }
  }
  return {
    text: lines.join('\n'),
    plain_text: plain(lines.join('\n')),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  };
}

/** @param {Env} env @param {Target} target */
export async function listContextReminders(env, target) {
  try {
    const { results } = await db(env)
      .prepare(
        `SELECT r.*,c.work_date,c.finished_at FROM context_reminders r
      JOIN work_contexts c ON c.id=r.context_id WHERE c.chat_id=? AND c.thread_id=?
      AND r.status NOT IN ('done','cancelled') ORDER BY r.created_at,r.id LIMIT ${MAX_ACTIVE}`,
      )
      .bind(...scope(target))
      .all();
    return /** @type {any[]} */ (results ?? []);
  } catch (error) {
    // Expand migration must precede Worker. Old fixtures/old release may not have it.
    if (String(error).includes('no such table')) return [];
    throw error;
  }
}

/** Until contextual snapshots have undo support, never let "undo last" silently
 * roll back an OLDER calendar/fact action instead. Offer scoped buttons instead.
 * @param {Env} env @param {Target} target @param {number} nowMs */
export async function contextUndoGuard(env, target, nowMs) {
  try {
    const row = /** @type {any} */ (
      await db(env)
        .prepare(
          `SELECT r.*,c.work_date FROM context_reminders r JOIN work_contexts c
      ON c.id=r.context_id WHERE c.chat_id=? AND c.thread_id=? AND r.updated_at>=? ORDER BY r.updated_at DESC,r.id DESC LIMIT 1`,
        )
        .bind(...scope(target), iso(nowMs - 24 * 60 * 60_000))
        .first()
    );
    if (!row) return null;
    const undo = /** @type {any} */ (
      await db(env)
        .prepare(
          "SELECT created_at FROM proposals WHERE kind LIKE 'undo:%' AND (thread_id IS ? OR thread_id=?) ORDER BY created_at DESC LIMIT 1",
        )
        .bind(
          target.threadId == null ? 'dm' : String(target.threadId),
          target.threadId == null ? 'dm' : String(target.threadId),
        )
        .first()
    );
    if (undo && undo.created_at > row.updated_at) return null;
    const card = contextReminderCard(row, row);
    const explanation = card.reply_markup.inline_keyboard.length
      ? 'Для цієї справи скористайся її кнопками. Старіші дії не відкочував.'
      : 'Відкат цієї зміни поки не підтримується. Старіші дії не відкочував.';
    return {
      ...card,
      text: `${explanation}\n${card.text}`,
      plain_text: `${explanation}\n${card.plain_text}`,
    };
  } catch (error) {
    if (String(error).includes('no such table')) return null;
    throw error;
  }
}

/** Update only a task belonging to this owner target; stale group buttons are no-ops.
 * @param {Env} env @param {Target} target @param {string} id @param {string} action
 * @param {number} nowMs @param {string|null} [deliveryId] */
export async function changeContextReminder(env, target, id, action, nowMs, deliveryId = null) {
  const row = /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT r.*,c.work_date,c.finished_at FROM context_reminders r
    JOIN work_contexts c ON c.id=r.context_id WHERE r.id=? AND c.chat_id=? AND c.thread_id=?`,
      )
      .bind(id, ...scope(target))
      .first()
  );
  if (
    !row ||
    ['done', 'cancelled'].includes(row.status) ||
    (deliveryId && row.delivery_id !== deliveryId)
  )
    return null;
  if (action === 'edit') {
    await db(env)
      .prepare('UPDATE context_reminders SET edit_until=? WHERE id=?')
      .bind(iso(nowMs + EDIT_MS), id)
      .run();
    return row;
  }
  const status = {
    done: 'done',
    cancel: 'cancelled',
    later: 'deferred',
    next: 'pending',
    now: 'pending',
  }[action];
  if (
    !status ||
    (['now', 'next'].includes(action) && !deliveryId && row.status !== 'awaiting_scope')
  )
    return null;
  const context =
    action === 'next'
      ? await ensureWorkContext(
          env,
          target,
          addDaysToDateKey(kyivDateKey(new Date(nowMs)), 1),
          nowMs,
        )
      : null;
  if (context) {
    const active = /** @type {any} */ (
      await db(env)
        .prepare(
          "SELECT COUNT(*) n FROM context_reminders WHERE context_id=? AND status NOT IN ('done','cancelled')",
        )
        .bind(context.id)
        .first()
    );
    if (Number(active?.n) >= MAX_ACTIVE) throw new Error('context-full');
  }
  const changed = await db(env)
    .prepare(
      `UPDATE context_reminders SET status=?,context_id=?,updated_at=?,
    delivery_id=?,edit_until=NULL WHERE id=? AND status=? AND context_id=? AND delivery_id IS ?
    AND (? IS NULL OR (SELECT COUNT(*) FROM context_reminders WHERE context_id=? AND status NOT IN ('done','cancelled')) < ${MAX_ACTIVE})`,
    )
    .bind(
      status,
      context?.id ?? row.context_id,
      iso(nowMs),
      ['next', 'now'].includes(action) ? null : row.delivery_id,
      id,
      row.status,
      row.context_id,
      row.delivery_id,
      context?.id ?? null,
      context?.id ?? null,
    )
    .run();
  if (!changed.meta?.changes) return null;
  if (action === 'now') await queueContextDelivery(env, row.context_id, nowMs);
  return {
    ...row,
    status,
    context_id: context?.id ?? row.context_id,
    work_date: context?.work_date ?? row.work_date,
  };
}

/** @param {Env} env @param {Target} target @param {string} title @param {number} nowMs */
export async function editContextReminder(env, target, title, nowMs) {
  if (!title || title.length > 140) return null;
  const row = /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT r.*,c.work_date FROM context_reminders r
    JOIN work_contexts c ON c.id=r.context_id WHERE c.chat_id=? AND c.thread_id=? AND r.edit_until>?
    AND r.status IN ('pending','notified','deferred') ORDER BY r.edit_until DESC LIMIT 1`,
      )
      .bind(...scope(target), iso(nowMs))
      .first()
  );
  if (!row) return null;
  const changed = await db(env)
    .prepare(
      'UPDATE context_reminders SET text=?,updated_at=?,edit_until=NULL WHERE id=? AND edit_until=?',
    )
    .bind(title, iso(nowMs), row.id, row.edit_until)
    .run();
  return changed.meta?.changes ? { ...row, text: title } : null;
}
