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

const TOKEN_VERSION = 1;

/** Кап тексту користувача в токені. Той самий MAX_USER_TEXT, що й у промпті
 *  (worker.js) — токен їздить у кожному кроці, роздувати його нічим. */
const MAX_TOKEN_USER_TEXT = 500;

/* ── base64url без padding'у (btoa/atob є і в Worker'і, і в Node ≥16) ────── */

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
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
async function deriveRunKey(secret) {
  const material = new TextEncoder().encode(`svitanok-agent-run:v${TOKEN_VERSION}:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Порівняння підписів за константний час (той самий мотив, що verifySecret). */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

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
 *   s — номер кроку, e — момент протухання (epoch ms)
 *   u — текст користувача
 *
 * Навіщо `u` тут, а не в KV: історію розмови пишемо ОДНИМ записом на фініші
 * (як і до переходу — провалений обмін не має отруювати контекст наступних).
 * Для цього фінішу потрібен вихідний текст користувача, а KV не має
 * read-your-writes: марка, покладена на старті, могла б бути ще не видною
 * через 5 секунд. У підписаному токені текст їде з прогоном і підробці не
 * піддається.
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
    nowMs = Date.now(),
    ttlMs = AGENT_RUN_TTL_MS,
  },
) {
  const payload = {
    v: TOKEN_VERSION,
    r: runId,
    c: chatId,
    t: threadId ?? null,
    m: progressMsgId ?? null,
    u: String(userText ?? '').slice(0, MAX_TOKEN_USER_TEXT),
    s: step,
    e: nowMs + ttlMs,
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

  // Протухання рахуємо ТУТ, а не покладаємось на дисципліну хоста: зависла на
  // сервері петля інакше й далі мала б доступ до пошти й календаря.
  if (!Number.isFinite(claims.e) || claims.e <= nowMs) return { ok: false, error: 'expired' };
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
      expMs: claims.e,
    },
  };
}

/**
 * Токен наступного кроку: той самий прогін, крок +1.
 *
 * ⚠️ `e` НЕ поновлюється — інакше петля, що робить крок за кроком, продовжувала б
 * собі життя нескінченно, і межа AGENT_RUN_TTL_MS не значила б нічого.
 * Повертає null, коли кроки вичерпано (викликач віддає це як фінал прогону).
 */
export async function nextRunToken(secret, claims) {
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
    e: claims.expMs, // початкове протухання, НЕ поновлюємо — див. коментар вище
  };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await sign(secret, payloadB64);
  return `${payloadB64}.${b64urlEncode(sig)}`;
}
