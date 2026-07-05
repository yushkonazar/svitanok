// Worker: статика дашборда (ASSETS) + /briefing.json із KV + ТОЧНИЙ планувальник
// ранкового брифінгу (08:00 Київ -> GitHub workflow_dispatch) + DEAD-MAN'S-SWITCH
// (10:00 Київ: якщо KV не оновлено сьогодні -> алерт у Telegram). Той самий Worker
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

/** Київська дата "YYYY-MM-DD" (для порівняння «свіжості» брифінгу). */
function kyivDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Точний ранковий тригер: dispatch brief (без force -> нормальний guard). */
async function dispatchBrief(env) {
  if (!env.GH_DISPATCH_TOKEN) {
    console.error('GH_DISPATCH_TOKEN відсутній — dispatch пропущено');
    return;
  }
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
}

/** Dead-man's-switch: KV не оновлено сьогодні -> алерт у Telegram (тиха відмова видима). */
async function deadMansCheck(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_* відсутні — dead-man пропущено');
    return;
  }
  const raw = await env.BRIEFING.get('latest');
  const today = kyivDateKey();
  let fresh = false;
  try {
    const d = JSON.parse(raw ?? '{}');
    fresh = typeof d.generatedAt === 'string' && kyivDateKey(new Date(d.generatedAt)) === today;
  } catch {
    /* биття JSON -> вважаємо несвіжим -> алерт */
  }
  if (fresh) return; // брифінг сьогодні є — усе добре

  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: '⚠️ Свiтанок: ранковий брифінг сьогодні не доставлено (KV не оновлено). Перевір GitHub Actions → workflow «brief».',
    }),
  });
  if (!resp.ok) {
    console.error('dead-man alert failed', resp.status, await resp.text());
  }
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

  // Cron у UTC покриває обидва DST-зсуви; за київською годиною обираємо дію:
  //   08:00 -> точний dispatch брифінгу;  10:00 -> dead-man-перевірка.
  // GitHub-schedule у brief.yml лишається резервом (пізно, але без дубля завдяки
  // guard-ідемпотентності).
  async scheduled(_event, env, ctx) {
    const h = kyivHour();
    if (h === 8) ctx.waitUntil(dispatchBrief(env));
    else if (h === 10) ctx.waitUntil(deadMansCheck(env));
  },
};
