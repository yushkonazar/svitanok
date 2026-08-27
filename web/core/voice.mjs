// Голос (кейс 6, 01 §3.3, ADR-010/ADR-040): getFile → завантаження аудіо →
// Deepgram nova-3 (language=uk) → транскрипт; Deepgram недоступний → Workers AI
// Whisper з позначкою «(резервний розпізнавач)». Аудіо ніде не зберігається -
// байти живуть лише в памʼяті одного виклику. Квота deepgram_min рахується
// ПІСЛЯ успішної відповіді Deepgram (хвилини вже спожиті, навіть якщо тиша).
//
// Відсутній DEEPGRAM_API_KEY - НЕ привід тихо зʼїхати на резерв: misconfig
// відрізняється від збою і має бути видимим (S-6-3/S-6-5 - фолбек лише при
// ЗБОЯХ живого сервісу: 5xx, вичерпаний кредит, мережа).

import { bumpQuota, QUOTA_LIMITS } from './quota/quota.mjs';

/** Стеля getFile Bot API - більше Telegram просто не віддасть (01 §3.3). */
export const VOICE_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Довге голосове (S-6-4): понад 5 хв - спершу питаємо «Розпізнати?». */
export const VOICE_LONG_S = 300;
/** Стеля транскрипта - як summary_md у SESSION_SCHEMA: довше не потрібне ні
 *  повідомленню, ні прогону. Зріз чесно позначається трьома крапками. */
export const VOICE_TRANSCRIPT_MAX_CHARS = 20_000;

const DEEPGRAM_URL =
  'https://api.deepgram.com/v1/listen?model=nova-3&language=uk&smart_format=true';
const DEEPGRAM_TIMEOUT_MS = 30_000;
// Резерв - Workers AI (ADR-010). turbo-варіант: приймає base64, WER для uk
// відомий з бенчмарка (~23 %) - тому лише резерв, і з позначкою.
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

/**
 * @typedef {{ ok: true, text: string, fallback: boolean }
 *         | { ok: false, error: 'misconfigured' | 'too-big' | 'failed' }} TranscribeResult
 */

/**
 * Повний шлях «file_id → текст». Порожній text при ok:true - «Не розчув»
 * (S-6-2): розпізнавач відпрацював, але слів не почув.
 * @param {Env} env
 * @param {{ fileId: string, durationS: number, fileSize?: number | null }} voice
 * @param {number} [nowMs]
 * @returns {Promise<TranscribeResult>}
 */
export async function transcribeVoice(env, voice, nowMs = Date.now()) {
  if (!env.DEEPGRAM_API_KEY) {
    console.error('voice: DEEPGRAM_API_KEY відсутній - розпізнавання не налаштоване');
    return { ok: false, error: 'misconfigured' };
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error('voice: TELEGRAM_BOT_TOKEN відсутній');
    return { ok: false, error: 'misconfigured' };
  }
  if (voice.fileSize != null && voice.fileSize > VOICE_MAX_FILE_BYTES) {
    return { ok: false, error: 'too-big' };
  }

  const audio = await downloadVoice(env, voice.fileId);
  if (!audio) return { ok: false, error: 'failed' };
  if (audio.byteLength > VOICE_MAX_FILE_BYTES) return { ok: false, error: 'too-big' };

  const dg = await deepgramTranscribe(env, audio);
  if (dg.ok) {
    // Хвилини Deepgram спожиті фактом виклику - облік не залежить від того,
    // чи розчув він щось; збій обліку не має губити транскрипт.
    await bumpQuota(env, {
      key: 'deepgram_min',
      amount: Math.max(voice.durationS, 1) / 60,
      limit: /** @type {number} */ (QUOTA_LIMITS.deepgram_min),
      nowMs,
    }).catch((/** @type {any} */ e) => console.error('voice: квота deepgram_min', e?.message));
    return { ok: true, text: clipTranscript(dg.text), fallback: false };
  }

  // S-6-3/S-6-5: Deepgram упав (5xx / кредит / мережа) - резерв Whisper, явно.
  const wh = await whisperTranscribe(env, audio);
  if (!wh.ok) return { ok: false, error: 'failed' };
  return { ok: true, text: clipTranscript(wh.text), fallback: true };
}

/** getFile → сам файл. Помилка будь-якого з двох кроків - null (транспорт).
 *  ⚠️ URL файлу містить токен бота - у логи йдуть лише статуси, ніколи URL.
 *  @param {Env} env @param {string} fileId
 *  @returns {Promise<ArrayBuffer | null>} */
async function downloadVoice(env, fileId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const body = /** @type {any} */ (await res.json().catch(() => null));
    const filePath = body?.result?.file_path;
    if (!res.ok || typeof filePath !== 'string' || !filePath) {
      console.error(`voice: getFile HTTP ${res.status}, file_path ${filePath ? 'є' : 'немає'}`);
      return null;
    }
    const file = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
    );
    if (!file.ok) {
      console.error(`voice: завантаження файлу HTTP ${file.status}`);
      return null;
    }
    return await file.arrayBuffer();
  } catch (/** @type {any} */ e) {
    console.error('voice: завантаження голосового впало', e?.message);
    return null;
  }
}

/** @param {Env} env @param {ArrayBuffer} audio
 *  @returns {Promise<{ ok: true, text: string } | { ok: false }>} */
async function deepgramTranscribe(env, audio) {
  try {
    const res = await fetch(DEEPGRAM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        // Голосові Telegram - завжди ogg/opus (Bot API це гарантує).
        'content-type': 'audio/ogg',
      },
      body: audio,
      signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `voice: Deepgram HTTP ${res.status}`,
        (await res.text().catch(() => '')).slice(0, 200),
      );
      return { ok: false };
    }
    const body = /** @type {any} */ (await res.json().catch(() => null));
    const text = body?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof text !== 'string') {
      console.error('voice: Deepgram відповів без transcript');
      return { ok: false };
    }
    return { ok: true, text: text.trim() };
  } catch (/** @type {any} */ e) {
    console.error('voice: Deepgram недоступний', e?.message);
    return { ok: false };
  }
}

/** Резерв (ADR-010): Workers AI Whisper. ogg/opus напряму - UNKNOWN до
 *  прод-проби (чеклист приймання етапу 2); збій тут - чесна відмова вище.
 *  @param {Env} env @param {ArrayBuffer} audio
 *  @returns {Promise<{ ok: true, text: string } | { ok: false }>} */
async function whisperTranscribe(env, audio) {
  if (!env.AI) {
    console.error('voice: привʼязки AI немає - резервний розпізнавач недоступний');
    return { ok: false };
  }
  try {
    const out = /** @type {{ text?: string } | undefined} */ (
      await env.AI.run(/** @type {never} */ (WHISPER_MODEL), { audio: toBase64(audio) })
    );
    if (typeof out?.text !== 'string') {
      console.error('voice: Whisper відповів без text');
      return { ok: false };
    }
    return { ok: true, text: out.text.trim() };
  } catch (/** @type {any} */ e) {
    console.error('voice: Whisper упав', e?.message);
    return { ok: false };
  }
}

/** btoa на чанках: String.fromCharCode(...весь буфер) переповнив би стек.
 *  @param {ArrayBuffer} buf */
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Зріз по код-поїнтах (не рвати сурогатну пару), з чесною позначкою.
 *  @param {string} text */
function clipTranscript(text) {
  if (text.length <= VOICE_TRANSCRIPT_MAX_CHARS) return text;
  return [...text].slice(0, VOICE_TRANSCRIPT_MAX_CHARS - 1).join('') + '…';
}
