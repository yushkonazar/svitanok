// Google API — єдина точка доступу Worker'а до сервісів власника
// (Фаза 5, модуляризація worker.js, план A2 §5).
//
// ЩО ТУТ: OAuth-токен (refresh_token grant + кеш у KV), Gmail (пошук і тіло
// листа), People (пошук контакту й створення), Drive (пошук файлу за назвою) і
// Calendar (читання діапазону, створення/зміна/видалення події).
//
// ДВА ІНВАРІАНТИ НА ВЕСЬ ФАЙЛ.
//   1. **Graceful degradation.** Відсутні секрети, протухлий refresh, мережевий
//      збій, 403 без потрібного скоупа — усе це повертає null/{ok:false}, а не
//      кидає. Причина проста: жоден із цих викликів не є суттю запиту власника.
//      Немає календаря — асистент відповість без календаря; впала пошта —
//      скаже, що не вдалось. Виняток тут поклав би весь апдейт.
//   2. **Жодного сирого вводу в URL.** Ідентифікатори (mailId/eventId) уже
//      провалідовані ID_RE на боці agent-core, а пошукові запити йдуть через
//      encodeURIComponent/URLSearchParams. Модель бачила сторонній текст із
//      листів — довіряти її виводу в шляху URL не можна.
//
// Читання (пошта/Drive) НЕ форматують результат для промпту — це робота
// assistant-data-core; тут лише мережа й нормалізація у прості обʼєкти.

import {
  parseEvents,
  kyivRangeBoundsUtc,
  isAccessTokenFresh,
  buildCreateEventBody,
} from './calendar-core.mjs';
import { sanitizeMailQuery } from './assistant-data-core.mjs';
import {
  parseGrantedScopes,
  hasFeatureScope,
  featureNotConnectedText,
} from './core/google-scopes.mjs';

/**
 * OAuth access token через refresh_token grant (Google) — порт
 * src/modules/calendar.ts:93-115 під Worker-секрети GOOGLE_CLIENT_ID/
 * GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN (Блок P2b). Відсутні секрети або
 * будь-яка мережева помилка -> null (graceful, той самий стиль що calendar.ts
 * і callLlmHost — виклик іде далі без календаря, не валить обробку апдейту).
 */
export async function googleAccessToken(/** @type {Env} */ env) {
  return (await googleTokenInfo(env)).token;
}

/**
 * Той самий обмін, але з ПЕРЕЛІКОМ виданих скоупів (етап 7 PR-1): Google
 * повертає `scope` у відповіді на refresh, і саме він - єдине джерело правди
 * про права токена. `scopes: null` означає «невідомо» (кеш без поля або
 * токена немає) і НЕ дорівнює «жодного»: див. auditScopes.
 * @param {Env} env
 * @returns {Promise<{ token: string | null, scopes: string[] | null }>}
 */
export async function googleTokenInfo(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return { token: null, scopes: null };
  }
  // Кеш access-токена в KV (SL3): N раундів агента (кожен читає календар) НЕ
  // роблять N окремих OAuth-обмінів. Токен короткоживучий (~1год), у власному
  // KV-namespace — прийнятно. Биття кешу -> перевидати.
  try {
    const cached = JSON.parse((await env.BRIEFING.get('googleToken')) ?? 'null');
    if (isAccessTokenFresh(cached, Date.now())) {
      return { token: cached.token, scopes: parseGrantedScopes(cached.scope) };
    }
  } catch {
    /* биття -> перевидати нижче */
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      console.error('google token HTTP', res.status, await res.text().catch(() => ''));
      return { token: null, scopes: null };
    }
    const json = await res.json();
    const token = typeof json.access_token === 'string' ? json.access_token : null;
    if (token) {
      // Кеш — BEST-EFFORT (ревʼю SL): збій KV-запису (rate-limit 1/сек на ключ /
      // денний кап Free) НЕ сміє відкинути щойно виданий валідний токен, інакше
      // календар мовчки недоступний попри успішний OAuth. Тому окремий try.
      try {
        // expires_in (сек) мінус 60с запасу; фолбек 55хв, якщо поле відсутнє.
        const ttlSec = Number.isFinite(json.expires_in) ? Math.max(60, json.expires_in - 60) : 3300;
        // scope (F2): Google повертає перелік консентованих скоупів у самій
        // відповіді обміну, тож статус конекторів у Mini App дістається задарма —
        // без окремого виклику tokeninfo. Поле опційне; його відсутність
        // деградує до «обидва сервіси» (connectorStatus).
        await env.BRIEFING.put(
          'googleToken',
          JSON.stringify({
            token,
            expMs: Date.now() + ttlSec * 1000,
            ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
          }),
        );
      } catch (/** @type {any} */ e) {
        console.error('googleToken cache write failed (best-effort, токен усе одно віддаємо)', e);
      }
    }
    return { token, scopes: parseGrantedScopes(json.scope) };
  } catch (/** @type {any} */ err) {
    console.error('google token failed', err.message);
    return { token: null, scopes: null };
  }
}

/**
 * Скоупи, видані токену (етап 7 PR-1). `null` - невідомо (немає секретів,
 * мережа лягла або кеш без поля `scope`).
 * @param {Env} env
 */
export async function googleGrantedScopes(env) {
  return (await googleTokenInfo(env)).scopes;
}

/**
 * Барʼєр можливості (S-8-7): скоуп не виданий → чесний виняток із текстом
 * для власника, а не 403 з надр Google. Невідомі скоупи пропускаємо: див.
 * hasFeatureScope.
 * @param {Env} env @param {string} feature
 */
export async function assertGoogleScope(env, feature) {
  const scopes = await googleGrantedScopes(env);
  if (!hasFeatureScope(scopes, feature)) throw new Error(featureNotConnectedText(feature));
}

/* ── Інкрементальна синхронізація Gmail (ADR-027, етап 7 PR-2) ─────────────
   Задача `mail-triage` у ядрі щочверть години питає, ЩО НОВОГО, а не «дай
   останні N за запитом»: history.list від збереженого historyId повертає
   рівно доданi листи, тож 96 появ на добу коштують 96 дешевих запитів
   замість 96 пошуків із розбором.

   ⚠️ ІНШИЙ КОНТРАКТ ПОМИЛОК, ніж у решти файла. Тут `null` не годиться:
   404 від history.list («historyId застарів, синхронізуйся заново») - це
   не збій, а окремий стан, і задача мусить його розрізнити. Тому
   {ok:false, status} - не виняток (інваріант файла лишається) і не null. */

/**
 * Поточний historyId скриньки - точка відліку для першої синхронізації.
 * @param {Env} env
 * @returns {Promise<{ ok: true, historyId: string } | { ok: false, status: number }>}
 */
export async function gmailProfileHistoryId(env) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false, status: 0 };
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error('gmail profile HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false, status: res.status };
    }
    const json = /** @type {any} */ (await res.json());
    const historyId = json?.historyId == null ? '' : String(json.historyId);
    return historyId ? { ok: true, historyId } : { ok: false, status: 0 };
  } catch (/** @type {any} */ err) {
    console.error('gmail profile failed', err.message);
    return { ok: false, status: 0 };
  }
}

/**
 * Додані листи від `startHistoryId`. Повертає id листів і новий historyId.
 * status 404 - historyId застарів (Gmail тримає історію ~тиждень).
 * @param {Env} env
 * @param {{ startHistoryId: string, maxPages?: number }} input
 * @returns {Promise<{ ok: true, ids: string[], historyId: string }
 *   | { ok: false, status: number }>}
 */
export async function gmailHistoryAdded(env, input) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false, status: 0 };
  /** @type {string[]} */
  const ids = [];
  let historyId = input.startHistoryId;
  /** @type {string | undefined} */
  let pageToken;
  const maxPages = input.maxPages ?? 3;
  try {
    for (let page = 0; page < maxPages; page++) {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
      url.searchParams.set('startHistoryId', input.startHistoryId);
      url.searchParams.set('historyTypes', 'messageAdded');
      url.searchParams.set('labelId', 'INBOX');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        // 404 логуємо тихо: це нормальний стан «синхронізуйся заново».
        if (res.status !== 404) {
          console.error('gmail history HTTP', res.status, await res.text().catch(() => ''));
        }
        return { ok: false, status: res.status };
      }
      const json = /** @type {any} */ (await res.json());
      for (const h of json?.history ?? []) {
        for (const added of h?.messagesAdded ?? []) {
          const id = added?.message?.id;
          if (typeof id === 'string') ids.push(id);
        }
      }
      if (json?.historyId != null) historyId = String(json.historyId);
      pageToken = typeof json?.nextPageToken === 'string' ? json.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return { ok: true, ids: [...new Set(ids)], historyId };
  } catch (/** @type {any} */ err) {
    console.error('gmail history failed', err.message);
    return { ok: false, status: 0 };
  }
}

/**
 * Id листів за запитом - холодний старт синхронізації (історії ще немає або
 * вона застаріла).
 * @param {Env} env @param {{ q: string, limit: number }} input
 * @returns {Promise<{ ok: true, ids: string[] } | { ok: false, status: number }>}
 */
export async function gmailSearchIds(env, input) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false, status: 0 };
  try {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', input.q);
    url.searchParams.set('maxResults', String(input.limit));
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error('gmail list HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false, status: res.status };
    }
    const json = /** @type {any} */ (await res.json());
    const ids = (json?.messages ?? [])
      .map((/** @type {any} */ m) => m?.id)
      .filter((/** @type {unknown} */ id) => typeof id === 'string');
    return { ok: true, ids };
  } catch (/** @type {any} */ err) {
    console.error('gmail search failed', err.message);
    return { ok: false, status: 0 };
  }
}

/**
 * Метадані одного листа для тріажу: заголовки, сніпет, мітки й дата.
 * Формат metadata - тіла НЕ читаємо (та сама мінімізація, що в readMail).
 * @param {Env} env @param {string} id
 * @returns {Promise<{ id: string, from: string, subject: string, snippet: string,
 *   labels: string[], atMs: number } | null>}
 */
export async function gmailMessageMeta(env, id) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  try {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
    );
    url.searchParams.set('format', 'metadata');
    for (const h of ['From', 'Subject', 'Date']) url.searchParams.append('metadataHeaders', h);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    // Один лист не дістався - мінус один кандидат, не збій усього тріажу.
    if (!res.ok) return null;
    const json = /** @type {any} */ (await res.json());
    const headers = json?.payload?.headers ?? [];
    const get = (/** @type {string} */ name) =>
      String(
        headers.find((/** @type {any} */ h) => String(h?.name).toLowerCase() === name)?.value ?? '',
      );
    const internal = Number(json?.internalDate);
    return {
      id,
      from: get('from'),
      subject: get('subject') || '(без теми)',
      snippet: String(json?.snippet ?? ''),
      labels: (json?.labelIds ?? []).map((/** @type {unknown} */ l) => String(l)),
      atMs: Number.isFinite(internal) ? internal : Date.parse(get('date')) || 0,
    };
  } catch (/** @type {any} */ err) {
    console.error('gmail meta failed', err.message);
    return null;
  }
}

// Gmail (B3, дія readMail). Той самий OAuth-токен, що й календар: скоуп
// gmail.readonly уже у GOOGLE_REFRESH_TOKEN (Блок P2c, ре-консент зроблено) —
// нового консенту НЕ потрібно. Читаємо ЛИШЕ метадані (format=metadata) + snippet:
// повні тіла листів не тягнемо ні в промпт, ні навіть у память Worker'а.
// 10, не 5: на прийманні 30.08 пошук «лист від Steam» повертав лише пʼять
// найсвіжіших розсилок, і потрібний лист лишався за вікном. Кожен лист - це
// ще один підзапит (1 список + N метаданих), тож 11 добре вкладається в
// стелю підзапитів Worker'а.
const MAIL_MAX_RESULTS = 10;
const MAIL_HEADERS = ['From', 'Subject', 'Date'];

/** Пошук у Gmail -> [{from,subject,date,snippet}] | [] (нічого) | null (немає доступу/збій). */
export async function readMail(/** @type {Env} */ env, /** @type {unknown} */ rawQuery) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const auth = { Authorization: `Bearer ${token}` };
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('q', sanitizeMailQuery(rawQuery));
  listUrl.searchParams.set('maxResults', String(MAIL_MAX_RESULTS));
  try {
    const res = await fetch(listUrl.toString(), { headers: auth });
    if (!res.ok) {
      console.error('gmail list HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }
    // БЕЗ `?.`: тіло-`null` — це збій, і він мусить кинути й дати `null`
    // («пошта недоступна»), а не порожній масив («листів немає»). Ці два
    // стани formatMailForPrompt розрізняє, і плутати їх не можна.
    const list = /** @type {any} */ (await res.json());
    const ids = (list.messages ?? [])
      .slice(0, MAIL_MAX_RESULTS)
      .map((/** @type {KvBlob} */ m) => m.id);
    if (ids.length === 0) return [];
    const msgs = await Promise.all(
      ids.map(async (/** @type {string} */ id) => {
        // Try/catch НАВКОЛО кожного листа (ревʼю B): кинутий fetch (транзієнтна
        // мережева помилка/abort) інакше зронив би весь Promise.all -> null ->
        // «пошта недоступна», хоча акаунт авторизований і решта листів дістались.
        // Тепер один збій = мінус один лист, як і при !r.ok.
        try {
          const u = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
          u.searchParams.set('format', 'metadata');
          for (const h of MAIL_HEADERS) u.searchParams.append('metadataHeaders', h);
          const r = await fetch(u.toString(), { headers: auth });
          if (!r.ok) return null;
          const j = /** @type {any} */ (await r.json());
          const headers = j?.payload?.headers ?? [];
          const get = (/** @type {string} */ name) =>
            headers.find((/** @type {KvBlob} */ h) => String(h?.name).toLowerCase() === name)
              ?.value ?? '';
          return {
            id,
            from: get('from'),
            subject: get('subject'),
            date: get('date'),
            snippet: j?.snippet ?? '',
          };
        } catch (/** @type {any} */ e) {
          console.error('gmail message fetch failed (один лист пропущено)', e?.message);
          return null;
        }
      }),
    );
    return msgs.filter(Boolean);
  } catch (/** @type {any} */ err) {
    console.error('gmail read failed', err.message);
    return null;
  }
}

/* ── Повне тіло одного листа (дія readMailBody) ───────────────────────────
   Власник дозволив тіла листів у контексті агента (18.07.2026). Читаємо рівно
   ОДИН лист за id, який модель узяла зі списку readMail — не тіла всіх п'яти
   наосліп: бюджет промпту лишається передбачуваним, а найненадійніше джерело
   даних (текст пише хтось чужий) потрапляє в контекст дозовано. */

/** Рекурсивно знайти перше text/plain-тіло в дереві частин MIME (fallback — text/html). */
function pickMailPart(/** @type {any} */ payload) {
  /**
   * @param {any} node
   * @param {string} mime
   * @returns {string|null}
   */
  const walk = (node, mime) => {
    if (!node) return null;
    if (node.mimeType === mime && node.body?.data) return node.body.data;
    for (const part of node.parts ?? []) {
      const found = walk(part, mime);
      if (found) return found;
    }
    return null;
  };
  return { plain: walk(payload, 'text/plain'), html: walk(payload, 'text/html') };
}

/** base64url (Gmail) -> текст; биття -> ''. */
function decodeMailData(/** @type {unknown} */ data) {
  try {
    const bin = atob(String(data).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes); // листи бувають у UTF-8, не latin1
  } catch {
    return '';
  }
}

/** Грубо зняти теги з HTML-листа, коли text/plain-частини немає. */
function stripHtml(/** @type {unknown} */ html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Повний лист за id -> {from,subject,date,body} | null (немає доступу/не знайдено). */
export async function readMailBody(/** @type {Env} */ env, /** @type {string} */ messageId) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  try {
    // messageId уже провалідовано в extractAssistantAction (^[A-Za-z0-9_-]{1,128}$),
    // але encodeURIComponent тут усе одно — інваріант, а не подвійна робота.
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error('gmail body HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }
    const j = /** @type {any} */ (await res.json());
    const headers = j?.payload?.headers ?? [];
    const get = (/** @type {string} */ name) =>
      headers.find((/** @type {KvBlob} */ h) => String(h?.name).toLowerCase() === name)?.value ??
      '';
    const { plain, html } = pickMailPart(j?.payload);
    const raw = plain
      ? decodeMailData(plain)
      : html
        ? stripHtml(decodeMailData(html))
        : decodeMailData(j?.payload?.body?.data ?? '');
    return {
      from: get('from'),
      subject: get('subject'),
      date: get('date'),
      body: raw,
    };
  } catch (/** @type {any} */ err) {
    console.error('gmail body read failed', err.message);
    return null;
  }
}

/* ── Гості на подіях (PR-10): резолюція імені в email через Google People API ──
   ТОЙ САМИЙ access-токен, що Calendar/Gmail (googleAccessToken) — People API
   ділить консент із рештою Google-інтеграції, потрібен ЛИШЕ ширший скоуп
   (contacts.readonly) на тому самому GOOGLE_REFRESH_TOKEN. До ре-консенту
   власником People API повертає 403 -> searchContact тихо віддає [] (як
   googleAccessToken=null на решті інтеграцій), LLM просто не резолвить
   імена — не крашить і не блокує решту пропозиції. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Пошук контакту за іменем -> [email,...] (0 -> нема скоупу/збігів, обидва
 *  випадки трактуємо однаково — розрізняти нема сенсу, дія однакова: не резолвити). */
export async function searchContact(/** @type {Env} */ env, /** @type {string} */ name) {
  const token = await googleAccessToken(env);
  if (!token) return [];
  try {
    const url = new URL('https://people.googleapis.com/v1/people:searchContacts');
    url.searchParams.set('query', name);
    url.searchParams.set('readMask', 'names,emailAddresses');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      // 403 без contacts.readonly-скоупу — ОЧІКУВАНО до ре-консенту, не помилка.
      if (res.status !== 403) {
        console.error('people search HTTP', res.status, await res.text().catch(() => ''));
      }
      return [];
    }
    const results = /** @type {any} */ (await res.json())?.results;
    /** @type {string[]} */
    const emails = [];
    for (const r of Array.isArray(results) ? results : []) {
      const email = r?.person?.emailAddresses?.[0]?.value;
      if (typeof email === 'string' && email) emails.push(email);
    }
    return emails;
  } catch (/** @type {any} */ err) {
    console.error('people search failed', err.message);
    return [];
  }
}

/**
 * Резолвити список "ім'я або email" -> {emails, notes}. Уже готовий email
 * (EMAIL_RE) пропускається без пошуку — модель могла отримати його напряму
 * з розмови. Ім'я: 0 збігів -> НЕ додаємо гостя (notes пояснює, власник
 * бачить у пропозиції ДО підтвердження); 1 -> додаємо; 2+ -> теж НЕ додаємо
 * (не вгадуємо котрий) — обидва граничні випадки віддаємо як notes, не як
 * помилку: решта пропозиції (час/назва/інші гості) не має через це провалитись.
 */
export async function resolveAttendees(
  /** @type {Env} */ env,
  /** @type {unknown[]|null|undefined} */ names,
) {
  /** @type {string[]} */
  const emails = [];
  /** @type {string[]} */
  const notes = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    if (EMAIL_RE.test(name)) {
      emails.push(name);
      continue;
    }
    const found = await searchContact(env, name);
    if (found.length === 1) {
      // `?? ''` недосяжне: гілка входить лише при found.length === 1.
      emails.push(found[0] ?? '');
    } else if (found.length === 0) {
      notes.push(`«${name}» не знайдено в контактах — додай email вручну, якщо треба`);
    } else {
      notes.push(`«${name}»: кілька збігів (${found.slice(0, 3).join(', ')}) — уточни email`);
    }
  }
  return { emails, notes };
}

/**
 * Створити новий контакт (write-scope, PR-13). Ніколи не кидає — {ok:false}
 * при збої (403 без contacts-скоупу — той самий "тихо не резолвили" мотив,
 * що searchContact, ЛИШЕ тут це вже TERMінальна дія в accept-циклі, тож
 * помилку показуємо власнику текстом, не мовчки ігноруємо).
 */
/**
 * @param {Env} env
 * @param {{ name: string, email: string }} opts
 */
export async function createContact(env, { name, email }) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const res = await fetch('https://people.googleapis.com/v1/people:createContact', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        names: [{ givenName: name }],
        emailAddresses: [{ value: email }],
      }),
    });
    if (!res.ok) {
      console.error('people createContact HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (/** @type {any} */ err) {
    console.error('people createContact failed', err.message);
    return { ok: false };
  }
}

const DRIVE_MAX_RESULTS = 5;

/**
 * Пошук файлів у Drive за назвою (PR-14, дія readDrive). МЕТА-ДАНІ ЛИШЕ:
 * назва+посилання, БЕЗ читання вмісту (резюме реально PDF/Word — розбір
 * тексту звідти окремий, більший шматок роботи, свідомо відкладено).
 * [{name,webViewLink}] | [] (нема збігів) | null (немає доступу/збій —
 * ТОЙ САМИЙ контракт, що readMail: formatDriveForPrompt різнить тексти).
 */
export async function searchDrive(/** @type {Env} */ env, /** @type {unknown} */ rawQuery) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const query = String(rawQuery ?? '')
    .trim()
    .slice(0, 120);
  if (!query) return [];
  try {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    // Екранувати одинарні лапки — Drive query-мова, сирий текст користувача
    // не має ламати структуру запиту (той самий мотив, що SQL-параметризація).
    const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    url.searchParams.set('q', `name contains '${escaped}' and trashed = false`);
    url.searchParams.set('fields', 'files(id,name,webViewLink,modifiedTime)');
    url.searchParams.set('pageSize', String(DRIVE_MAX_RESULTS));
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      // 403 без drive.readonly-скоупу — очікувано до ре-консенту, не помилка.
      if (res.status !== 403) {
        console.error('drive search HTTP', res.status, await res.text().catch(() => ''));
      }
      return null;
    }
    const json = await res.json();
    return Array.isArray(json.files) ? json.files : [];
  } catch (/** @type {any} */ err) {
    console.error('drive search failed', err.message);
    return null;
  }
}

/** Події діапазону [startKey..endKey] (Київ) через Google Calendar API (read, CC1 —
 *  один запит на весь діапазон, timeMin/timeMax). null при будь-якому збої. */
export async function readCalendarRange(
  /** @type {Env} */ env,
  /** @type {string} */ startKey,
  /** @type {string} */ endKey,
) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const { timeMin, timeMax } = kyivRangeBoundsUtc(startKey, endKey);
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('timeZone', 'Europe/Kyiv');
  try {
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error('google calendar read HTTP', res.status, await res.text().catch(() => ''));
      return null;
    }
    return parseEvents(await res.json());
  } catch (/** @type {any} */ err) {
    console.error('google calendar read failed', err.message);
    return null;
  }
}

/**
 * Створити подію в календарі (write-scope, Блок P2b). Ніколи не кидає —
 * {ok:false} при збої. `sendUpdates=all`, коли є гості (PR-10) — інакше Google
 * НЕ шле запрошення (дефолт `none`), а сенс attendees саме в сповіщенні;
 * без гостей лишаємо старий тихий шлях (жоден лист нікому не піде).
 */
/**
 * @param {Env} env
 * @param {{ title: string, startIso: string, endIso: string, reminderMinutes?: number,
 *           location?: string|null, attendees?: string[]|null }} opts
 */
export async function createCalendarEvent(
  env,
  { title, startIso, endIso, reminderMinutes, location, attendees },
) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    if (attendees?.length) url.searchParams.set('sendUpdates', 'all');
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        buildCreateEventBody({ title, startIso, endIso, reminderMinutes, location, attendees }),
      ),
    });
    if (!res.ok) {
      console.error('google calendar create HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    const json = /** @type {any} */ (await res.json());
    return { ok: true, id: typeof json.id === 'string' ? json.id : null };
  } catch (/** @type {any} */ err) {
    console.error('google calendar create failed', err.message);
    return { ok: false };
  }
}

/** URL одного events.get/patch/delete — eventId ВАЛІДУЄ викликач (той самий
 *  мотив, що mailId: рядок іде в шлях URL). */
function calendarEventUrl(/** @type {string} */ eventId) {
  return `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`;
}

/**
 * Прочитати ОДНУ подію за id (CRUD: свіжий title/startMs/endMs перед
 * update/delete — список міг бути застарілим на момент тапу). `null` при
 * будь-якому збої, включно з 404 (подію вже видалено). Реюзає parseEvents
 * (той самий title/час-парсинг, що читання діапазону) — обгортаємо єдиний
 * обʼєкт у {items:[...]} замість дублювати нормалізацію.
 */
export async function getCalendarEvent(/** @type {Env} */ env, /** @type {string} */ eventId) {
  const token = await googleAccessToken(env);
  if (!token) return null;
  try {
    const res = await fetch(calendarEventUrl(eventId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status !== 404) {
        console.error('google calendar get HTTP', res.status, await res.text().catch(() => ''));
      }
      return null;
    }
    const json = /** @type {any} */ (await res.json());
    return parseEvents({ items: [json] })[0] ?? null;
  } catch (/** @type {any} */ err) {
    console.error('google calendar get failed', err.message);
    return null;
  }
}

/** Частково оновити подію (write-scope, CRUD). Ніколи не кидає — {ok:false} при збої.
 *  `sendUpdates=all`, коли патч зачіпає attendees (PR-10) — той самий мотив, що create. */
/**
 * @param {Env} env
 * @param {{ eventId: string, patch: KvBlob }} opts
 */
export async function updateCalendarEvent(env, { eventId, patch }) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const url = new URL(calendarEventUrl(eventId));
    if (Array.isArray(patch?.attendees) && patch.attendees.length) {
      url.searchParams.set('sendUpdates', 'all');
    }
    const res = await fetch(url.toString(), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.error('google calendar update HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (/** @type {any} */ err) {
    console.error('google calendar update failed', err.message);
    return { ok: false };
  }
}

/**
 * Видалити подію (write-scope, CRUD). 404/410 (уже видалено — власник
 * прибрав з іншого пристрою, чи подвійний тап) рахуємо УСПІХОМ: мета
 * («події більше немає») уже досягнута, показувати «⚠️ не вдалось» тут
 * оманливо.
 */
/**
 * @param {Env} env
 * @param {{ eventId: string }} opts
 */
export async function deleteCalendarEvent(env, { eventId }) {
  const token = await googleAccessToken(env);
  if (!token) return { ok: false };
  try {
    const res = await fetch(calendarEventUrl(eventId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      console.error('google calendar delete HTTP', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (/** @type {any} */ err) {
    console.error('google calendar delete failed', err.message);
    return { ok: false };
  }
}
