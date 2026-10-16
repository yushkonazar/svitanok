/** @param {string} param */
export function planPathForStartParam(param) {
  if (param === 'plan') return '/plan';
  if (/^plan_date_\d{4}-\d{2}-\d{2}$/.test(param)) {
    const date = param.slice(10),
      ms = Date.parse(date);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date
      ? `/plan?date=${date}`
      : null;
  }
  if (/^plan_task_[a-zA-Z0-9_-]{1,100}$/.test(param))
    return `/plan?task=${encodeURIComponent(param.slice(10))}`;
  return null;
}
/** @param {Env} env @param {string} param @param {string|number} chatId */
export function planButton(env, param, chatId) {
  if (!planPathForStartParam(param)) return null;
  const username = String(env.TELEGRAM_BOT_USERNAME ?? '')
    .trim()
    .replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(username))
    return { text: 'Відкрити план', url: `https://t.me/${username}?startapp=${param}` };
  if (!env.MINI_APP_URL || Number(chatId) <= 0) return null;
  try {
    const url = new URL(env.MINI_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.pathname = '/app/';
    url.hash = planPathForStartParam(param) ?? '/plan';
    return { text: 'Відкрити план', web_app: { url: url.href } };
  } catch {
    return null;
  }
}
