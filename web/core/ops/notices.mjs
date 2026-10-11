import { assistantHomeTarget } from '../tg/home.mjs';
import { cachedGoogleAudit } from '../google-scopes.mjs';
/** @param {Env} env @param {string|number} chatId */
function settingsButton(env, chatId) {
  const text = 'Переглянути доступи';
  const name = String(env.TELEGRAM_BOT_USERNAME ?? '')
    .trim()
    .replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(name))
    return { text, url: `https://t.me/${name}?startapp=access` };
  if (!env.MINI_APP_URL || Number(chatId) <= 0) return null;
  try {
    const url = new URL(env.MINI_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    if (url.pathname === '/' || url.pathname === '/index.html') url.pathname = '/app/';
    url.hash = '/settings?panel=access';
    return { text, web_app: { url: url.href } };
  } catch {
    return null;
  }
}
/** Persistent claim + outbox enqueue, atomically. No marking a failed send as done.
 * @param {Env} env @param {string} id @param {string} text @param {number} nowMs
 * @param {{id:string,version:number,expiresAt?:string|null,rotatedAt?:string|null,rotateAfterDays?:number|null}|null} [credential]
 * @param {'expiry'|'rotation'|null} [kind] @param {{scopeState?:string}} [context] */
export async function queueOpsNotice(
  env,
  id,
  text,
  nowMs,
  credential = null,
  kind = null,
  context = {},
) {
  const home = assistantHomeTarget(env);
  if (!env.DB || !home) return false;
  const claim = crypto.randomUUID(),
    at = new Date(nowMs).toISOString();
  const guard = credential
    ? 'WHERE EXISTS(SELECT 1 FROM credential_metadata WHERE id=? AND version=?)'
    : '';
  const button = settingsButton(env, home.chatId);
  const payload = {
    text,
    reply_markup: { inline_keyboard: button ? [[button]] : [] },
    ...(context.scopeState ? { google_scope_notice: context.scopeState } : {}),
    ...(credential && kind
      ? {
          credential_notice: {
            id: credential.id,
            kind,
            expiresAt: credential.expiresAt,
            rotatedAt: credential.rotatedAt,
            rotateAfterDays: credential.rotateAfterDays,
          },
        }
      : {}),
  };
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO ops_notices(id,claim,at) SELECT ?,?,? ${guard}`).bind(
      id,
      claim,
      at,
      ...(credential ? [credential.id, credential.version] : []),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status)
      SELECT ?,?,?, 'send',?,0,?,'pending' WHERE EXISTS(SELECT 1 FROM ops_notices WHERE id=? AND claim=?)`,
    ).bind(
      `ops:${id}`,
      String(home.chatId),
      home.threadId == null ? null : String(home.threadId),
      JSON.stringify(payload),
      at,
      id,
      claim,
    ),
  ]);
  return Number(result[1]?.meta?.changes ?? 0) === 1;
}

/** @param {Env} env @param {unknown} state @param {number} nowMs */
export async function googleScopeNoticeCurrent(env, state, nowMs) {
  const audit = await cachedGoogleAudit(env, nowMs);
  return audit.verified && state === `${audit.extra.join(',')}|${audit.missing.join(',')}`;
}

/** Suppress stale queued dates, without exposing secret values or triggering OAuth.
 * @param {Env} env @param {any} notice */
export async function credentialNoticeCurrent(env, notice) {
  if (!env.DB || !notice || typeof notice.id !== 'string') return false;
  const row = await env.DB.prepare(
    'SELECT expires_at,rotated_at,rotate_after_days FROM credential_metadata WHERE id=?',
  )
    .bind(notice.id)
    .first();
  if (!row) return false;
  return notice.kind === 'expiry'
    ? row.expires_at === notice.expiresAt
    : notice.kind === 'rotation' &&
        row.rotated_at === notice.rotatedAt &&
        Number(row.rotate_after_days) === notice.rotateAfterDays;
}
