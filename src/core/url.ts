// Канонізація URL + зрізання ключів (§6 news, §19.4). Використовується:
//  - для дедупу новин (канонізувати ОБИДВА боки — фетчені й від LLM, §6 п.4);
//  - щоб у state/лог/повідомлення потрапляв лише ПУБЛІЧНИЙ URL без ключа (§8).

// Параметри-ключі (секрети), які треба ВИРІЗАТИ повністю (§19.4).
const SECRET_PARAM_KEYS = new Set([
  'appid', // OpenWeather
  'apikey',
  'api_key',
  'key',
  'token',
  'access_token',
  'auth',
  'secret',
  'client_secret',
]);

// Трекінг-параметри — теж прибираємо (стабільніший дедуп).
const TRACKING_PREFIXES = ['utm_'];
const TRACKING_KEYS = new Set([
  'fbclid',
  'gclid',
  'yclid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  'spm',
]);

function shouldDrop(key: string): boolean {
  const k = key.toLowerCase();
  if (SECRET_PARAM_KEYS.has(k)) return true;
  if (TRACKING_KEYS.has(k)) return true;
  return TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Канонічна, безключова, стабільна форма URL:
 *  - нижній регістр схеми й хоста;
 *  - вирізані ключі (appid/apikey/token/...) і трекінг (utm_*, fbclid, ...);
 *  - решта query відсортована (стабільність для дедупу);
 *  - прибрано fragment (#...) і трейлінг-слеш (крім кореня).
 * Невалідний URL повертається як є (trim) — рішення про відкидання вище за стеком.
 */
export function canonicalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input.trim();
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (!shouldDrop(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  u.search = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString();
}

/** Чи це той самий URL після канонізації обох боків (дедуп, §6 п.4). */
export function sameUrl(a: string, b: string): boolean {
  return canonicalizeUrl(a) === canonicalizeUrl(b);
}
