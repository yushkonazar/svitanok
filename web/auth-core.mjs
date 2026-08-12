// Авторизація Mini App і розмежування прав (Фаза 5, модуляризація worker.js).
//
// ЄДИНА безпекова поверхня дашборда: перевірка Telegram initData (HMAC-SHA256)
// і відповідь на два різні питання —
//   «кому можна ДИВИТИСЬ»  -> allowedUserIds / checkOwner
//   «кому можна МІНЯТИ»    -> isPrimaryOwner / checkPrimaryOwner (S1/B1)
//
// НАВІЩО ОКРЕМИЙ МОДУЛЬ. Доти ці ~85 рядків лежали посеред п'яти тисяч рядків
// I/O, і щоб побачити ВСІ місця, де вирішується доступ, треба було читати весь
// worker.js. Тепер відповідь на «чому цей запит пройшов» уміщається в один
// файл, а кожен інваріант нижче (fail-closed, константний час, 24-годинне
// вікно) тестується напряму.
//
// Інваріант, спільний для всього файлу: **fail-closed**. Не заданий токен,
// порожній список id, протухла підпис-дата — це ВІДМОВА, а не «ну добре».
// Причина в коментарях кожної функції: кожен із цих випадків колись міг би
// перетворити misconfig на відкриті двері.

import { constantTimeEqual } from './tg-core.mjs';

/* ── Telegram WebApp initData (HMAC-SHA256, WebCrypto) ─────────────────── */

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
export async function validateInitData(initData, botToken) {
  // ⚠️ Без цієї перевірки: enc.encode(undefined) -> порожній масив байтів,
  // тож секрет вироджується у HMAC("WebAppData", "") — публічну константу,
  // яку може порахувати БУДЬ-ХТО без знання токена. Не заданий токен (вікно
  // ротації секрету, битий конфіг) тоді тихо перетворює misconfig на fail-open
  // авторизацію, а не на fail-closed відмову.
  if (!initData || !botToken) return null;
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
  // Константночасно (не `!==`): звіряємо HMAC, тож не зливаємо позицію першого
  // розбіжного байта — той самий інваріант, що verifyWebhookSecret/timingSafeEqual.
  if (!constantTimeEqual(computed, hash)) return null;
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // старіше 24 год
  try {
    return { user: JSON.parse(params.get('user') ?? 'null') };
  } catch {
    return { user: null };
  }
}

/* ── Хто це і що йому можна ────────────────────────────────────────────── */

/**
 * Власник + опційно співвласники (TELEGRAM_COOWNER_USER_IDS, через кому) -> Set
 * рядкових id. Порожній Set (жодна змінна не задана) — навмисно: і checkOwner,
 * і вебхук тоді фейлять closed (нікому не довіряємо), а не open.
 *
 * ⚠️ Це список ЧИТАЧІВ, не других власників (S1). Мутації стану, агент і
 * команди керування вимагають isPrimaryOwner — див. нижче.
 *
 * Стара назва TELEGRAM_ALLOWED_USER_IDS лишається живою навмисно: секрети
 * синхронізовані у ДВОХ місцях (GitHub + Cloudflare), і якби код перестав її
 * читати в мить деплою, співвласник утратив би доступ до дашборда раніше, ніж
 * власник встиг би перейменувати змінну. Прибрати після перейменування.
 */
export function allowedUserIds(env) {
  const ids = new Set();
  if (env.TELEGRAM_OWNER_USER_ID) ids.add(String(env.TELEGRAM_OWNER_USER_ID));
  const coOwners = env.TELEGRAM_COOWNER_USER_IDS ?? env.TELEGRAM_ALLOWED_USER_IDS ?? '';
  for (const raw of String(coOwners).split(',')) {
    const id = raw.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * ГОЛОВНИЙ власник — рівно один id (TELEGRAM_OWNER_USER_ID) (S1/B1).
 *
 * Доти «дозволений учасник» означав «другий власник»: він читав пошту й настрій
 * власника, перезаписував settings і гео, приймав його календарні пропозиції й
 * запускав агента проти його Gmail. Список задумувався як «дай подивитись
 * дашборд», а давав повні права.
 *
 * Fail-closed: змінна не задана -> false (як і allowedUserIds, яка тоді віддає
 * порожній Set і нікого не пускає навіть читати).
 */
export function isPrimaryOwner(env, userId) {
  const owner = String(env.TELEGRAM_OWNER_USER_ID ?? '').trim();
  return Boolean(owner) && userId != null && String(userId) === owner;
}

/**
 * Валідація initData + дозволений учасник. -> {ok:true,user} або
 * {ok:false,status,error}. Звіряємо з allowedUserIds (персональні user id, НЕ
 * TELEGRAM_CHAT_ID — той тепер лише «куди слати», в супергрупі це вже
 * груповий id, ніколи не рівний user id людини). Fail-closed: жодного
 * дозволеного id не задано -> forbidden, не fail-open.
 */
export async function checkOwner(initData, env) {
  const v = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!v) return { ok: false, status: 401, error: 'auth' };
  const allowed = allowedUserIds(env);
  if (!allowed.size || !v.user || !allowed.has(String(v.user.id))) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: true, user: v.user };
}

/**
 * checkOwner + вимога бути головним власником — для ендпоінтів, що ПИШУТЬ у стан
 * власника (settings, гео, чек-ін/події, голоси) чи запускають від його імені
 * дії назовні. Читальні ендпоінти лишаються на checkOwner (S1: розділяємо
 * «подивитись» і «змінити»).
 */
export async function checkPrimaryOwner(initData, env) {
  const auth = await checkOwner(initData, env);
  if (!auth.ok) return auth;
  if (!isPrimaryOwner(env, auth.user?.id)) return { ok: false, status: 403, error: 'forbidden' };
  return auth;
}

/**
 * Auth для GET-читань дашборда: initData з заголовка X-Telegram-Init-Data
 * (НЕ query-param — персональні дані власника й hash не осідають у логах/URL).
 * Той самий власник-чек, що й POST-и (/api/vote|/api/event). Дашборд — дані
 * одного власника (події календаря, воронка вакансій, збережене), тож
 * читання НЕ публічне: без валідного initData -> 401/403, фронт деградує на SAMPLE.
 */
export async function checkOwnerRead(request, env) {
  return checkOwner(request.headers.get('X-Telegram-Init-Data'), env);
}
