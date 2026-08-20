// @ts-check
// Ран-токен агента (варіант Б: цикл живе на VPS-хості, інструменти — у Worker'і).
//
// НАВІЩО ВЗАГАЛІ ТОКЕН. Після переходу хост стукає НАЗАД у Worker по кожен
// інструмент (`/api/agent-step`). Цей ендпоінт стоїть в інтернеті й виконує
// читання Gmail, запис у календар і KV від імені власника — тобто мусить знати
// не лише «запит прийшов від хоста» (це доводить спільний LLM_HOST_SECRET), а й
// «цей крок належить прогонові, який Worker САМ почав у відповідь на
// повідомлення власника».
//
// ⚠️ КЛЮЧОВЕ РІШЕННЯ: підписуємо НЕ на LLM_HOST_SECRET. Хост його знає, тож
// підпис на ньому не заважав би скомпрометованому хосту МІНТИТИ власні прогони
// (і, наприклад, качати пошту без жодного повідомлення власника — відповідь
// `/api/agent-step` іде ж хосту). Ключ виводимо з секрету, якого хост НЕ бачить
// (TELEGRAM_WEBHOOK_SECRET, він є лише у Worker'і — у GitHub Actions його немає).
// Так зберігається поточна межа: скомпрометований хост може діяти ЛИШЕ в межах
// прогону, який власник почав сам, і лише тими діями, що й сьогодні.
//
// ЧОГО ЦЕ НЕ ДАЄ (без прикрас, знайдено на security-рев'ю). Токен самодостатній,
// тож він РЕПЛЕЙНИЙ: поки не протух, той самий крок можна надіслати повторно, а
// кожен виклик виконує інструмент і повертає результат викликачеві. Тобто
// скомпрометований хост не обмежений AGENT_MAX_STEPS у кількості прочитаних
// листів — лише вікном часу. Два запобіжники звужують це вікно:
//   1. коротке життя КРОКУ (AGENT_STEP_TTL_MS) окремо від дедлайну прогону;
//   2. відмова кроку для прогону з надгробком (handleAgentStep) — закриває
//      найтихіший варіант, коли обмін для власника вже завершився.
// Обидва — звуження, не гарантія. Прибрати реплей насправді можна лише станом:
// лічильник кроків у Durable Object (він же зняв би й KV-розсинхрон). Поки
// прогонів одиниці на добу, ця пара пропорційна; за зростання — робити DO.
//
// Стан у KV свідомо НЕ тримаємо: KV не має read-your-writes (~60с розсинхрон),
// а перший зворотний виклик хоста прилітає через 2-5с — запис просто не встиг би
// стати видимим. Токен самодостатній: усе, що треба знати кроку, лежить у ньому
// й засвідчене підписом.

/** Стеля кроків одного прогону. Час більше не обмежує (у цьому й був сенс
 *  переходу), тож єдиний реальний запобіжник від зациклення — лічильник. 10 —
 *  із запасом: найдовший практичний ланцюжок (пошта -> тіло листа -> календар ->
 *  пропозиція) — це 4. */
export const AGENT_MAX_STEPS = 10;

/** Стеля ЖИТТЯ прогону. Не «таймаут раунду» (їх більше немає), а межа, після
 *  якої зависла петля перестає мати право торкатись пошти й календаря. */
export const AGENT_RUN_TTL_MS = 5 * 60_000;

/**
 * Скільки живе ОКРЕМИЙ крок — окремо від життя прогону.
 *
 * ⚠️ Це протидія РЕПЛЕЮ. Токен самодостатній, тож ніщо не заважає викликачеві
 * надіслати той самий крок двічі — а кожен виклик виконує інструмент і повертає
 * ЙОМУ Ж результат (пошта, календар). Із життям кроку, рівним життю прогону,
 * скомпрометований хост мав би 5 хвилин необмеженого читання пошти на один
 * легітимний токен. Хост мусить використати крок за WORKER_STEP_TIMEOUT_MS
 * (20с), тож 45с — із запасом на мережу, але вікно реплею вужче в сім разів.
 *
 * Повністю реплей це НЕ прибирає (для цього потрібен стан — див. коментар про
 * Durable Object у handleAgentStep). Це звуження вікна, а не гарантія.
 */
export const AGENT_STEP_TTL_MS = 45_000;

const TOKEN_VERSION = 1;

/** Кап тексту користувача в токені. Той самий MAX_USER_TEXT, що й у промпті
 *  (worker.js) — токен їздить у кожному кроці, роздувати його нічим. */
const MAX_TOKEN_USER_TEXT = 500;

/**
 * Вміст токена прогону після перевірки підпису.
 * @typedef {object} RunClaims
 * @property {string} runId
 * @property {string|number} chatId
 * @property {string|number|null} threadId
 * @property {number|null} progressMsgId
 * @property {string} userText
 * @property {number} step
 * @property {boolean} tainted таint-біт (S2): у транскрипті вже є чужий текст
 * @property {number} expMs протухання ЦЬОГО кроку
 * @property {number} deadlineMs дедлайн УСЬОГО прогону (кроком не поновлюється)
 */

/**
 * Стан прогону в Durable Object. Обидва поля опційні: свіжий прогін не має
 * жодного.
 * @typedef {{ lastStep?: number, finishedMs?: number }} AgentRunState
 */

/* ── base64url без padding'у (btoa/atob є і в Worker'і, і в Node ≥16) ────── */

function b64urlEncode(/** @type {Uint8Array} */ bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(/** @type {unknown} */ s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Вивести HMAC-ключ прогону з worker-only секрету.
 *
 * Розділення ключів (key separation): секрет уже має інше призначення
 * (перевірка вебхука Telegram), тож підписуємо не ним самим, а SHA-256 від
 * нього з фіксованим міткою-контекстом. Компрометація одного застосування не
 * дає підробити інше, і сам секрет із токена не відновити.
 */
async function deriveRunKey(/** @type {string} */ secret) {
  const material = new TextEncoder().encode(`svitanok-agent-run:v${TOKEN_VERSION}:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * Порівняння підписів за константний час (той самий мотив, що verifySecret).
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  // `?? 0` ніколи не спрацьовує (довжини звірено вище, i < a.length), але без
  // нього noUncheckedIndexedAccess бачить `number|undefined`. Це не гілка за
  // даними — вартість однакова на кожній ітерації, тож константний час цілий.
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * @param {string} secret
 * @param {string} payloadB64
 */
async function sign(secret, payloadB64) {
  const key = await deriveRunKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return new Uint8Array(sig);
}

/**
 * Змінтити токен прогону.
 *
 * Поля свідомо однобуквені — токен їздить у КОЖНОМУ зворотному виклику:
 *   r — runId (для сторожа: за ним знімається марка прогону в KV)
 *   c — chatId, t — threadId  (куди слати відповідь; підписані, щоб хост не
 *       міг перенаправити відповідь у інший чат)
 *   m — message_id повідомлення «⏳ Працюю…» (щоб прибрати його на фініші)
 *   s — номер кроку
 *   e — протухання ЦЬОГО КРОКУ (коротке, проти реплею)
 *   d — дедлайн УСЬОГО прогону (не поновлюється жодним кроком)
 *   u — текст користувача
 *
 * Навіщо `u` тут, а не в KV: історію розмови пишемо ОДНИМ записом на фініші
 * (як і до переходу — провалений обмін не має отруювати контекст наступних).
 * Для цього фінішу потрібен вихідний текст користувача, а KV не має
 * read-your-writes: марка, покладена на старті, могла б бути ще не видною
 * через 5 секунд. У підписаному токені текст їде з прогоном і підробці не
 * піддається.
 *
 * @param {string} secret TELEGRAM_WEBHOOK_SECRET — його НЕ знає хост
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string|number} opts.chatId
 * @param {string|number|null} [opts.threadId]
 * @param {number|null} [opts.progressMsgId]
 * @param {string} [opts.userText]
 * @param {number} [opts.step]
 * @param {boolean} [opts.tainted]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.ttlMs]
 */
export async function mintRunToken(
  secret,
  {
    runId,
    chatId,
    threadId = null,
    progressMsgId = null,
    userText = '',
    step = 0,
    tainted = false,
    nowMs = Date.now(),
    ttlMs = AGENT_RUN_TTL_MS,
  },
) {
  const deadline = nowMs + ttlMs;
  const payload = {
    v: TOKEN_VERSION,
    r: runId,
    c: chatId,
    t: threadId ?? null,
    m: progressMsgId ?? null,
    u: String(userText ?? '').slice(0, MAX_TOKEN_USER_TEXT),
    s: step,
    // `x` — taint-біт (S2): у транскрипт уже потрапив текст, який контролює
    // СТОРОННЯ людина (тіло листа, назва файлу в Drive). Живе в ПІДПИСАНОМУ
    // токені, а не в KV: хост його не підробить, а KV не має read-your-writes.
    x: tainted ? 1 : 0,
    e: Math.min(nowMs + AGENT_STEP_TTL_MS, deadline),
    d: deadline,
  };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await sign(secret, payloadB64);
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Перевірити токен -> {ok:true, claims} | {ok:false, error}.
 *
 * Порядок перевірок принциповий: спершу ПІДПИС, тоді вміст. Інакше ми б робили
 * висновки (протух / забагато кроків) із непідтверджених даних, а повідомлення
 * про помилку саме по собі ставало б оракулом для підбору.
 *
 * `secret` і `token` — `unknown` навмисно: обидва приходять ззовні (секрет
 * може бути незаданим, токен — довільним рядком із мережі), і саме перші дві
 * перевірки нижче звужують їх до рядків.
 * @param {unknown} secret
 * @param {unknown} token
 * @param {number} [nowMs]
 * @returns {Promise<{ ok: true, claims: RunClaims } | { ok: false, error: string }>}
 */
export async function verifyRunToken(secret, token, nowMs = Date.now()) {
  if (typeof secret !== 'string' || !secret) return { ok: false, error: 'no-secret' };
  if (typeof token !== 'string' || !token) return { ok: false, error: 'bad-format' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, error: 'bad-format' };
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let given;
  let expected;
  try {
    given = b64urlDecode(sigB64);
    expected = await sign(secret, payloadB64);
  } catch {
    return { ok: false, error: 'bad-format' }; // не-base64 у підписі
  }
  if (!timingSafeEqual(given, expected)) return { ok: false, error: 'bad-signature' };

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch {
    return { ok: false, error: 'bad-format' };
  }
  if (!claims || typeof claims !== 'object') return { ok: false, error: 'bad-format' };
  if (claims.v !== TOKEN_VERSION) return { ok: false, error: 'bad-version' };

  // Обидва протухання рахуємо ТУТ, а не покладаємось на дисципліну хоста:
  // зависла на сервері петля інакше й далі мала б доступ до пошти й календаря.
  // `e` — вікно ЦЬОГО кроку (вузьке, проти реплею), `d` — дедлайн усього
  // прогону (його не подовжує жоден крок).
  if (!Number.isFinite(claims.e) || claims.e <= nowMs) return { ok: false, error: 'expired' };
  if (!Number.isFinite(claims.d) || claims.d <= nowMs) return { ok: false, error: 'run-expired' };
  if (!Number.isFinite(claims.s) || claims.s < 0) return { ok: false, error: 'bad-format' };
  if (claims.s >= AGENT_MAX_STEPS) return { ok: false, error: 'too-many-steps' };
  if (claims.c == null) return { ok: false, error: 'bad-format' };

  return {
    ok: true,
    claims: {
      runId: typeof claims.r === 'string' ? claims.r : '',
      chatId: claims.c,
      threadId: claims.t ?? null,
      progressMsgId: claims.m ?? null,
      userText: typeof claims.u === 'string' ? claims.u : '',
      step: claims.s,
      // Старі токени (без `x`) читаються як НЕ заплямовані — це коректно: їх
      // видали до появи біта, тобто до появи самої гілки читання пошти в цьому
      // прогоні. Токен живе хвилини, тож стан «змішаних» токенів минущий.
      tainted: claims.x === 1,
      expMs: claims.e,
      deadlineMs: claims.d,
    },
  };
}

/* ── Лічильник кроків у Durable Object (Фаза 4 аудиту) ────────────────────
   Обіцянка з коментаря вгорі цього файлу («прибрати реплей насправді можна лише
   станом») тут і виконується. Токен лишається межею — він доводить, що прогін
   почав Worker у відповідь на власника, — а DO додає те, чого підпис дати не
   може: пам'ять про те, що ЦЕЙ крок уже виконано. Read-modify-write усередині
   DO атомарний, тож зникає і KV-щілина в перевірці надгробка.

   Логіка ухвали живе ТУТ, а не в класі DO: клас — це I/O (сховище, аларм), а
   правило «крок лише вперед, після фінішу — ніколи» тестується напряму. */

/** Скільки DO тримає стан прогону після останнього дотику. Рівно доти, доки
 *  живий найдовший можливий токен (+хвилина на розбіжність годинників): після
 *  цього реплеїти нічим, а вічний запис на кожен прогін — це сміття. */
export const AGENT_RUN_DO_KEEP_MS = AGENT_RUN_TTL_MS + 60_000;

/**
 * Ухвала про крок: {ok:true, state} | {ok:false, error}.
 *
 * `lastStep` монотонний — саме тому одного числа досить замість переліку
 * зайнятих кроків: легітимна петля лише зростає (крок n віддає токен на n+1),
 * тож будь-яке «≤ вже зайнятого» — це або реплей, або зіпсований токен.
 * @param {AgentRunState|null|undefined} state
 * @param {number} step
 * @returns {{ ok: true, state: AgentRunState } | { ok: false, error: string }}
 */
export function decideStepClaim(state, step) {
  if (state?.finishedMs) return { ok: false, error: 'run-finished' };
  if (!Number.isFinite(step) || step < 0 || step >= AGENT_MAX_STEPS) {
    return { ok: false, error: 'too-many-steps' };
  }
  // `typeof` тут не додає перевірки, а лише повідомляє її компілятору:
  // Number.isFinite уже істинний ЛИШЕ для чисел, але звуження типу не дає.
  const last = state?.lastStep;
  if (typeof last === 'number' && Number.isFinite(last) && step <= last) {
    return { ok: false, error: 'step-replayed' };
  }
  return { ok: true, state: { ...(state ?? {}), lastStep: step } };
}

/**
 * Імʼя DO прогону. runId — лише 8 символів UUID, тож у ключ додаємо ще й
 * дедлайн прогону: збіг runId через місяці не має шансу натрапити на чужий
 * (уже мертвий) стан і зарубати живий прогін. Дедлайн їде в токені й жодним
 * кроком не поновлюється — отже, стабільний для всього прогону.
 * @param {Partial<RunClaims>|null|undefined} claims
 */
export function agentRunDoName(claims) {
  return `${claims?.runId ?? ''}:${claims?.deadlineMs ?? 0}`;
}

/**
 * Токен наступного кроку: той самий прогін, крок +1.
 *
 * ⚠️ `d` (дедлайн прогону) НЕ поновлюється — інакше петля, що робить крок за
 * кроком, продовжувала б собі життя нескінченно, і межа AGENT_RUN_TTL_MS не
 * значила б нічого. `e` (вікно кроку) видається свіже, але ніколи не переступає
 * `d`. Повертає null, коли кроки вичерпано (викликач віддає це як фінал прогону).
 * @param {string} secret
 * @param {RunClaims} claims
 * @param {number} [nowMs]
 * @returns {Promise<string|null>}
 */
export async function nextRunToken(secret, claims, nowMs = Date.now()) {
  const step = claims.step + 1;
  if (step >= AGENT_MAX_STEPS) return null;
  const payload = {
    v: TOKEN_VERSION,
    r: claims.runId,
    c: claims.chatId,
    t: claims.threadId ?? null,
    m: claims.progressMsgId ?? null,
    u: claims.userText ?? '',
    s: step,
    // Taint — ОДНОСТОРОННІЙ: заплямований прогін заплямованим і лишається.
    // Зняти його могло б лише «забування» вже прочитаного, а транскрипт росте.
    x: claims.tainted ? 1 : 0,
    e: Math.min(nowMs + AGENT_STEP_TTL_MS, claims.deadlineMs),
    d: claims.deadlineMs, // дедлайн прогону, НЕ поновлюємо — див. коментар вище
  };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await sign(secret, payloadB64);
  return `${payloadB64}.${b64urlEncode(sig)}`;
}
