// Worker: статика дашборда (ASSETS) + /briefing.json із KV + ТОЧНИЙ планувальник
// (08:00 Київ -> GitHub workflow_dispatch) + DEAD-MAN'S-SWITCH (10:00 Київ) +
// /api/vote (👍/👎 з дашборда -> preferenceWeights у KV, автентифікація через
// Telegram WebApp initData). Стан — KV namespace BRIEFING, ключі `latest`/`state`.

const GH_DISPATCH_URL =
  'https://api.github.com/repos/yushkonazar/svitanok/actions/workflows/brief.yml/dispatches';

// preferenceWeights (дзеркало src/modules/news.ts — Worker не імпортує TS).
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 2.0;
const WEIGHT_STEP = 0.15;
const clampWeight = (w) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
function applyVote(weights, category, dir) {
  const cur = weights[category] ?? 1.0;
  return { ...weights, [category]: clampWeight(cur + (dir === 'up' ? WEIGHT_STEP : -WEIGHT_STEP)) };
}

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

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// --- Telegram WebApp initData validation (HMAC-SHA256, WebCrypto) ---
async function hmac(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}
const toHex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Перевіряє initData за алгоритмом Telegram; повертає {user} або null. */
async function validateInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
  const computed = toHex(await hmac(secret, enc.encode(dataCheck)));
  if (computed !== hash) return null;
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // старіше 24 год
  try {
    return { user: JSON.parse(params.get('user') ?? 'null') };
  } catch {
    return { user: null };
  }
}

/** POST /api/vote {category, dir, initData} -> оновити preferenceWeights у KV. */
async function handleVote(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  const { category, dir, initData } = body ?? {};
  if (typeof category !== 'string' || !category || (dir !== 'up' && dir !== 'down')) {
    return json({ ok: false, error: 'bad-params' }, 400);
  }
  const v = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!v) return json({ ok: false, error: 'auth' }, 401);
  // Одноосібний бот: голосувати може лише власник (user.id == chat_id приватного чату).
  if (env.TELEGRAM_CHAT_ID && v.user && String(v.user.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  let state = {};
  try {
    const parsed = JSON.parse((await env.BRIEFING.get('state')) ?? '{}');
    if (parsed && typeof parsed === 'object') state = parsed;
  } catch {
    /* биття JSON -> порожній стан */
  }
  const weights = applyVote(state.preferenceWeights ?? {}, category, dir);
  state.preferenceWeights = weights;
  await env.BRIEFING.put('state', JSON.stringify(state));
  return json({ ok: true, category, weight: weights[category] });
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

/** Dead-man's-switch: KV не оновлено сьогодні -> алерт у Telegram. */
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
  if (fresh) return;

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
      // ?date=YYYY-MM-DD -> історичний брифінг; інакше — latest.
      const date = url.searchParams.get('date');
      const key = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `briefing:${date}` : 'latest';
      const data = await env.BRIEFING.get(key);
      return new Response(data ?? '{}', {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      });
    }
    if (url.pathname === '/api/history') {
      // Список наявних дат (для гортання в Mini App), новіші перші.
      const list = await env.BRIEFING.list({ prefix: 'briefing:' });
      const dates = list.keys
        .map((k) => k.name.slice('briefing:'.length))
        .sort()
        .reverse();
      return json({ dates });
    }
    if (url.pathname === '/api/vote' && request.method === 'POST') {
      return handleVote(request, env);
    }
    return env.ASSETS.fetch(request); // статичні файли (дашборд)
  },

  // Cron у UTC покриває обидва DST-зсуви; за київською годиною обираємо дію:
  //   08:00 -> точний dispatch брифінгу;  10:00 -> dead-man-перевірка.
  async scheduled(_event, env, ctx) {
    const h = kyivHour();
    if (h === 8) ctx.waitUntil(dispatchBrief(env));
    else if (h === 10) ctx.waitUntil(deadMansCheck(env));
  },
};
