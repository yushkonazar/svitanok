// Read-only owner view over the deterministic Gmail triage cache. Raw bodies
// never enter this endpoint; output is capped metadata suitable for Mini App.
import { json } from './http-core.mjs';
import { checkOwnerRead } from './auth-core.mjs';
import { loadState } from './kv-store.mjs';

const MAX_ITEMS = 20;
const MAX_TEXT = 180;
const MAIL_CANDIDATE_TTL_MS = 3 * 86_400_000;
const MAIL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REASON_LABELS = Object.freeze({
  interview_or_deadline: 'співбесіда або дедлайн',
  time_sensitive: 'терміново за текстом листа',
  job_signal: 'сигнал щодо вакансії',
});
const reasonLabels = /** @type {Record<string, string>} */ (REASON_LABELS);
/** @param {unknown} value */
const safe = (value) =>
  String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, MAX_TEXT);

/** @param {unknown} value */
const safeMailId = (value) => (typeof value === 'string' && MAIL_ID_RE.test(value) ? value : null);

/** @param {unknown} value */
const attentionReasons = (value) =>
  Array.isArray(value)
    ? [...new Set(value.filter((x) => typeof x === 'string' && x in REASON_LABELS))].slice(0, 4)
    : [];

/** @param {string} id */
const gmailUrl = (id) => `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;

/** @param {any} raw @param {number|null} [nowMs] */
export function mailAttentionView(raw, nowMs = null) {
  const candidates = Array.isArray(raw?.candidates) ? raw.candidates : [];
  const cutoff = Number.isFinite(nowMs) ? Number(nowMs) - MAIL_CANDIDATE_TTL_MS : null;
  return candidates
    .filter(
      (/** @type {any} */ item) =>
        item &&
        safeMailId(item.id) &&
        (item.attention?.level === 'critical' || item.attention?.level === 'attention') &&
        (cutoff == null || (Number.isFinite(item.atMs) && Number(item.atMs) >= cutoff)),
    )
    .sort(
      (/** @type {any} */ a, /** @type {any} */ b) =>
        Number(b.attention.level === 'critical') - Number(a.attention.level === 'critical') ||
        (Number(b.atMs) || 0) - (Number(a.atMs) || 0),
    )
    .slice(0, MAX_ITEMS)
    .map((/** @type {any} */ item) => {
      const id = /** @type {string} */ (safeMailId(item.id));
      const url = gmailUrl(id);
      return {
        id,
        from: safe(item.from),
        subject: safe(item.subject) || '(без теми)',
        atMs: Number.isFinite(item.atMs) ? item.atMs : null,
        level: item.attention.level === 'critical' ? 'critical' : 'attention',
        reasons: attentionReasons(item.attention.reasons),
        // Це citation, не дія: перейти до повідомлення може лише власник у
        // власному Gmail. У URL ніколи не підставляється текст листа.
        citation: { source: 'gmail_message', messageId: id, url },
        // Сумісність для майбутнього клієнта, що вже читатиме цей endpoint.
        gmailUrl: url,
      };
    });
}

/**
 * Короткий deterministic підсумок для власника/асистента. Свідомо не містить
 * from, subject, snippet або вигаданого пояснення: самі листи лишаються
 * зовнішнім tainted-вмістом, доступним лише за явним читанням.
 * @param {ReturnType<typeof mailAttentionView>} items
 */
export function mailAttentionSummary(items) {
  const critical = items.filter((/** @type {any} */ item) => item.level === 'critical').length;
  const reasons = /** @type {Record<string, number>} */ ({});
  for (const item of items) {
    for (const reason of item.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const reasonSummary = Object.entries(reasons)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({ code: reason, label: reasonLabels[reason], count }));
  return {
    total: items.length,
    critical,
    attention: items.length - critical,
    reasons: reasonSummary,
    text: items.length
      ? `Пошта: ${critical} критичних, ${items.length - critical} потребують уваги.`
      : 'Пошта: нових сигналів уваги немає.',
  };
}

/** @param {Request} request @param {Env} env */
export async function handleMailAttention(request, env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const state = await loadState(env);
  const triage = state.mailTriage && typeof state.mailTriage === 'object' ? state.mailTriage : {};
  const items = mailAttentionView(triage, Date.now());
  return json({
    ok: true,
    lastRunMs: Number.isFinite(triage.lastRunMs) ? triage.lastRunMs : null,
    // Контракт read-only: поштовий вміст не стає довіреною інструкцією, а
    // reply/archive/send не мають ані endpoint-а, ані Google scope.
    tainted: true,
    mode: 'read_only',
    summary: mailAttentionSummary(items),
    items,
  });
}
