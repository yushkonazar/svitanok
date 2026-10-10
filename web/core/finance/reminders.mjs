// Persistent claims survive outbox retention. Queue and claim commit together;
// the existing outbox sweeper owns Telegram delivery and retries.
import { kyivParts, shiftDate } from './planning.mjs';
import { fixedDebtPayment, interestDebtPayment } from './payments.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import { loadSettings } from '../../kv-store.mjs';
import { isQuietMinute } from '../../settings-core.mjs';
import { shouldDeliverProactive } from '../assistant-controls.mjs';
import { financeMiniAppButton } from './links.mjs';
import { cleanSource } from '../format.mjs';

/** @param {Env} env */
export async function readMiniAppNotificationSettings(env) {
  if (!env.DB) return null;
  const exists = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='finance_settings'",
  )
    .bind()
    .first();
  if (!exists) return null;
  return env.DB.prepare(
    "SELECT payment_reminders, checkin_reminders FROM finance_settings WHERE id='owner'",
  )
    .bind()
    .first();
}

/** @param {Env} env @param {string} id @param {string} text @param {number} nowMs */
export async function queueMiniAppNotice(env, id, text, nowMs) {
  const home = assistantHomeTarget(env);
  if (!env.DB || !home) return false;
  const claim = crypto.randomUUID(),
    at = new Date(nowMs).toISOString();
  const result = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO finance_notices(id,claim,at) VALUES(?,?,?)').bind(
      id,
      claim,
      at,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status)
      SELECT ?,?,?, 'send',?,0,?,'pending' WHERE EXISTS(SELECT 1 FROM finance_notices WHERE id=? AND claim=?)`,
    ).bind(
      `mini-app:${id}`,
      String(home.chatId),
      home.threadId == null ? null : String(home.threadId),
      JSON.stringify({ text }),
      at,
      id,
      claim,
    ),
  ]);
  return Number(result[1]?.meta?.changes ?? 0) > 0;
}

/** Only confirmed schedules; missing confirmation is not a failed bank debit.
 * Individual claims and one consolidated message commit atomically. The payment
 * is rechecked inside the batch, so a concurrently confirmed bill is omitted.
 * @param {Env} env @param {any[]} notices @param {number} nowMs */
export async function queuePaymentAttention(env, notices, nowMs) {
  const home = assistantHomeTarget(env);
  if (!env.DB || !home || !notices.length) return 0;
  const db = env.DB;
  const claim = crypto.randomUUID(),
    at = new Date(nowMs).toISOString();
  const statements = notices.map((notice) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO finance_notices(id,claim,at)
     SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM finance_payments WHERE id=? AND next_date=? AND status='active')`,
      )
      .bind(notice.id, claim, at, notice.paymentId, notice.date),
  );
  statements.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status)
     SELECT ?,?,?,'send',json_object(
       'text','Оплату ще не підтверджено в обліку:' || char(10) || group_concat(json_extract(j.value,'$.text'),char(10)),
       'reply_markup',json_object('inline_keyboard',json_group_array(json_extract(j.value,'$.buttons')) FILTER (WHERE json_type(j.value,'$.buttons')='array'))
     ),0,?,'pending' FROM json_each(?) j
     JOIN finance_notices n ON n.id=json_extract(j.value,'$.id') AND n.claim=? HAVING count(*)>0`,
      )
      .bind(
        `mini-app:payments:${claim}`,
        String(home.chatId),
        home.threadId == null ? null : String(home.threadId),
        at,
        JSON.stringify(notices),
        claim,
      ),
  );
  const result = await env.DB.batch(statements);
  return result.slice(0, -1).reduce((total, item) => total + Number(item.meta?.changes ?? 0), 0);
}

/** Remind once from the day AFTER the due date; never mark a bill paid.
 * @param {Env} env @param {number} [nowMs] */
export async function miniAppPaymentRemindTask(env, nowMs = Date.now()) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !assistantHomeTarget(env))
    return { skipped: 'unconfigured' };
  const time = kyivParts(nowMs);
  if (time.hour !== 11) return { skipped: 'hour' };
  const preferences = await readMiniAppNotificationSettings(env);
  if (!preferences?.payment_reminders) return { skipped: 'disabled' };
  const [settings, attention] = await Promise.all([
    loadSettings(env),
    shouldDeliverProactive(env, 'nudge', nowMs),
  ]);
  if (isQuietMinute(settings, time.hour * 60 + time.minute) || !attention.deliver)
    return { skipped: 'quiet' };
  const { results } = await env.DB.prepare(
    `SELECT * FROM finance_payments p WHERE status='active' AND next_date < ?
     AND NOT EXISTS (SELECT 1 FROM finance_notices n WHERE n.id='payment:' || p.id || ':' || p.next_date || ':overdue')
     ORDER BY next_date,id LIMIT 10`,
  )
    .bind(time.date)
    .all();
  const notices = [];
  for (const row of results ?? []) {
    const days = Math.round(
      (Date.parse(`${row.next_date}T00:00:00Z`) - Date.parse(`${time.date}T00:00:00Z`)) / 86400000,
    );
    if (!Number.isFinite(days) || days >= 0) continue;
    try {
      if (shiftDate(String(row.next_date), 0) !== row.next_date) continue;
    } catch {
      continue;
    }
    const name = cleanSource(String(row.name), 80);
    const payment = {
      amountMinor: Number(row.amount_minor),
      remainingMinor: row.remaining_minor == null ? null : Number(row.remaining_minor),
      overpaymentRemainingMinor:
        row.overpayment_remaining_minor == null ? null : Number(row.overpayment_remaining_minor),
      installmentsLeft: row.installments_left == null ? null : Number(row.installments_left),
      totalMinor: row.total_minor == null ? null : Number(row.total_minor),
      interestMethod: row.interest_method == null ? null : String(row.interest_method),
      rateBps: Number(row.rate_bps ?? 0),
      feeMinor: Number(row.fee_minor ?? 0),
    };
    const nextPayment = interestDebtPayment(payment) ?? fixedDebtPayment(payment);
    const amount = ((nextPayment?.amountMinor ?? Number(row.amount_minor)) / 100).toLocaleString(
      'uk-UA',
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      },
    );
    const button = financeMiniAppButton(
      env,
      `${name.slice(0, 25)} · ${amount} ₴`,
      'payment',
      String(row.id),
      assistantHomeTarget(env)?.chatId ?? null,
    );
    notices.push({
      id: `payment:${row.id}:${row.next_date}:overdue`,
      paymentId: String(row.id),
      date: row.next_date,
      text: `• ${name} · ${amount} ₴ · ${String(row.next_date).slice(8)}.${String(row.next_date).slice(5, 7)}`,
      ...(button ? { buttons: [button] } : {}),
    });
  }
  return { queued: await queuePaymentAttention(env, notices, nowMs) };
}
