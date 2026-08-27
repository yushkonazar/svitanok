// Outbox відправок Telegram (07-schema §1 `outbox`; 01 §2.1: «усі відправки
// через outbox - нічого не губиться при 429»). Enqueue кладе ряд у D1, drain
// відправляє послідовно з паузою THROTTLE_MS і претензією (claim) на ряд -
// конкурентні драйни (deliver + sweeper планувальника) ділять чергу, а не
// дублюють відправки. Збій - ретрай з бекофом до MAX_ATTEMPTS, далі failed
// (видимий у таблиці, не вічний цикл).
//
// kind (07 §1): send · edit · document (contact/venue - етап 5 разом із
// ланцюгами). Rich Message = send з parse_mode HTML + кнопки; фолбек - той
// самий текст без розмітки (isParseEntitiesError).

import {
  splitMessage,
  nextAttemptAt,
  isParseEntitiesError,
  THROTTLE_MS,
  DRAIN_BATCH_LIMIT,
  MAX_ATTEMPTS,
  STUCK_SENDING_MS,
} from './outbox-core.mjs';
// НЕ tgCall з telegram-client: той повертає Response, чиє тіло на помилці вже
// спожите його ж логуванням, - а драйну потрібна ПРИЧИНА збою (parse-помилка?
// retry_after?). Тут виклик віддає {ok, status, text} - тіло читається рівно раз.

/** @typedef {{ id: string, chat_id: string, thread_id: string | null, kind: string, payload_json: string, attempts: number, next_at: string, status: string }} OutboxRow */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - outbox неможливий');
  return env.DB;
}

/**
 * Покласти відправку в чергу. text-повідомлення довші за стелю Telegram
 * розбиваються на частини ЩЕ ТУТ - кожна частина окремий ряд, порядок тримає
 * next_at (+1 мс на частину).
 * @param {Env} env
 * @param {{ chatId: string | number, threadId?: string | number | null,
 *   kind: 'send' | 'edit' | 'document',
 *   payload: Record<string, unknown> }} item
 * @param {number} nowMs
 * @returns {Promise<{ queued: number }>}
 */
export async function enqueueOutbox(env, item, nowMs) {
  /** @type {Record<string, unknown>[]} */
  let payloads = [item.payload];
  if (item.kind === 'send') {
    const parts = splitMessage(String(item.payload.text ?? ''));
    if (parts.length === 0) return { queued: 0 };
    // Кнопки - лише на ОСТАННІЙ частині: інакше три клавіатури на одну відповідь.
    payloads = parts.map((text, i) => ({
      ...item.payload,
      text,
      ...(i < parts.length - 1 ? { reply_markup: undefined } : {}),
    }));
  }
  const statements = payloads.map((payload, i) =>
    db(env)
      .prepare(
        `INSERT INTO outbox (id, chat_id, thread_id, kind, payload_json, attempts, next_at, status)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'pending')`,
      )
      .bind(
        // Id СОРТОВНИЙ (час + індекс частини + uuid): порядок частин тримає
        // ORDER BY next_at, id, а next_at у всіх той самий - зсув на +i мс
        // робив би пізніші частини «не due» для драйну одразу після enqueue.
        `${String(nowMs).padStart(15, '0')}-${i}-${crypto.randomUUID()}`,
        String(item.chatId),
        item.threadId == null ? null : String(item.threadId),
        item.kind,
        JSON.stringify(payload),
        new Date(nowMs).toISOString(),
      ),
  );
  for (const s of statements) await s.run();
  return { queued: payloads.length };
}

/**
 * Статусні edit-и того самого повідомлення заміняють НЕЗІСЛАНІ попередні:
 * черга з 30 застарілих «▸ думаю…» нікому не потрібна - це і є троттлінг
 * статусу до фактичної швидкості відправки (01 §2.1: ядро троттлить).
 * @param {Env} env
 * @param {string | number} chatId
 * @param {number} messageId
 */
export async function dropPendingEdits(env, chatId, messageId) {
  await db(env)
    .prepare(
      `DELETE FROM outbox WHERE kind = 'edit' AND status = 'pending' AND chat_id = ?
         AND json_extract(payload_json, '$.message_id') = ?`,
    )
    .bind(String(chatId), messageId)
    .run();
}

/**
 * Дренаж черги: прострочені ряди по одному, claim через умовний UPDATE
 * (двом драйнерам той самий ряд D1 не віддасть), пауза між відправками.
 * @param {Env} env
 * @param {{ nowMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ sent: number, retried: number, failed: number }>}
 */
export async function drainOutbox(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const sleep = opts.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));

  // Завислий claim (ізолят умер посеред відправки): вичерпані спроби - failed
  // (інакше отруйний ряд крутився б pending↔sending вічно), решта - назад у
  // чергу зі спробою.
  const stuckCut = new Date(nowMs - STUCK_SENDING_MS).toISOString();
  await db(env)
    .prepare(
      `UPDATE outbox SET status = 'failed', attempts = attempts + 1
       WHERE status = 'sending' AND next_at < ? AND attempts >= ?`,
    )
    .bind(stuckCut, MAX_ATTEMPTS - 1)
    .run();
  await db(env)
    .prepare(
      `UPDATE outbox SET status = 'pending', attempts = attempts + 1
       WHERE status = 'sending' AND next_at < ?`,
    )
    .bind(stuckCut)
    .run();

  const due = /** @type {{ results: OutboxRow[] }} */ (
    await db(env)
      .prepare(
        `SELECT * FROM outbox WHERE status = 'pending' AND next_at <= ?
         ORDER BY next_at, id LIMIT ${DRAIN_BATCH_LIMIT}`,
      )
      .bind(new Date(nowMs).toISOString())
      .all()
  ).results;

  let sent = 0;
  let retried = 0;
  let failed = 0;
  let first = true;
  // Один годинник на весь прохід (nowMs): мішанина з Date.now() робила б
  // ретраї відносно ІНШОГО часу, ніж вибірка due, - i тести, i sweeper
  // бачили б чергу по-різному.
  for (const row of due) {
    const claim = await db(env)
      .prepare(
        `UPDATE outbox SET status = 'sending', next_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .bind(new Date(nowMs).toISOString(), row.id)
      .run();
    if ((claim.meta?.changes ?? 1) !== 1) continue; // забрав конкурентний драйн
    if (!first) await sleep(THROTTLE_MS);
    first = false;
    // Виняток fetch (мережа впала, не HTTP-помилка) - ретрай цього ряда, а не
    // обрив усього драйну з рядом, навічно завислим у 'sending'.
    const outcome = await sendRow(env, row).catch((/** @type {any} */ e) => {
      console.error(`outbox: відправка ${row.id} кинула виняток`, e?.message);
      return { ok: false, retryAfterSec: null };
    });
    if (outcome.ok) {
      await db(env).prepare(`UPDATE outbox SET status = 'sent' WHERE id = ?`).bind(row.id).run();
      sent += 1;
      continue;
    }
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db(env)
        .prepare(`UPDATE outbox SET status = 'failed', attempts = ? WHERE id = ?`)
        .bind(attempts, row.id)
        .run();
      console.error(`outbox: ряд ${row.id} (${row.kind}) вичерпав спроби - failed`);
      failed += 1;
      continue;
    }
    await db(env)
      .prepare(`UPDATE outbox SET status = 'pending', attempts = ?, next_at = ? WHERE id = ?`)
      .bind(
        attempts,
        new Date(nextAttemptAt(nowMs, attempts, outcome.retryAfterSec)).toISOString(),
        row.id,
      )
      .run();
    retried += 1;
  }
  return { sent, retried, failed };
}

/**
 * Виклик Telegram Bot API з тілом-JSON або FormData; тіло відповіді читається
 * рівно раз і віддається викликачеві разом зі статусом.
 * @param {Env} env
 * @param {string} method
 * @param {Record<string, unknown> | FormData} body
 * @returns {Promise<{ ok: boolean, status: number, text: string }>}
 */
async function tgApi(env, method, body) {
  const init =
    body instanceof FormData
      ? { method: 'POST', body }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, init);
  const text = await res.text().catch(() => '');
  if (!res.ok) console.error(`outbox: Telegram ${method} HTTP ${res.status}`, text.slice(0, 300));
  return { ok: res.ok, status: res.status, text };
}

/**
 * Одна відправка. Повертає {ok} | {ok:false, retryAfterSec?}; parse-помилка
 * розмітки лікується одразу повтором без parse_mode (fallback Rich → plain).
 * @param {Env} env
 * @param {OutboxRow} row
 */
async function sendRow(env, row) {
  /** @type {Record<string, unknown>} */
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    console.error(`outbox: ряд ${row.id} з битим payload_json`);
    return { ok: false, retryAfterSec: null };
  }
  const base = {
    chat_id: row.chat_id,
    message_thread_id: row.thread_id ?? undefined,
  };
  const attempt = (/** @type {Record<string, unknown>} */ body) => {
    if (row.kind === 'document') return tgApi(env, 'sendDocument', documentForm(row, body));
    const method = row.kind === 'edit' ? 'editMessageText' : 'sendMessage';
    return tgApi(env, method, { ...base, ...body });
  };

  let res = await attempt(payload);
  if (!res.ok && isParseEntitiesError(res.status, res.text) && payload.parse_mode) {
    const plain = { ...payload };
    delete plain.parse_mode;
    res = await attempt(plain);
  }
  if (res.ok) return { ok: true };
  let retryAfterSec = null;
  if (res.status === 429) {
    try {
      retryAfterSec = JSON.parse(res.text)?.parameters?.retry_after ?? null;
    } catch {
      retryAfterSec = null;
    }
  }
  return { ok: false, retryAfterSec };
}

/**
 * Документ - multipart (sendDocument не приймає JSON із вмістом файлу).
 * Вміст - текстовий (звіти .md); стеля Telegram 50 MB недосяжна, бо тіло
 * internal API обмежене раніше (128К) - окремий кап тут не потрібен.
 * @param {OutboxRow} row
 * @param {Record<string, unknown>} payload
 */
function documentForm(row, payload) {
  const form = new FormData();
  form.set('chat_id', row.chat_id);
  if (row.thread_id != null) form.set('message_thread_id', row.thread_id);
  if (payload.caption) form.set('caption', String(payload.caption));
  form.set(
    'document',
    new Blob([String(payload.content ?? '')], { type: 'text/plain' }),
    String(payload.filename ?? 'document.txt'),
  );
  return form;
}
