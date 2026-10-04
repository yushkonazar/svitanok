// Persistent claims survive outbox retention. Queue and claim commit together;
// the existing outbox sweeper owns Telegram delivery and retries.
import { kyivParts } from './planning.mjs';
import { fixedDebtPayment } from './payments.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import { loadSettings } from '../../kv-store.mjs';
import { isQuietMinute } from '../../settings-core.mjs';
import { shouldDeliverProactive } from '../assistant-controls.mjs';

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

/** Remind once before, on, and after the due date; never mark a bill paid.
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
    "SELECT * FROM finance_payments WHERE status='active' ORDER BY next_date LIMIT 200",
  )
    .bind()
    .all();
  let queued = 0;
  for (const row of results ?? []) {
    const days = Math.round(
      (Date.parse(`${row.next_date}T00:00:00Z`) - Date.parse(`${time.date}T00:00:00Z`)) / 86400000,
    );
    if (!Number.isFinite(days) || days > Number(row.remind_days)) continue;
    const phase = days > 0 ? 'before' : days === 0 ? 'due' : 'overdue';
    const when = days > 0 ? `Через ${days} дн.` : days === 0 ? 'Сьогодні' : 'Платіж прострочений';
    const name = String(row.name)
      .split('')
      .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char))
      .join('')
      .slice(0, 100);
    const nextPayment = fixedDebtPayment({
      amountMinor: Number(row.amount_minor),
      remainingMinor: row.remaining_minor == null ? null : Number(row.remaining_minor),
      overpaymentRemainingMinor:
        row.overpayment_remaining_minor == null ? null : Number(row.overpayment_remaining_minor),
      installmentsLeft: row.installments_left == null ? null : Number(row.installments_left),
    });
    const amount = ((nextPayment?.amountMinor ?? Number(row.amount_minor)) / 100).toLocaleString(
      'uk-UA',
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      },
    );
    if (
      await queueMiniAppNotice(
        env,
        `payment:${row.id}:${row.next_date}:${phase}`,
        `${when}: ${name} · ${amount} ₴. Перевір платіж у фінансах Світанку.`,
        nowMs,
      )
    )
      queued++;
    if (queued >= 10) break;
  }
  return { queued };
}
