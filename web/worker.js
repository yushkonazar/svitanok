// Worker: статика дашборда (ASSETS) + /briefing.json із KV + ТОЧНИЙ планувальник
// ранкового брифінгу (scheduled -> GitHub workflow_dispatch). Той самий Worker
// згодом отримає API для A2-інтерактиву (Telegram-вебхук).

const GH_DISPATCH_URL =
  'https://api.github.com/repos/yushkonazar/svitanok/actions/workflows/brief.yml/dispatches';

/** Київська година (0..23) зараз, з урахуванням DST через Intl. */
function kyivHour(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hour12: false,
  }).format(now);
  return Number(h);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/briefing.json') {
      const data = await env.BRIEFING.get('latest');
      return new Response(data ?? '{}', {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      });
    }
    return env.ASSETS.fetch(request); // статичні файли (дашборд)
  },

  // Точний тригер: cron у UTC (05:00+06:00) покриває обидва DST-зсуви; хендлер
  // пускає dispatch ЛИШЕ коли в Києві саме 08:00 -> рівно один запуск/день.
  // GitHub-schedule у brief.yml лишається резервом (спрацьовує пізно, але guard-
  // ідемпотентність не дасть дубль). Без --force -> guard сам вирішує (вікно+ідемп.).
  async scheduled(_event, env, ctx) {
    if (kyivHour() !== 8) return; // «не та» cron-година (резервна) — ігноруємо
    if (!env.GH_DISPATCH_TOKEN) {
      console.error('GH_DISPATCH_TOKEN відсутній — dispatch пропущено');
      return;
    }
    const run = async () => {
      const resp = await fetch(GH_DISPATCH_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'svitanok-scheduler',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }), // без inputs.force -> нормальний guard
      });
      if (!resp.ok) {
        console.error('workflow_dispatch failed', resp.status, await resp.text());
      }
    };
    ctx.waitUntil(run());
  },
};
