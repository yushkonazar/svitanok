// Outbox відправок Telegram (07-schema §1 `outbox`; 01 §2.1: «усі відправки
// через outbox - нічого не губиться при 429»). Enqueue кладе ряд у D1, drain
// відправляє послідовно з паузою THROTTLE_MS і претензією (claim) на ряд -
// конкурентні драйни (deliver + sweeper планувальника) ділять чергу, а не
// дублюють відправки. Збій - ретрай з бекофом до MAX_ATTEMPTS, далі failed
// (видимий у таблиці, не вічний цикл).
//
// kind (07 §1): send · edit · document · contact · venue (два останні -
// ланцюг столика, етап 5: sendContact/sendVenue з JSON-тілом як sendMessage).
// Rich Message = send з parse_mode HTML + кнопки; фолбек - той самий текст
// без розмітки (isParseEntitiesError).

import { loadSentMessages, putSentMessages } from '../../kv-store.mjs';
import { recordSentMessage } from '../../tg-core.mjs';
import {
  splitMessage,
  nextAttemptAt,
  isParseEntitiesError,
  isNotModifiedError,
  isEditTargetGone,
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
 * id (час + індекс частини).
 *
 * `editFirstMessageId` - фінал прогону заміняє ЧЕРНЕТКУ статусу (01 §3.1
 * «Rich draft»): перша частина їде editMessageText у вказане повідомлення,
 * решта - звичайними send. Розбиття, порядок і правило «кнопки лише на
 * останній частині» лишаються тут, в одному місці: у викликача розкладати
 * частини по окремих enqueue не можна - усі ряди мали б однаковий префікс id,
 * і порядок вирішував би випадковий uuid.
 * @param {Env} env
 * `parts` - готові частини send (tg/markdown.mjs: текст уже порізано, кожна
 * частина сама несе parse_mode і plain_text для фолбеку; лягають поверх payload).
 * @param {{ chatId: string | number, threadId?: string | number | null,
 *   kind: 'send' | 'edit' | 'document' | 'contact' | 'venue',
 *   payload: Record<string, unknown>, editFirstMessageId?: number | null,
 *   parts?: import('./markdown.mjs').MdPart[] }} item
 * @param {number} nowMs
 * @returns {Promise<{ queued: number }>}
 */
export async function enqueueOutbox(env, item, nowMs) {
  /** @type {{ kind: 'send' | 'edit' | 'document' | 'contact' | 'venue', payload: Record<string, unknown> }[]} */
  let rows = [{ kind: item.kind, payload: item.payload }];
  if (item.kind === 'send') {
    // Готові частини (deliver: Markdown порізано ДО конвертації в HTML) або
    // розбиття сирого тексту тут.
    const parts =
      item.parts ?? splitMessage(String(item.payload.text ?? '')).map((text) => ({ text }));
    if (parts.length === 0) return { queued: 0 };
    const draftId = item.editFirstMessageId ?? null;
    // Кнопки - лише на ОСТАННІЙ частині: інакше три клавіатури на одну відповідь.
    rows = parts.map((part, i) => ({
      kind: /** @type {'send' | 'edit'} */ (i === 0 && draftId != null ? 'edit' : 'send'),
      payload: {
        ...item.payload,
        ...part,
        // fallback_send - службовий прапорець ряду, у Telegram не їде
        // (sendRow його зрізає): «це відповідь, а не статусний партіал».
        ...(i === 0 && draftId != null ? { message_id: draftId, fallback_send: true } : {}),
        ...(i < parts.length - 1 ? { reply_markup: undefined } : {}),
      },
    }));
  }
  const statements = rows.map((row, i) =>
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
        row.kind,
        JSON.stringify(row.payload),
        new Date(nowMs).toISOString(),
      ),
  );
  for (const s of statements) await s.run();
  return { queued: rows.length };
}

/**
 * Алерт у тему TOPIC_SYSTEM: enqueue + best-effort drain (добере sweeper).
 * Одне місце для квот, здоровʼя мозку і задач планувальника - копії цього
 * шматка вже розходились (одна без drain, інша без гейта TELEGRAM_CHAT_ID).
 * Збій черги не кидає: алерт - не привід зламати задачу, що його шле.
 * @param {Env} env
 * @param {string} text
 * @param {number} nowMs
 * @returns {Promise<boolean>} true = покладено в чергу
 */
export async function sendSystemAlert(env, text, nowMs) {
  if (!env.TELEGRAM_CHAT_ID) {
    console.error('alert: TELEGRAM_CHAT_ID відсутній - нікуди слати:', text);
    return false;
  }
  try {
    await enqueueOutbox(
      env,
      {
        chatId: env.TELEGRAM_CHAT_ID,
        threadId: env.TOPIC_SYSTEM ?? null,
        kind: 'send',
        payload: { text },
      },
      nowMs,
    );
  } catch (/** @type {any} */ e) {
    console.error('alert: не покладено в чергу', e?.message);
    return false;
  }
  await drainOutbox(env, { nowMs }).catch(() => {});
  return true;
}

/**
 * Текстовий документ у чат/тред через чергу з негайним драйном (best-effort:
 * збій драйну лишає ряд sweeper-у, у лог). Один вхід для експорту колекції,
 * звіту аналізу ідеї й результату працівника.
 * @param {Env} env
 * @param {{ chatId: number | string, threadId: number | string | null }} target
 * @param {{ filename: string, content: string, caption?: string, reply_markup?: unknown }} doc
 * @param {number} nowMs
 */
export async function sendDocument(env, target, doc, nowMs) {
  await enqueueOutbox(
    env,
    { chatId: target.chatId, threadId: target.threadId, kind: 'document', payload: { ...doc } },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
    console.error('outbox: драйн документа впав (sweeper добере)', e?.message),
  );
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
  // fallback_send - наш прапорець, не поле Bot API: зрізаємо до виклику.
  const fallbackSend = payload.fallback_send === true;
  delete payload.fallback_send;
  // plain_text - теж службове: оригінал Markdown для фолбеку розмітки, щоб
  // власник не побачив голі <b>-теги замість тексту.
  const plainText = typeof payload.plain_text === 'string' ? payload.plain_text : null;
  delete payload.plain_text;
  const base = {
    chat_id: row.chat_id,
    // editMessageText адресує повідомлення за message_id; тема йому не
    // потрібна, і статусний шлях її ніколи не передавав.
    ...(row.kind === 'edit' ? {} : { message_thread_id: row.thread_id ?? undefined }),
  };
  const attempt = (/** @type {Record<string, unknown>} */ body) => {
    if (row.kind === 'document') return tgApi(env, 'sendDocument', documentForm(row, body));
    const method =
      row.kind === 'edit'
        ? 'editMessageText'
        : row.kind === 'contact'
          ? 'sendContact'
          : row.kind === 'venue'
            ? 'sendVenue'
            : 'sendMessage';
    return tgApi(env, method, { ...base, ...body });
  };

  // body - те, що реально пішло останнім: після відмови розмітки це plain,
  // і гілка «чернетки немає» нижче мусить слати САМЕ його, не HTML знову.
  let body = payload;
  let res = await attempt(body);
  if (!res.ok && isParseEntitiesError(res.status, res.text) && payload.parse_mode) {
    const plain = { ...payload };
    if (plainText != null) plain.text = plainText;
    delete plain.parse_mode;
    body = plain;
    res = await attempt(body);
  }
  if (res.ok) {
    // Нове повідомлення - у ring-buffer /clear (борг етапу 1: канал outbox не
    // трекався, тож відповіді асистента переживали очищення).
    if (row.kind === 'send' || row.kind === 'contact' || row.kind === 'venue') {
      await trackOutboxSend(env, row, res);
    }
    return { ok: true };
  }
  // Редагування в той самий текст - уже доставлено, не збій (див.
  // isNotModifiedError): інакше ряд пішов би в ретраї й failed на відповіді,
  // яку власник давно бачить.
  if (row.kind === 'edit' && isNotModifiedError(res.status, res.text)) return { ok: true };
  // Чернетки вже немає (власник стер статусник) - відповідь не сміє зникнути
  // разом із нею: шлемо її новим повідомленням, як робив би deliver без
  // чернетки. Для статусних партіалів прапорця немає, і вони тихо гаснуть -
  // саме так і треба, застарілий партіал окремим повідомленням не потрібен.
  if (row.kind === 'edit' && fallbackSend && isEditTargetGone(res.status, res.text)) {
    const asSend = { ...body };
    delete asSend.message_id;
    res = await tgApi(env, 'sendMessage', {
      chat_id: row.chat_id,
      message_thread_id: row.thread_id ?? undefined,
      ...asSend,
    });
    if (res.ok) {
      await trackOutboxSend(env, row, res);
      return { ok: true };
    }
  }
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
  // Кнопки під документом (етап 4: «Все одно запустити» під попереднім
  // аналізом) - multipart приймає reply_markup як JSON-рядок.
  if (payload.reply_markup) form.set('reply_markup', JSON.stringify(payload.reply_markup));
  form.set(
    'document',
    new Blob([String(payload.content ?? '')], { type: 'text/plain' }),
    String(payload.filename ?? 'document.txt'),
  );
  return form;
}

/**
 * Запамʼятати відправлене чергою повідомлення для /clear. Best-effort: збій
 * трекінгу не сміє валити доставку - це лише зручність очищення.
 * @param {Env} env
 * @param {OutboxRow} row
 * @param {{ text: string }} res
 */
async function trackOutboxSend(env, row, res) {
  try {
    const id = JSON.parse(res.text)?.result?.message_id;
    if (typeof id !== 'number') return;
    await putSentMessages(
      env,
      recordSentMessage(await loadSentMessages(env), row.chat_id, row.thread_id, id),
    );
  } catch (/** @type {any} */ e) {
    console.error('outbox: трекінг для /clear не вдався', e?.message);
  }
}
