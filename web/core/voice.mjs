// Голос (кейс 6, 01 §3.3, ADR-010/ADR-040): getFile → завантаження аудіо →
// Deepgram nova-3 (language=uk) → транскрипт; Deepgram НЕДОСТУПНИЙ → Workers AI
// Whisper з позначкою «(резервний розпізнавач)». Аудіо ніде не зберігається -
// байти живуть лише в памʼяті одного виклику. Квота deepgram_min рахується
// ПІСЛЯ успішної відповіді Deepgram (хвилини вже спожиті, навіть якщо тиша).
//
// Межа «misconfig ≠ збій» тримається в обидва боки (ревʼю PR-4): відсутній
// DEEPGRAM_API_KEY і відмова автентифікації (401/403) - це misconfigured, і
// резерв їх НЕ ховає, інакше битий ключ роками віддавав би гірший Whisper, а
// deepgram_min показував би нуль. Резерв - лише для збоїв живого сервісу:
// 5xx, вичерпаний кредит, таймаут, мережа (S-6-3/S-6-5).

import { bumpQuota, QUOTA_LIMITS } from './quota/quota.mjs';

/** Стеля getFile Bot API - більше Telegram просто не віддасть (01 §3.3). */
export const VOICE_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Стеля РЕЗЕРВУ (ревʼю PR-4): Whisper приймає base64, тож 20 МБ аудіо дають
 *  у памʼяті ізоляту буфер + бінарний рядок + base64 (~90 МБ при стелі 128).
 *  Гілка існує для обробки збоїв - вона не має падати сама. */
export const VOICE_FALLBACK_MAX_BYTES = 4 * 1024 * 1024;
/** Довге голосове (S-6-4): понад 5 хв - спершу питаємо «Розпізнати?». */
export const VOICE_LONG_S = 300;
/** Стеля транскрипта - як summary_md у SESSION_SCHEMA: довше не потрібне ні
 *  повідомленню, ні прогону. Зріз чесно позначається трьома крапками. */
export const VOICE_TRANSCRIPT_MAX_CHARS = 20_000;

const DEEPGRAM_URL =
  'https://api.deepgram.com/v1/listen?model=nova-3&language=uk&smart_format=true';
const DEEPGRAM_TIMEOUT_MS = 30_000;
// Телеграм теж мусить мати стелю (ревʼю PR-4): без неї підвисле зʼєднання
// тримає waitUntil-задачу вебхука до вбивства ізоляту, і власник не бачить
// навіть «не вдалося».
const TELEGRAM_TIMEOUT_MS = 15_000;
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

  const dl = await downloadVoice(env, voice.fileId);
  if (!dl.ok) return { ok: false, error: dl.error };
  const audio = dl.audio;
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
    return { ok: true, text: clipVoiceText(dg.text), fallback: false };
  }
  // Битий ключ - НЕ збій сервісу: резерв тут приховав би конфіг назавжди.
  if (dg.error === 'auth') return { ok: false, error: 'misconfigured' };

  // S-6-3/S-6-5: Deepgram упав (5xx / кредит / мережа) - резерв Whisper, явно.
  const wh = await whisperTranscribe(env, audio);
  if (!wh.ok) return { ok: false, error: 'failed' };
  return { ok: true, text: clipVoiceText(wh.text), fallback: true };
}

/**
 * getFile → сам файл. ⚠️ URL файлу містить токен бота - у логи йдуть лише
 * статуси, ніколи URL. «file is too big» від Telegram віддається окремо: інакше
 * власник читав би «спробуй ще раз» про файл, який не приїде ніколи.
 * @param {Env} env @param {string} fileId
 * @returns {Promise<{ ok: true, audio: ArrayBuffer } | { ok: false, error: 'too-big' | 'failed' }>}
 */
async function downloadVoice(env, fileId) {
  try {
    // НЕ tgCall: той на не-2xx сам читає тіло у лог, і `description` («file is
    // too big») сюди вже не доїде - той самий мотив, що в outbox.mjs.
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const body = /** @type {any} */ (await res.json().catch(() => null));
    const filePath = body?.result?.file_path;
    if (!res.ok || typeof filePath !== 'string' || !filePath) {
      const why = String(body?.description ?? '');
      console.error(`voice: getFile HTTP ${res.status} (${why.slice(0, 80)})`);
      return { ok: false, error: /too big/i.test(why) ? 'too-big' : 'failed' };
    }
    // file_path приходить з чужого процесу: сегменти кодуються окремо, «..» не
    // проходить взагалі - шлях у URL збирається З КОДУ, не конкатенацією даних.
    if (filePath.split('/').some((seg) => seg === '..' || seg === '')) {
      console.error('voice: getFile віддав підозрілий file_path');
      return { ok: false, error: 'failed' };
    }
    const safePath = filePath.split('/').map(encodeURIComponent).join('/');
    const file = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${safePath}`,
      { signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) },
    );
    if (!file.ok) {
      console.error(`voice: завантаження файлу HTTP ${file.status}`);
      return { ok: false, error: 'failed' };
    }
    return { ok: true, audio: await file.arrayBuffer() };
  } catch (/** @type {any} */ e) {
    console.error('voice: завантаження голосового впало', e?.message);
    return { ok: false, error: 'failed' };
  }
}

/** @param {Env} env @param {ArrayBuffer} audio
 *  @returns {Promise<{ ok: true, text: string } | { ok: false, error: 'auth' | 'down' }>} */
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
      return { ok: false, error: res.status === 401 || res.status === 403 ? 'auth' : 'down' };
    }
    const body = /** @type {any} */ (await res.json().catch(() => null));
    const text = body?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof text !== 'string') {
      console.error('voice: Deepgram відповів без transcript');
      return { ok: false, error: 'down' };
    }
    return { ok: true, text: text.trim() };
  } catch (/** @type {any} */ e) {
    console.error('voice: Deepgram недоступний', e?.message);
    return { ok: false, error: 'down' };
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
  if (audio.byteLength > VOICE_FALLBACK_MAX_BYTES) {
    console.error(
      `voice: ${audio.byteLength} Б завеликі для резерву (стеля ${VOICE_FALLBACK_MAX_BYTES})`,
    );
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

/* ── voice_pending: стан між кнопками v: і тапом (0009, ADR-040) ────────────
   callback_data ≤ 64 байт не вміщає ні транскрипт, ні file_id - вони чекають
   тапу в D1. Тап робить CLAIM (claimed_at), а не видалення: довга робота після
   нього може впасти, і тоді ряд треба повернути в гру, інакше кнопка знята, а
   file_id уже нема - глухий кут (ревʼю PR-4). Чистка протухлих - принагідно
   при вставці, окремого сторожа немає. */

/** Транскрипт - це КОМАНДА, чия дія залежить від моменту: підтверджене через
 *  півгодини «стоп» обірвало б уже інший прогін. Тому вікно коротке, не 30 хв
 *  proposals (ревʼю PR-4). */
export const VOICE_PENDING_TTL_MS = 5 * 60_000;
/** Скільки claim вважається живим: довше за найдовший шлях (getFile 15 с +
 *  Deepgram 30 с), але достатньо коротко, щоб мертвий тап відпустив ряд. */
export const VOICE_CLAIM_STALE_MS = 90_000;

/**
 * @typedef {{ kind: 'transcript', text: string } | { kind: 'file', fileId: string }} VoicePayload
 * @typedef {{ kind: string, text: string | null, fileId: string | null, durationS: number,
 *   chatId: string | null, threadId: string | null }} PendingVoice
 */

/**
 * Покласти очікування тапу. Повертає короткий id для v:<id>:<choice>.
 * @param {Env} env
 * @param {VoicePayload & { durationS: number, chatId: number | string | null,
 *   threadId: number | string | null }} entry
 * @param {number} nowMs
 */
export async function savePendingVoice(env, entry, nowMs) {
  if (!env.DB) throw new Error('привʼязки DB немає - voice_pending недоступна');
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  // batch: чистка протухлих і вставка - один раунд-трип до D1.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM voice_pending WHERE created_at < ?').bind(
      new Date(nowMs - VOICE_PENDING_TTL_MS).toISOString(),
    ),
    env.DB.prepare(
      `INSERT INTO voice_pending (id, kind, text, file_id, duration_s, chat_id, thread_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      entry.kind,
      entry.kind === 'transcript' ? entry.text : null,
      entry.kind === 'file' ? entry.fileId : null,
      Math.round(entry.durationS),
      entry.chatId == null ? null : String(entry.chatId),
      entry.threadId == null ? null : String(entry.threadId),
      new Date(nowMs).toISOString(),
    ),
  ]);
  return id;
}

/**
 * Взяти очікування тапу в роботу. CAS через `claimed_at IS NULL`: другий
 * одночасний тап не отримає нічого. Ряд ЛИШАЄТЬСЯ - його закриває
 * finishPendingVoice після відомого результату. Протухле - теж null.
 * @param {Env} env
 * @param {string} id
 * @param {number} nowMs
 * @returns {Promise<PendingVoice | null>}
 */
export async function claimPendingVoice(env, id, nowMs) {
  if (!env.DB) return null;
  const { results } = await env.DB.prepare(
    `UPDATE voice_pending SET claimed_at = ?1
     WHERE id = ?2 AND (claimed_at IS NULL OR claimed_at < ?3)
     RETURNING *`,
  )
    .bind(new Date(nowMs).toISOString(), id, new Date(nowMs - VOICE_CLAIM_STALE_MS).toISOString())
    .all();
  const row = /** @type {any} */ (results?.[0]);
  if (!row) return null;
  if (Date.parse(row.created_at) < nowMs - VOICE_PENDING_TTL_MS) {
    await finishPendingVoice(env, id, true);
    return null;
  }
  return {
    kind: row.kind,
    text: row.text ?? null,
    fileId: row.file_id ?? null,
    durationS: Number(row.duration_s) || 0,
    chatId: row.chat_id ?? null,
    threadId: row.thread_id ?? null,
  };
}

/**
 * Закрити claim: done=true - ряд відпрацював і йде геть; done=false - робота
 * не вдалася, ряд повертається в гру (кнопка під повідомленням ще жива, тап
 * можна повторити, доки не мине TTL).
 * @param {Env} env @param {string} id @param {boolean} done
 */
export async function finishPendingVoice(env, id, done) {
  if (!env.DB) return;
  const sql = done
    ? 'DELETE FROM voice_pending WHERE id = ?'
    : 'UPDATE voice_pending SET claimed_at = NULL WHERE id = ?';
  await env.DB.prepare(sql)
    .bind(id)
    .run()
    .catch((/** @type {any} */ e) => console.error('voice: закриття claim-у впало', e?.message));
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

/** Зріз по код-поїнтах (не рвати сурогатну пару), з чесною позначкою. Ім'я НЕ
 *  clipTranscript: так зветься експорт agent-core.mjs з іншою стелею і іншим
 *  маркером, і два однойменні зрізи в одному домені плутають (ревʼю PR-4).
 *  @param {string} text */
function clipVoiceText(text) {
  if (text.length <= VOICE_TRANSCRIPT_MAX_CHARS) return text;
  return [...text].slice(0, VOICE_TRANSCRIPT_MAX_CHARS - 1).join('') + '…';
}
