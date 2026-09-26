// Read-only owner view over the deterministic Gmail triage cache. Raw bodies
// never enter this endpoint; output is capped metadata suitable for Mini App.
import { json } from './http-core.mjs';
import { checkOwnerRead } from './auth-core.mjs';
import { loadState } from './kv-store.mjs';

const MAX_ITEMS = 20;
const MAX_TEXT = 180;
/** @param {unknown} value */
const safe = (value) =>
  String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, MAX_TEXT);

/** @param {any} raw */
export function mailAttentionView(raw) {
  const candidates = Array.isArray(raw?.candidates) ? raw.candidates : [];
  return candidates
    .filter(
      (/** @type {any} */ item) => item && typeof item.id === 'string' && item.attention?.level,
    )
    .sort(
      (/** @type {any} */ a, /** @type {any} */ b) =>
        Number(b.attention.level === 'critical') - Number(a.attention.level === 'critical') ||
        (Number(b.atMs) || 0) - (Number(a.atMs) || 0),
    )
    .slice(0, MAX_ITEMS)
    .map((/** @type {any} */ item) => ({
      id: item.id,
      from: safe(item.from),
      subject: safe(item.subject) || '(без теми)',
      atMs: Number.isFinite(item.atMs) ? item.atMs : null,
      level: item.attention.level === 'critical' ? 'critical' : 'attention',
      reasons: Array.isArray(item.attention.reasons)
        ? item.attention.reasons
            .filter((/** @type {unknown} */ x) => typeof x === 'string')
            .slice(0, 4)
        : [],
      gmailUrl: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(item.id)}`,
    }));
}

/** @param {Request} request @param {Env} env */
export async function handleMailAttention(request, env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const state = await loadState(env);
  const triage = state.mailTriage && typeof state.mailTriage === 'object' ? state.mailTriage : {};
  return json({
    ok: true,
    lastRunMs: Number.isFinite(triage.lastRunMs) ? triage.lastRunMs : null,
    items: mailAttentionView(triage),
  });
}
