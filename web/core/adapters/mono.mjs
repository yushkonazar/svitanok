// Monobank personal API (01 §2.4 «адаптери», §3.6, ADR-029, етап 6 PR-1):
// client-info (рахунки + чинний webHookUrl), встановлення вебхука і виписка
// за вікном. Ключ MONO_TOKEN - лише тут, у заголовку `X-Token`; у текст
// помилки не потрапляє ані він, ані URL.
//
// Ліміт Mono - один запит на 60 секунд НА КОЖЕН із читальних ендпоїнтів
// (client-info, statement). Тому адаптер НЕ пробує «зробити все за один
// прогін»: він віддає окремі виклики, а розкладку по тіках планувальника
// (5 хв > 60 с) веде задача `mono-reconcile`. 429 від Mono - не збій даних,
// а «зарано»: окремий тип помилки, щоб задача відклала спробу, а не палила
// добу.
//
// Гроші - цілі мінімальні одиниці (копійки/центи), як їх віддає Mono; жодних
// дробів (07 §1). Валюти - ISO-4217 ЧИСЛОВІ коди, alpha-3 рахує numericToAlpha.

const API = 'https://api.monobank.ua';
const TIMEOUT_MS = 15_000;
/** Стеля тіла відповіді: виписка за 31 добу однієї картки - десятки КБ. */
const BODY_MAX = 4_000_000;
/** Максимальне вікно виписки (Mono: 31 доба + 1 година). */
export const STATEMENT_MAX_S = 31 * 86_400 + 3600;
/** Скільки транзакцій віддає одна сторінка виписки (Mono ріже на 500). */
export const STATEMENT_PAGE = 500;

/** Валюти, які взагалі можуть трапитись власнику; решта - числом у дужках. */
const CURRENCY_ALPHA = {
  980: 'UAH',
  840: 'USD',
  978: 'EUR',
  826: 'GBP',
  985: 'PLN',
  756: 'CHF',
  203: 'CZK',
  348: 'HUF',
  946: 'RON',
  944: 'AZN',
  975: 'BGN',
  949: 'TRY',
  124: 'CAD',
  392: 'JPY',
  156: 'CNY',
  36: 'AUD',
};

/** Mono відповів 429 «зарано» - задача мусить відкласти, а не рахувати збій. */
export class MonoTooSoonError extends Error {
  /** @param {string} what @param {number} [retryAfterMs] */
  constructor(what, retryAfterMs = 60_000) {
    super(`${what}: Mono просить зачекати (429)`);
    this.name = 'MonoTooSoonError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Safe provider failure metadata. Never include the response body, URL,
 * token or the original network error in logs or owner-facing messages. */
export class MonoApiError extends Error {
  /** @param {string} what @param {number|null} [status] */
  constructor(what, status = null) {
    super(status == null ? `${what}: запит тимчасово недоступний` : `${what}: HTTP ${status}`);
    this.name = 'MonoApiError';
    this.status = status;
    this.retryable = status == null || status === 408 || (status >= 500 && status <= 599);
  }
}

/** Ключ - явна відмова без нього (00-README п.6: без тихої деградації).
 *  @param {Env} env */
export function monoToken(env) {
  const token = String(env.MONO_TOKEN ?? '').trim();
  if (!token) throw new Error('MONO_TOKEN не заданий - Monobank недоступний');
  return token;
}

/**
 * Числовий код валюти → alpha-3. Невідомий - `#<код>`: краще видимий чужий
 * код у рядку, ніж мовчазне «UAH» на чужі гроші.
 * @param {unknown} code
 */
export function numericToAlpha(code) {
  const n = Number(code);
  if (!Number.isInteger(n) || n <= 0) return '?';
  return CURRENCY_ALPHA[/** @type {keyof typeof CURRENCY_ALPHA} */ (n)] ?? `#${n}`;
}

/** Opaque bank identifiers may use standard or URL-safe base64.
 * @param {unknown} value @returns {value is string} */
export function isMonoAccountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_+=/-]{1,128}$/.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isMonoSendId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Запит до Mono з таймаутом. Текст помилки - сервіс і статус, без URL і без
 * токена.
 * @param {Env} env @param {string} path @param {RequestInit} init @param {string} what
 * @returns {Promise<any>}
 */
async function call(env, path, init, what) {
  const token = monoToken(env);
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'X-Token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new MonoApiError(what);
  }
  if (res.status === 429) {
    const header = res.headers.get('retry-after')?.trim() ?? '';
    const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    throw new MonoTooSoonError(
      what,
      Number.isSafeInteger(delay) ? Math.max(60_000, delay) : 60_000,
    );
  }
  if (!res.ok) throw new MonoApiError(what, res.status);
  let text;
  try {
    text = await res.text();
  } catch {
    // A failed body read is not a successful empty account list.
    throw new MonoApiError(what);
  }
  if (text.length > BODY_MAX) throw new Error(`${what}: відповідь понад ${BODY_MAX} байтів`);
  try {
    return text ? JSON.parse(text) : {};
  } catch (/** @type {any} */ e) {
    throw new Error(`${what}: відповідь не JSON`, { cause: e });
  }
}

/**
 * @typedef {{ id: string, currency: string, currencyCode: number, type: string,
 *   maskedPan: string | null, iban: string | null,
 *   balanceMinor: number | null, creditLimitMinor: number | null, title?: string,
 *   sendId?: string, goalMinor?: number }} MonoAccount
 * @typedef {{ name: string, webHookUrl: string | null, accounts: MonoAccount[], jars: MonoAccount[], jarsReported: boolean }} MonoClientInfo
 */

/**
 * `GET /personal/client-info` - рахунки власника і чинний `webHookUrl`.
 * Ліміт: 1 виклик на 60 с.
 * @param {Env} env @returns {Promise<MonoClientInfo>}
 */
export async function clientInfo(env) {
  const raw = await call(env, '/personal/client-info', { method: 'GET' }, 'Mono client-info');
  const accounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
  const jars = Array.isArray(raw?.jars) ? raw.jars : [];
  return {
    name: typeof raw?.name === 'string' ? raw.name : '',
    webHookUrl: typeof raw?.webHookUrl === 'string' && raw.webHookUrl ? raw.webHookUrl : null,
    jarsReported: Array.isArray(raw?.jars),
    accounts: accounts
      .filter((/** @type {any} */ a) => isMonoAccountId(a?.id))
      .map((/** @type {any} */ a) => ({
        id: String(a.id),
        currency: numericToAlpha(a.currencyCode),
        currencyCode: Number(a.currencyCode) || 0,
        type: typeof a.type === 'string' ? a.type : '',
        maskedPan: Array.isArray(a.maskedPan) && a.maskedPan[0] ? String(a.maskedPan[0]) : null,
        iban: typeof a.iban === 'string' ? a.iban : null,
        ...(isMonoSendId(a.sendId) ? { sendId: a.sendId } : {}),
        balanceMinor: Number.isSafeInteger(a.balance) ? a.balance : null,
        creditLimitMinor:
          Number.isSafeInteger(a.creditLimit) && a.creditLimit >= 0 ? a.creditLimit : null,
      })),
    jars: jars
      .filter((/** @type {any} */ jar) => isMonoAccountId(jar?.id))
      .map((/** @type {any} */ jar) => ({
        id: String(jar.id),
        currency: numericToAlpha(jar.currencyCode),
        currencyCode: Number(jar.currencyCode) || 0,
        type: 'jar',
        title:
          typeof jar.title === 'string' ? jar.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
        maskedPan: null,
        iban: null,
        ...(isMonoSendId(jar.sendId) ? { sendId: jar.sendId } : {}),
        ...(Number.isSafeInteger(jar.goal) && jar.goal > 0 ? { goalMinor: jar.goal } : {}),
        balanceMinor: Number.isSafeInteger(jar.balance) ? jar.balance : null,
        creditLimitMinor: null,
      })),
  };
}

/**
 * `POST /personal/webhook` - поставити адресу вебхука. Mono одразу шле на неї
 * порожній GET-пінг і чекає 200; якщо не дочекався - адреса не збережеться,
 * тому наш маршрут відповідає 200 і на GET.
 * @param {Env} env @param {string} url
 */
export async function setWebhook(env, url) {
  if (!/^https:\/\/[^\s]+$/.test(url)) throw new Error('Mono webhook: адреса має бути https URL');
  await call(
    env,
    '/personal/webhook',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webHookUrl: url }),
    },
    'Mono webhook',
  );
  return true;
}

/**
 * @typedef {{ id: string, timeS: number, description: string, mcc: number,
 *   amount: number, operationAmount: number, currency: string, hold: boolean,
 *   balance: number | null, comment: string | null }} MonoStatementItem
 */

/**
 * Один елемент виписки/вебхука → нормалізований вигляд. Повертає null, коли
 * обовʼязкових полів немає: чуже тіло не має права створювати «транзакцію
 * без id».
 * @param {any} raw @returns {MonoStatementItem | null}
 */
export function parseStatementItem(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const timeS = Number(raw?.time);
  const amount = Number(raw?.amount);
  if (!id || id.length > 64) return null;
  if (!Number.isSafeInteger(timeS) || timeS <= 0 || timeS > 8_640_000_000_000) return null;
  if (raw?.amount == null || !Number.isSafeInteger(amount)) return null;
  const operationAmount = Number(raw?.operationAmount ?? amount);
  if (!Number.isSafeInteger(operationAmount)) return null;
  return {
    id,
    timeS,
    // Опис - ЗОВНІШНІЙ текст (його пише мерчант): ріжемо довжину тут, а
    // «це дані, не команда» тримає розмітка на шляху до моделі.
    description: String(raw?.description ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200),
    mcc: Number.isInteger(Number(raw?.mcc)) ? Number(raw.mcc) : 0,
    amount,
    operationAmount,
    currency: numericToAlpha(raw?.currencyCode),
    // Only an explicit final bank status can clear a pending authorization.
    hold: raw?.hold !== false,
    balance:
      raw?.balance != null && Number.isSafeInteger(Number(raw.balance))
        ? Number(raw.balance)
        : null,
    comment:
      typeof raw?.comment === 'string' && raw.comment
        ? raw.comment.replace(/\s+/g, ' ').trim().slice(0, 200)
        : null,
  };
}

/**
 * `GET /personal/statement/{account}/{from}/{to}` - виписка за вікном (Mono:
 * не більше 31 доби + 1 год, 1 виклик на 60 с, до 500 записів на сторінку).
 * Повертає нормалізовані елементи, новіші перші (як віддає Mono).
 * @param {Env} env
 * @param {{ account: string, fromS: number, toS: number }} win
 * @returns {Promise<MonoStatementItem[]>}
 */
export async function statement(env, win) {
  const account = String(win.account ?? '').trim();
  if (!isMonoAccountId(account)) throw new Error('Mono statement: чужий id рахунку');
  const fromS = Math.floor(win.fromS);
  const toS = Math.floor(win.toS);
  if (!Number.isFinite(fromS) || !Number.isFinite(toS) || toS <= fromS) {
    throw new Error('Mono statement: порожнє вікно');
  }
  if (toS - fromS > STATEMENT_MAX_S) {
    throw new Error(`Mono statement: вікно понад ${STATEMENT_MAX_S} с`);
  }
  const raw = await call(
    env,
    `/personal/statement/${encodeURIComponent(account)}/${fromS}/${toS}`,
    { method: 'GET' },
    'Mono statement',
  );
  if (!Array.isArray(raw)) throw new Error('Mono statement: відповідь не список');
  const parsed = raw.map((row) => parseStatementItem(row));
  if (parsed.some((row) => row == null))
    throw new MonoApiError('Mono statement: неповна відповідь');
  return /** @type {MonoStatementItem[]} */ (parsed);
}
