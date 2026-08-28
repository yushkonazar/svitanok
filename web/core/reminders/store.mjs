// Нагадування в D1 (07 §1 `reminders`, етап 2 PR-7). Доти вони жили в KV
// `state.reminders`, і це лишається чинним джерелом для ЛЕГАСІ-шляху до фліпа
// ASSISTANT_V2=on; новий шлях (інструменти PR-6) пише сюди.
//
// Чому окремий модуль, а не запити просто в інструменті: ті самі рядки читає
// задача планувальника (доставка) і скрипт міграції з KV, а три копії SQL
// розійшлися б у деталях - найпевніше у трактуванні статусів.
//
// Статуси 07 §1: pending · sent · snoozed · done · cancelled. «Активне» - те,
// що ще має спрацювати: pending або snoozed.

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - нагадування недоступні');
  return env.DB;
}

/** Стеля списку: моделі потрібен вибір, не архів. */
const MAX_LIST = 20;

/**
 * @typedef {{ id: string, text: string, dueAt: string, status: string,
 *   chatId: string | null, threadId: string | null, snoozeCount: number }} ReminderRow
 */

/** @param {any} row */
function toReminder(row) {
  return {
    id: String(row.id),
    text: String(row.text ?? ''),
    dueAt: String(row.due_at),
    status: String(row.status ?? 'pending'),
    chatId: row.chat_id ?? null,
    threadId: row.thread_id ?? null,
    snoozeCount: Number(row.snooze_count) || 0,
  };
}

/**
 * Створити нагадування. Час приходить уже порахованим (інструмент проганяє
 * природний текст через парсер ядра) - сюди не потрапляє нічого, що треба
 * інтерпретувати.
 * @param {Env} env
 * @param {{ id: string, text: string, dueAtMs: number,
 *   chatId?: string | number | null, threadId?: string | number | null }} input
 */
export async function createReminder(env, input) {
  await db(env)
    .prepare(
      `INSERT INTO reminders (id, due_at, text, status, snooze_count, chat_id, thread_id)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .bind(
      input.id,
      new Date(input.dueAtMs).toISOString(),
      input.text,
      input.chatId == null ? null : String(input.chatId),
      input.threadId == null ? null : String(input.threadId),
    )
    .run();
  return { id: input.id, text: input.text, dueAt: new Date(input.dueAtMs).toISOString() };
}

/**
 * Патч активного нагадування. Зміна часу скидає статус у pending - як у KV
 * (там зміна whenMs обнуляла firedTs): нагадування знову «на видачу».
 * @param {Env} env
 * @param {string} id
 * @param {{ text?: string, dueAtMs?: number }} patch
 * @returns {Promise<boolean>} false = нема такого активного
 */
export async function updateReminder(env, id, patch) {
  const sets = [];
  const binds = [];
  if (patch.text != null) {
    sets.push('text = ?');
    binds.push(patch.text);
  }
  if (patch.dueAtMs != null) {
    sets.push('due_at = ?', "status = 'pending'");
    binds.push(new Date(patch.dueAtMs).toISOString());
  }
  if (sets.length === 0) return false;
  binds.push(id);
  const res = await db(env)
    .prepare(
      `UPDATE reminders SET ${sets.join(', ')}
       WHERE id = ? AND status IN ('pending', 'snoozed')`,
    )
    .bind(...binds)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Скасувати активне нагадування. Рядок ЛИШАЄТЬСЯ зі статусом cancelled -
 * ретенція 07 §1 «12 міс після done», та й «↩» має що відновлювати.
 * @param {Env} env @param {string} id
 * @returns {Promise<boolean>} false = нема такого активного
 */
export async function cancelReminder(env, id) {
  const res = await db(env)
    .prepare(
      `UPDATE reminders SET status = 'cancelled'
       WHERE id = ? AND status IN ('pending', 'snoozed')`,
    )
    .bind(id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Повернути скасоване в гру («↩» після cancel).
 *  @param {Env} env @param {string} id */
export async function restoreReminder(env, id) {
  const res = await db(env)
    .prepare(`UPDATE reminders SET status = 'pending' WHERE id = ? AND status = 'cancelled'`)
    .bind(id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Активні нагадування за зростанням часу - для показу і для пошуку id.
 * @param {Env} env @param {number} [limit]
 * @returns {Promise<ReminderRow[]>}
 */
export async function listActiveReminders(env, limit = MAX_LIST) {
  const { results } = await db(env)
    .prepare(
      `SELECT * FROM reminders WHERE status IN ('pending', 'snoozed')
       ORDER BY due_at LIMIT ?`,
    )
    .bind(limit)
    .all();
  return (results ?? []).map(toReminder);
}

/** Одне нагадування за id (будь-якого статусу).
 *  @param {Env} env @param {string} id
 *  @returns {Promise<ReminderRow | null>} */
export async function getReminder(env, id) {
  const row = await db(env).prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
  return row ? toReminder(row) : null;
}

/**
 * Те, що вже мало спрацювати. Тихі години НЕ фільтруються тут: це рішення
 * доставки (у тиші нічого не шлемо і статус НЕ рухаємо, тож прострочене піде
 * першим тіком після вікна - та сама семантика, що в чинному кроні).
 * @param {Env} env @param {number} nowMs @param {number} [limit]
 * @returns {Promise<ReminderRow[]>}
 */
export async function dueReminders(env, nowMs, limit = 20) {
  const { results } = await db(env)
    .prepare(
      `SELECT * FROM reminders WHERE status IN ('pending', 'snoozed') AND due_at <= ?
       ORDER BY due_at LIMIT ?`,
    )
    .bind(new Date(nowMs).toISOString(), limit)
    .all();
  return (results ?? []).map(toReminder);
}

/**
 * Позначити надісланим. Умовний UPDATE, а не безумовний: два одночасні тіки
 * планувальника не мають слати те саме двічі - другий побачить changes=0 і
 * пропустить (той самий claim-first, що в outbox).
 * @param {Env} env @param {string} id
 * @returns {Promise<boolean>} true = саме ЦЕЙ виклик забрав нагадування
 */
export async function claimReminderSent(env, id) {
  const res = await db(env)
    .prepare(
      `UPDATE reminders SET status = 'sent'
       WHERE id = ? AND status IN ('pending', 'snoozed')`,
    )
    .bind(id)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/** Скільки активних - для перевірки кількості при міграції з KV.
 *  @param {Env} env */
export async function countActiveReminders(env) {
  const row = await db(env)
    .prepare("SELECT count(*) AS n FROM reminders WHERE status IN ('pending', 'snoozed')")
    .first();
  return Number(/** @type {any} */ (row)?.n ?? 0);
}
