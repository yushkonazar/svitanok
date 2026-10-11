// Shared, allowlisted navigation contract. A link selects a view, never grants
// access or executes a command. Telegram startapp accepts only URL-safe data.
const ID = /^[A-Za-z0-9_=-]{1,120}$/;
const KINDS = ['payment', 'transaction'];

/** @param {string} kind @param {string} id */
export function financeStartParam(kind, id) {
  if (!KINDS.includes(kind) || !ID.test(id)) return null;
  const encoded = Array.from(id, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `finance_${kind}_${encoded}`;
}

/** @param {string} param */
export function financePathForStartParam(param) {
  if (param === 'finance') return '/finance';
  const match = /^finance_(payment|transaction)_([0-9a-f]{2,240})$/.exec(param);
  if (!match?.[1] || !match[2] || match[2].length % 2) return null;
  const id = match[2].replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16)));
  if (!ID.test(id)) return null;
  return `/finance?${match[1]}=${encodeURIComponent(id)}`;
}

/** @param {Env} env @param {string} text @param {string} kind @param {string} id @param {string|number|null} chatId */
export function financeMiniAppButton(env, text, kind, id, chatId) {
  const param = financeStartParam(kind, id);
  if (!param) return null;
  const username = String(env.TELEGRAM_BOT_USERNAME ?? '')
    .trim()
    .replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(username))
    return { text, url: `https://t.me/${username}?startapp=${param}` };
  // A plain URL in a group does not carry authenticated initData. Do not offer
  // an exact personal record that would instead open an unrelated demo.
  if (!env.MINI_APP_URL || chatId == null || Number(chatId) <= 0) return null;
  try {
    const url = new URL(env.MINI_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    if (url.pathname === '/' || url.pathname === '/index.html') url.pathname = '/app/';
    url.hash = financePathForStartParam(param) ?? '/finance';
    return { text, web_app: { url: url.href } };
  } catch {
    return null;
  }
}
