// Actual owner-supplied deadlines only. Unknown dates and recommended policy
// ages are not failed/expired keys. Read-only Google evidence is cached.
import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { readCredentials } from './credentials.mjs';
import { queueOpsNotice } from './notices.mjs';
import { cachedGoogleAudit, extraScopesAlertText } from '../google-scopes.mjs';

export const SECRET_EXPIRY_HOUR = 10;
export const SECRET_EXPIRY_MARKER = 'secretExpiryDay';
/** @param {number|null} days */
function stage(days) {
  return days == null || days > 30 ? null : days <= 0 ? 0 : days <= 7 ? 7 : 30;
}
/** @param {string} location */
const where = (location) =>
  /** @type {Record<string,string>} */ ({
    cloudflare: 'Cloudflare',
    vps: 'сервер',
    github: 'GitHub',
    offline: 'офлайн-копія',
  })[location] ?? location;
/** @param {Env} env @param {number} [nowMs] */
export async function secretExpiryTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs),
    today = kyivDateKey(now);
  if (kyivHour(now) !== SECRET_EXPIRY_HOUR) return { skipped: 'hour' };
  if ((await env.BRIEFING.get(SECRET_EXPIRY_MARKER)) === today) return { skipped: 'done' };
  if (!env.DB) return { skipped: 'no-db' };
  const registry = await readCredentials(env, nowMs);
  if (!registry.available) return { skipped: 'metadata-unavailable' };
  let reminded = 0;
  for (const entry of registry.entries) {
    const expiryStage = stage(entry.expiryDaysLeft),
      rotationStage = stage(entry.rotationDaysLeft);
    if (expiryStage != null && entry.expiresAt) {
      const text = `🔑 ${entry.label} (${where(entry.location)}): ${entry.expiryDaysLeft === 0 ? 'вказана дата завершення — сьогодні' : expiryStage === 0 ? 'вказаний строк дії вже завершився' : `строк дії до ${entry.expiresAt}`}. Перевір цей доступ у налаштуваннях Світанку.`;
      if (
        await queueOpsNotice(
          env,
          `credential:${entry.id}:expiry:${entry.expiresAt}:${expiryStage}`,
          text,
          nowMs,
          entry,
          'expiry',
        )
      )
        reminded++;
    } else if (rotationStage != null && entry.rotatedAt && entry.rotateAfterDays) {
      const text = `🔑 ${entry.label} (${where(entry.location)}): час перевірити обране тобою нагадування про ротацію. Це не означає, що ключ перестав працювати.`;
      if (
        await queueOpsNotice(
          env,
          `credential:${entry.id}:rotation:${entry.rotatedAt}:${entry.rotateAfterDays}:${rotationStage}`,
          text,
          nowMs,
          entry,
          'rotation',
        )
      )
        reminded++;
    }
  }
  const audit = await cachedGoogleAudit(env, nowMs);
  let scopes = audit.known ? 'ok' : 'unknown';
  if (audit.verified && (audit.extra.length || audit.missing.length)) {
    const state = `${audit.extra.join(',')}|${audit.missing.join(',')}`;
    const cycle = Math.floor(nowMs / (30 * 86400000));
    const prefix = `google-scopes:${state}:`;
    const last = await env.DB.prepare(
      'SELECT at FROM ops_notices WHERE substr(id,1,length(?))=? ORDER BY at DESC LIMIT 1',
    )
      .bind(prefix, prefix)
      .first();
    if (last && nowMs - Date.parse(String(last.at)) < 30 * 86400000) {
      await env.BRIEFING.put(SECRET_EXPIRY_MARKER, today);
      return {
        reminded,
        unknown: registry.entries.filter((entry) => entry.expiryKind === 'unknown').length,
        scopes: 'quiet',
      };
    }
    const text = audit.missing.length
      ? '⚠️ Частині можливостей Google бракує дозволів. Переглянь підключення в налаштуваннях Світанку; автоматично доступи не змінював.'
      : extraScopesAlertText(audit.extra);
    const queued = await queueOpsNotice(
      env,
      `google-scopes:${state}:${cycle}`,
      text,
      nowMs,
      null,
      null,
      { scopeState: state },
    );
    scopes = queued ? (audit.missing.length ? 'missing' : 'extra') : 'quiet';
  }
  await env.BRIEFING.put(SECRET_EXPIRY_MARKER, today);
  return {
    reminded,
    unknown: registry.entries.filter((entry) => entry.expiryKind === 'unknown').length,
    scopes,
  };
}
