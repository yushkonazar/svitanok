/** @param {string} param */
export function weeklyReportPathForStartParam(param) {
  if (param === 'weekly-report') return '/weekly-report';
  const match = /^weekly_(\d{4})(\d{2})(\d{2})$/u.exec(param);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const instant = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date)
    return null;
  return `/weekly-report?week=${date}`;
}
/** @param {Env} env @param {string|number} chatId @param {string} week */
export function weeklyOverviewButtons(env, chatId, week) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(week)) return [];
  const param = `weekly_${week.replaceAll('-', '')}`;
  const username = String(env.TELEGRAM_BOT_USERNAME ?? '')
    .trim()
    .replace(/^@/u, '');
  if (/^[A-Za-z0-9_]{5,32}$/u.test(username))
    return [[{ text: 'Відкрити огляд', url: `https://t.me/${username}?startapp=${param}` }]];
  if (Number(chatId) <= 0 || !env.MINI_APP_URL) return [];
  try {
    const url = new URL(env.MINI_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return [];
    if (url.pathname === '/' || url.pathname === '/index.html') url.pathname = '/app/';
    url.search = '';
    url.hash = weeklyReportPathForStartParam(param) ?? '/weekly-report';
    return [[{ text: 'Відкрити огляд', web_app: { url: url.href } }]];
  } catch {
    return [];
  }
}
