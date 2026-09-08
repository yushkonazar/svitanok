// Адаптер Gemini API (ADR-012, ADR-034, S-8-5/S-8-6, етап 7 PR-3): зображення
// (T1) і відео (T2). Ключі - лише тут.
//
// ⚠️ FREE TIER ЗАБОРОНЕНИЙ У КОДІ. Google вчиться на даних безкоштовного
// рівня, тож «випадково поїхати на free» тут - не дрібниця, а витік. Барʼєрів
// два, і обидва позитивні (щось має бути ЯВНО задане, інакше відмова):
//   1. `GEMINI_API_KEY` - ключ проєкту з білінгом; фолбеку без ключа немає
//      взагалі, тобто «безключового» шляху в коді не існує.
//   2. `GEMINI_TIER` (plaintext var у wrangler.jsonc) мусить дорівнювати
//      'paid'. Це свідоме твердження власника «білінг увімкнено», яке видно
//      на код-ревʼю в репозиторії, а не десь у дашборді. Доки там не 'paid' -
//      генерація відмовляє з поясненням.
// Розрізнити рівень за самою відповіддю API неможливо, тож перевіряти більше
// нема чого: єдиний чесний контроль - той, який власник ставить сам.

/** Базовий URL Generative Language API. */
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
/** Модель зображень (Flash Image, S-8-5). */
export const IMAGE_MODEL = 'gemini-2.5-flash-image';
/** Моделі відео: повна і Lite (S-8-6 «дешевше - Lite»). */
export const VIDEO_MODELS = Object.freeze({
  veo: 'veo-3.0-generate-001',
  lite: 'veo-3.0-fast-generate-001',
});
const GEMINI_TIMEOUT_MS = 60_000;
/** Скільки чекаємо готове відео (Veo рендерить хвилинами). */
export const VIDEO_POLL_MAX_MS = 8 * 60_000;
export const VIDEO_POLL_STEP_MS = 10_000;

/** Ціни (ADR-012, VERIFIED на момент рішення): $0.04 за зображення, $0.40/с
 *  за Veo, $0.075/с за Lite. Тримаються тут, поруч із викликом, який їх і
 *  витрачає. */
export const IMAGE_USD = 0.04;
export const VIDEO_USD_PER_SEC = 0.4;
export const VIDEO_LITE_USD_PER_SEC = 0.075;
/** Довжина відео за замовчуванням - та, для якої в каноні названа ціна. */
export const VIDEO_DEFAULT_SECONDS = 8;
export const VIDEO_MAX_SECONDS = 8;

/**
 * Ціна відео в доларах для показу ДО витрати.
 * @param {number} seconds @param {'veo' | 'lite'} model
 */
export function videoUsd(seconds, model) {
  const perSec = model === 'lite' ? VIDEO_LITE_USD_PER_SEC : VIDEO_USD_PER_SEC;
  return Math.round(seconds * perSec * 100) / 100;
}

/**
 * Барʼєр платного рівня. Кидає з текстом для власника - мовчазного шляху на
 * free tier не існує.
 * @param {Env} env
 * @returns {string} ключ
 */
export function requirePaidGemini(env) {
  const key = String(env.GEMINI_API_KEY ?? '').trim();
  if (!key) throw new Error('GEMINI_API_KEY не задано - генерація недоступна');
  if (String(env.GEMINI_TIER ?? '').trim() !== 'paid') {
    throw new Error(
      'Gemini не переведено на платний рівень: у wrangler.jsonc GEMINI_TIER != "paid". ' +
        'Free tier навчається на даних, тому код на нього не ходить (ADR-012).',
    );
  }
  return key;
}

/** @param {string} url @param {RequestInit} init @param {number} [timeoutMs] */
async function geminiFetch(url, init, timeoutMs = GEMINI_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Ключ у URL не буває: він іде заголовком, тож у текст помилки не
      // потрапляє навіть випадково.
      throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return /** @type {any} */ (await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Зображення за prompt-ом власника (S-8-5). Повертає байти й mime.
 * @param {Env} env @param {{ prompt: string }} input
 * @returns {Promise<{ bytes: Uint8Array, mime: string }>}
 */
export async function generateImage(env, input) {
  const key = requirePaidGemini(env);
  const json = await geminiFetch(`${GEMINI_API}/models/${IMAGE_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: input.prompt }] }] }),
  });
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((/** @type {any} */ p) => p?.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    // Модель могла відповісти текстом (відмова політики Google) - це не
    // «порожньо», це причина, і власник має її почути.
    const text = parts.find((/** @type {any} */ p) => typeof p?.text === 'string')?.text;
    throw new Error(
      `Gemini не повернув зображення${text ? `: ${String(text).slice(0, 200)}` : ''}`,
    );
  }
  return { bytes: base64ToBytes(inline.data), mime: String(inline.mimeType ?? 'image/png') };
}

/**
 * Відео за prompt-ом власника (S-8-6): довга операція + опитування + вивантаження.
 * @param {Env} env
 * @param {{ prompt: string, seconds: number, model: 'veo' | 'lite' }} input
 * @param {{ nowMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ bytes: Uint8Array, mime: string }>}
 */
export async function generateVideo(env, input, opts = {}) {
  const key = requirePaidGemini(env);
  const model = VIDEO_MODELS[input.model] ?? VIDEO_MODELS.veo;
  const started = await geminiFetch(`${GEMINI_API}/models/${model}:predictLongRunning`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt: input.prompt }],
      parameters: { durationSeconds: input.seconds },
    }),
  });
  const opName = String(started?.name ?? '');
  if (!opName) throw new Error('Gemini не повернув операцію відео');

  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = (opts.nowMs ?? Date.now()) + VIDEO_POLL_MAX_MS;
  /** @type {any} */
  let op = started;
  while (!op?.done) {
    if ((opts.nowMs ?? Date.now()) > deadline) {
      // Гроші вже витрачені - мовчати про це не можна.
      throw new Error('Відео не встигло за 8 хв; кошти вже списані, спробуй коротший запит');
    }
    await sleep(VIDEO_POLL_STEP_MS);
    op = await geminiFetch(`${GEMINI_API}/${opName}`, { headers: { 'x-goog-api-key': key } });
  }
  if (op?.error) throw new Error(`Gemini: ${String(op.error?.message ?? 'відео не згенеровано')}`);
  const sample = op?.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
  const uri = String(sample?.uri ?? '');
  if (!uri) throw new Error('Gemini не повернув посилання на відео');
  // Адреса приходить із відповіді API, а ми шлемо на неї КЛЮЧ. Довіряти
  // чужому полю в такому місці не варто навіть тоді, коли джерело надійне:
  // одна перевірка хоста знімає весь клас «секрет поїхав не туди»
  // (security-ревʼю етапу 7).
  if (!isGoogleHost(uri)) throw new Error('Gemini: посилання на відео не з домену Google');
  // Ключ - ЗАГОЛОВКОМ, не параметром URL (05-ops §2: секрет ніколи в URL).
  const res = await fetch(uri, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error(`Gemini: відео не вивантажилось (HTTP ${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: 'video/mp4' };
}

/** Чи адреса належить Google - лише туди можна слати ключ. @param {string} uri */
export function isGoogleHost(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'googleapis.com' || host.endsWith('.googleapis.com');
  } catch {
    return false;
  }
}

/** base64 → байти (без Buffer: Workers). @param {string} b64 */
function base64ToBytes(b64) {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
