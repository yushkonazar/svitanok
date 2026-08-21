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

/**
 * Користувач Telegram із initData.
 *
 * Перелічено рівно ті поля, які читає код. Форму приймаємо на віру НЕ з
 * недогляду: до цього місця підпис initData уже перевірено HMAC-ом на
 * bot-токені, тобто дані прийшли від Telegram, а не від викликача.
 * @typedef {{ id: number, first_name?: string, last_name?: string, username?: string,
 *             language_code?: string, is_premium?: boolean }} TelegramUser
 */

/**
 * Ухвала авторизації. Літеральні `true`/`false` тут ОБОВʼЯЗКОВІ: без них
 * виведення розширює `ok` до `boolean`, союз перестає розрізнятись, і
 * `checkPrimaryOwner` втрачає гарантію, що після `!auth.ok` лишився саме
 * успішний варіант із `user`.
 * @typedef {{ ok: true, user: TelegramUser }} AuthOk
 * @typedef {{ ok: false, status: number, error: string }} AuthFail
 * @typedef {AuthOk | AuthFail} AuthResult
 */

/**
 * Скільки живе підпис. 86400 — рівно те, що радить документація Telegram, і
 * саме стільки триває сесія Mini App: `auth_date` видається ОДИН раз на запуск
 * і не оновлюється, доки апку не перезапустили. Вужче вікно віддавало б 401
 * апці, відкритій довше за нього, без способу поновити підпис.
 */
const INIT_DATA_MAX_AGE_SEC = 86_400;

/**
 * Допуск на розбіжність годинників для дати З МАЙБУТНЬОГО.
 *
 * Мале й асиметричне навмисно: розбіжність годинника клієнта й Cloudflare —
 * це секунди, а не години. Усе, що далі, — не «трохи спішить», а підписана
 * дата, якої ще не було.
 */
const INIT_DATA_MAX_SKEW_SEC = 300;

/* ── Telegram WebApp initData (HMAC-SHA256, WebCrypto) ─────────────────── */

/**
 * @param {Uint8Array} keyBytes
 * @param {Uint8Array} msgBytes
 */
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

const toHex = (/** @type {Uint8Array} */ buf) =>
  [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Перевіряє initData за алгоритмом Telegram; повертає {user} або null.
 *
 * `botToken` — `unknown`, а не `string`: нижче він проходить через
 * `String(...).trim()` саме тому, що джерело (секрет Cloudflare) може бути й
 * незаданим, і з хвостовим переносом рядка.
 * @param {string|null|undefined} initData
 * @param {unknown} botToken
 * @returns {Promise<{ user: TelegramUser|null }|null>}
 */
export async function validateInitData(initData, botToken) {
  // ⚠️ Без цієї перевірки: enc.encode(undefined) -> порожній масив байтів,
  // тож секрет вироджується у HMAC("WebAppData", "") — публічну константу,
  // яку може порахувати БУДЬ-ХТО без знання токена. Не заданий токен (вікно
  // ротації секрету, битий конфіг) тоді тихо перетворює misconfig на fail-open
  // авторизацію, а не на fail-closed відмову.
  if (!initData) return null;
  // ⚠️ TRIM, а не просто перевірка на falsy — і це не косметика.
  //
  // Стара умова `!botToken` пропускала токен із самих ПРОБІЛІВ. Тоді секрет =
  // HMAC("WebAppData", " ") — не публічна константа, але простір кандидатів
  // мізерний (пробіл, два пробіли, перенос рядка, табуляція), а `user.id` в
  // initData підписант задає САМ (checkOwner нижче звіряє саме його). Тобто це
  // був не «не той секрет», а повний обхід авторизації Mini App при токені з
  // пробілів.
  //
  // Другий бік того самого: підписуємо ОБРІЗАНИМ токеном. Хвостовий перенос
  // рядка в секреті — задокументована пастка цього проєкту (копіювання з
  // панелі), і без trim він давав ІНШИЙ HMAC, тобто тихо клав авторизацію
  // дашборда цілком. src/core/secrets.ts трактує рядок із пробілів як
  // відсутній секрет — тепер поведінка збігається з обох боків.
  const token = String(botToken ?? '').trim();
  if (!token) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode('WebAppData'), enc.encode(token));
  const computed = toHex(await hmac(secret, enc.encode(dataCheck)));
  // Константночасно (не `!==`): звіряємо HMAC, тож не зливаємо позицію першого
  // розбіжного байта — той самий інваріант, що verifyWebhookSecret/timingSafeEqual.
  if (!constantTimeEqual(computed, hash)) return null;
  const authDate = Number(params.get('auth_date') ?? 0);
  // Вік підпису в секундах: додатний — у минулому, відʼємний — у майбутньому.
  const ageSec = Date.now() / 1000 - authDate;
  if (!authDate || ageSec > INIT_DATA_MAX_AGE_SEC) return null;
  // ⚠️ ДРУГИЙ БІК того самого вікна (SV-B3). Доти перевірялась лише верхня
  // межа, тож `auth_date` із майбутнього проходив без обмежень — заміряно на
  // +10 років. Підпис при цьому валідний: дату підписує той, хто підписує
  // initData, тобто вона НЕ доказ свіжості, доки її не звірили з обох боків.
  // Наслідок був конкретний: один такий initData ставав ключем без терміну
  // придатності — 24-годинне вікно для нього просто не наставало.
  if (ageSec < -INIT_DATA_MAX_SKEW_SEC) return null;
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
 *
 * Параметр звужено до ТРЬОХ полів, які функція справді читає, а не до всього
 * `Env`: вимагати від викликача 25 прив'язок заради трьох означало б, що жоден
 * тест не може покликати її без повного оточення — і кожен зробив би
 * приведення, тобто знову ніяких типів.
 * @param {Pick<Env, 'TELEGRAM_OWNER_USER_ID' | 'TELEGRAM_COOWNER_USER_IDS'
 *   | 'TELEGRAM_ALLOWED_USER_IDS'>} env
 * @returns {Set<string>}
 */
export function allowedUserIds(env) {
  /** @type {Set<string>} */
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
 * @param {Pick<Env, 'TELEGRAM_OWNER_USER_ID'>} env
 * @param {string|number|null|undefined} userId
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
 * @param {string|null|undefined} initData
 * @param {Env} env
 * @returns {Promise<AuthResult>}
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
 * @param {string|null|undefined} initData
 * @param {Env} env
 * @returns {Promise<AuthResult>}
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
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<AuthResult>}
 */
export async function checkOwnerRead(request, env) {
  return checkOwner(request.headers.get('X-Telegram-Init-Data'), env);
}

/**
 * initData МУТАЦІЇ: заголовок, а якщо його немає — поле в тілі (M3).
 *
 * Читання завжди ходили заголовком, мутації — полем у JSON. Різниці в безпеці
 * між ними немає (тіло так само не осідає в логах, на відміну від query), але
 * два різні шляхи до однієї перевірки — це два місця, де можна помилитись, і
 * рівно одне з них хтось колись забуде.
 *
 * ⚠️ Фолбек на тіло — ПЕРЕХІДНИЙ. Mini App у вебвʼю Telegram кешується, тож
 * одразу після релізу стара збірка ще шле поле; без фолбека вона отримала б
 * 401 на кожну дію. Прибрати, коли впевнено, що старих клієнтів не лишилось.
 *
 * @param {Request} request
 * @param {KvBlob|null|undefined} body
 * @returns {string|null}
 */
export function mutationInitData(request, body) {
  return request.headers.get('X-Telegram-Init-Data') ?? body?.initData ?? null;
}
