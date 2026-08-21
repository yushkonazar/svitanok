/* Telegram WebApp initData для HTTP-тестів (M9).
 *
 * ⚠️ НАВІЩО СПІЛЬНИЙ ФАЙЛ, а не шість копій. Це не боротьба за рядки: копії
 * підписують запити ТИМ САМИМ алгоритмом, що перевіряє `validateInitData`, і
 * розбіжність між ними — це тест, який доводить не те, що думає автор. Найгірший
 * варіант тихий: копія з іншим порядком полів чи іншим кодуванням підпису дала б
 * «валідний» initData, якого прод не прийняв би, — і навпаки.
 *
 * Алгоритм дослівно той самий, що в `web/auth-core.mjs`: HMAC-SHA256 на
 * секреті `HMAC("WebAppData", botToken)`, поля відсортовані, підпис у hex.
 */

export interface InitDataOptions {
  /** Мітка часу підпису (секунди). Дефолт — «зараз»; менше — щоб протухло. */
  authDateSec?: number;
  /** Імʼя користувача в полі `user`. На перевірку не впливає — лише на вміст. */
  firstName?: string;
  /** Додаткові поля в initData (напр. `start_param`). Підписуються разом з рештою. */
  extra?: Record<string, string>;
}

async function hmac(keyBytes: Uint8Array, msgBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

/** Підписаний initData для `userId`. Повертає рядок у форматі query-параметрів. */
export async function buildInitData(
  userId: number,
  botToken: string,
  opts: InitDataOptions = {},
): Promise<string> {
  const { authDateSec, firstName = 'O', extra = {} } = opts;
  const params = new URLSearchParams({
    user: JSON.stringify({ id: userId, first_name: firstName }),
    auth_date: String(authDateSec ?? Math.floor(Date.now() / 1000)),
    ...extra,
  });
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
  const sig = await hmac(secret, enc.encode(dataCheck));
  params.set('hash', [...sig].map((b) => b.toString(16).padStart(2, '0')).join(''));
  return params.toString();
}
