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
 *   chatId: string | null, threadId: string | null, snoozeCount: number,
 *   rrule: string | null, recurCount: number }} ReminderRow
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
    // Повтор (0012): null = одноразове, тобто вся чинна поведінка.
    rrule: row.rrule ? String(row.rrule) : null,
    recurCount: Number(row.recur_count) || 0,
  };
}

/**
 * Створити нагадування. Час приходить уже порахованим (інструмент проганяє
 * природний текст через парсер ядра) - сюди не потрапляє нічого, що треба
 * інтерпретувати.
 * @param {Env} env
 * @param {{ id: string, text: string, dueAtMs: number,
 *   chatId?: string | number | null, threadId?: string | number | null,
 *   rrule?: string | null, recurCount?: number }} input
 */
export async function createReminder(env, input) {
  await db(env)
    .prepare(
      `INSERT INTO reminders (id, due_at, text, status, snooze_count, chat_id, thread_id, rrule, recur_count)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      new Date(input.dueAtMs).toISOString(),
      input.text,
      input.chatId == null ? null : String(input.chatId),
      input.threadId == null ? null : String(input.threadId),
      input.rrule ?? null,
      input.recurCount ?? 0,
    )
    .run();
  return {
    id: input.id,
    text: input.text,
    dueAt: new Date(input.dueAtMs).toISOString(),
    rrule: input.rrule ?? null,
  };
}

/**
 * Патч активного нагадування. Зміна часу скидає статус у pending - як у KV
 * (там зміна whenMs обнуляла firedTs): нагадування знову «на видачу».
 * @param {Env} env
 * @param {string} id
 * @param {{ text?: string, dueAtMs?: number, rrule?: string | null }} patch
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
  // `undefined` = не чіпаємо правило; явний `null` = знімаємо повтор.
  if (patch.rrule !== undefined) {
    sets.push('rrule = ?');
    binds.push(patch.rrule);
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

/**
 * Передати естафету ряду: створити наступну появу і зняти правило з поточної.
 *
 * ⚠️ ОДНИМ БАТЧЕМ, а не двома викликами (ревʼю релізу). D1-запит - це підзапит
 * Worker'а, а їх ~50 на виклик; доставка повторюваного коштувала чотири
 * (claim + INSERT + UPDATE + черга) замість двох, і тік із двадцятьма рядами
 * упирався в стелю. `batch` - один підзапит і одна транзакція: спадкоємець і
 * зняте правило або є разом, або немає разом.
 *
 * `INSERT OR IGNORE` навмисно: id спадкоємця детермінований, тож повторна
 * доставка тієї самої ланки має бути нуль-дією, а не ДРУГИМ рядом.
 * @param {Env} env
 * @param {string} prevId - строка, що вже спрацювала
 * @param {{ id: string, text: string, dueAtMs: number, chatId: string | null,
 *   threadId: string | null, rrule: string, recurCount: number }} next
 * @returns {Promise<boolean>} false = спадкоємець уже існував (ряд не роздвоєно)
 */
export async function handOffRecurrence(env, prevId, next) {
  const d = db(env);
  const [ins] = await d.batch([
    d
      .prepare(
        `INSERT OR IGNORE INTO reminders
           (id, due_at, text, status, snooze_count, chat_id, thread_id, rrule, recur_count)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .bind(
        next.id,
        new Date(next.dueAtMs).toISOString(),
        next.text,
        next.chatId,
        next.threadId,
        next.rrule,
        next.recurCount,
      ),
    d.prepare(`UPDATE reminders SET rrule = NULL WHERE id = ?`).bind(prevId),
  ]);
  return (ins?.meta?.changes ?? 0) > 0;
}

/**
 * Відкласти надіслане нагадування (кнопка «😴» під повідомленням). Працює
 * саме з `sent`: кнопка живе на вже доставленому, а не на активному.
 * @param {Env} env @param {string} id @param {number} dueAtMs
 * @returns {Promise<boolean>} false = такого надісланого немає
 */
export async function snoozeReminder(env, id, dueAtMs) {
  const res = await db(env)
    .prepare(
      `UPDATE reminders SET due_at = ?, status = 'snoozed', snooze_count = snooze_count + 1
       WHERE id = ? AND status IN ('sent', 'pending', 'snoozed')`,
    )
    .bind(new Date(dueAtMs).toISOString(), id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Позначити виконаним (кнопка «✅»). Термінальний статус: більше не спливе.
 * @param {Env} env @param {string} id
 * @returns {Promise<ReminderRow | null>} рядок ДО зміни (для тексту відповіді)
 */
export async function completeReminder(env, id) {
  const before = await getReminder(env, id);
  if (!before || before.status === 'done') return null;
  await db(env).prepare(`UPDATE reminders SET status = 'done' WHERE id = ?`).bind(id).run();
  return before;
}

/**
 * Повернути в чергу після невдалої відправки: claim уже стоїть, а
 * повідомлення не пішло - без цього нагадування мовчки зникло б назавжди.
 * @param {Env} env @param {string} id
 */
export async function releaseSentClaim(env, id) {
  await db(env)
    .prepare(`UPDATE reminders SET status = 'pending' WHERE id = ? AND status = 'sent'`)
    .bind(id)
    .run();
}

/** Скільки активних - для перевірки кількості при міграції з KV.
 *  @param {Env} env */
export async function countActiveReminders(env) {
  const row = await db(env)
    .prepare("SELECT count(*) AS n FROM reminders WHERE status IN ('pending', 'snoozed')")
    .first();
  return Number(/** @type {any} */ (row)?.n ?? 0);
}
