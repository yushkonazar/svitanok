// Безпечна зовнішня адреса: те, що ядро дозволяє віддати моделі як «сторінку,
// яку можна відкрити».
//
// ⚠️ ЗВІДКИ ВЗАГАЛІ БЕРЕТЬСЯ АДРЕСА. `websiteUri` у картці закладу пише той,
// хто цю картку завів, - за моделлю загроз проєкту це недовірений вхід. Ядро ж
// саме радить моделі віддати цей URL Дослідникові, а той має WebFetch і
// крутиться на тому самому VPS, що й хост: без фільтра шлях від чужих даних до
// запиту у внутрішню мережу виходить автоматичним.

/** Хости, на які «сайт закладу» вести не може за визначенням. */
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** Суфікси службових зон. */
const BLOCKED_SUFFIX = ['.internal', '.local', '.localhost', '.home.arpa'];

/**
 * Приватні й службові діапазони IPv4: 10/8, 127/8, 169.254/16 (метадані
 * хостера!), 172.16-31/12, 192.168/16.
 * @param {string} host
 */
function privateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[3]), Number(m[4])].some((n) => n > 255) || b > 255) return true;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Лише http(s), лише публічний хост, без вбудованих облікових даних.
 *
 * ⚠️ Це НЕ повний захист від SSRF: редирект з публічної адреси на внутрішню
 * фільтр не бачить - його має різати той, хто виконує запит. Тут закривається
 * рівно те, що в межах ядра: щоб ядро САМО не запропонувало внутрішню адресу.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function safeHttpUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // `https://user:pass@…` - спосіб і замаскувати справжній хост, і протягнути
  // чужі облікові дані в запит Дослідника.
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  if (BLOCKED_HOSTS.has(host)) return null;
  if (BLOCKED_SUFFIX.some((s) => host.endsWith(s))) return null;
  if (privateIpv4(host)) return null;
  // IPv6-літерал у квадратних дужках: публічних сайтів так не адресують, а
  // ::1 і fc00::/7 саме так і виглядають.
  if (host.startsWith('[')) return null;
  // Хост без крапки - це або внутрішнє імʼя, або помилка.
  if (!host.includes('.')) return null;
  return u.toString();
}
