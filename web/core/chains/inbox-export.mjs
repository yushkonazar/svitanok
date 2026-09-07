// InboxExport (07 §6, S-2-6, S-2-7): власник надсилає `result.json` з
// Telegram Desktop → історія чату лягає у `inbox_messages`.
//
// Навіщо Workflow, якщо подій тут немає: розбір і вставка десятків тисяч
// рядків не влазять у бюджет одного запиту, а кроки дають і продовження, і
// повтор після збою мережі. Тому кроки нарізані по батчах, а не «усе одним
// do».
//
// ⚠️ Вміст файлу - НЕДОВІРЕНИЙ (це чужі повідомлення) і чужий формат: жодного
// поля не беремо на віру, `text` буває і рядком, і масивом обʼєктів. Рядки
// лягають із `tainted = 1`, як і живі Business-повідомлення.
//
// Стеля: Telegram віддає ботам файли до 20 МБ (getFile), тож більший експорт -
// чесна відмова, а не мовчазний обрив. Кількість повідомлень теж обмежена:
// D1 на безкоштовному тарифі має добовий бюджет записів, і половина архіву
// краще за вичерпаний ліміт посеред імпорту.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { chainTarget, db, patchChainState, postChainMessage } from './state.mjs';
import { saveInboxMessage } from '../inbox/store.mjs';

export const CHAIN_KIND = 'inbox-export';
/** Стеля файлу - та сама, що в Telegram getFile. */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
/** Скільки повідомлень імпортуємо за один файл. */
export const IMPORT_MAX = 20_000;
/** Скільки рядків в одному кроці Workflow. */
export const BATCH = 500;
/** Скільки чатів приймаємо в одному файлі (експорт «усіх чатів» - інший формат). */
export const HINT_WRONG_FORMAT =
  'Це не експорт Telegram (очікую result.json з Telegram Desktop → Експорт історії чату).';

/**
 * @typedef {{ chainId: string, fileId: string, fileName?: string,
 *   chat_id?: number | string | null, thread_id?: string | null }} ExportParams
 */

/**
 * Розібрати експорт Telegram Desktop. Повертає null, коли це не він (S-2-7).
 * @param {unknown} raw
 * @returns {{ chatId: string, title: string, messages: import('../inbox/store.mjs').InboxInput[] } | null}
 */
export function parseExport(raw) {
  const root = /** @type {any} */ (raw);
  if (!root || typeof root !== 'object' || !Array.isArray(root.messages)) return null;
  if (root.id == null && root.name == null) return null;
  const title = String(root.name ?? 'Чат').slice(0, 120);
  const chatId = exportChatId(root);
  /** @type {import('../inbox/store.mjs').InboxInput[]} */
  const messages = [];
  for (const m of root.messages) {
    if (!m || typeof m !== 'object') continue;
    // service-повідомлення («приєднався до групи») - не розмова.
    if (m.type && m.type !== 'message') continue;
    if (!Number.isInteger(m.id)) continue;
    const at = exportDate(m);
    if (at == null) continue;
    const text = flattenText(m.text);
    const mediaKind = exportMedia(m);
    if (!text && !mediaKind) continue;
    messages.push({
      chatId,
      chatTitle: title,
      fromId: m.from_id == null ? null : String(m.from_id).slice(0, 40),
      fromName: String(m.from ?? '').slice(0, 120),
      messageId: Number(m.id),
      dateS: at,
      text,
      mediaKind,
      replyTo: Number.isInteger(m.reply_to_message_id) ? Number(m.reply_to_message_id) : null,
    });
  }
  if (!messages.length) return null;
  return { chatId, title, messages };
}

/**
 * id чату з експорту. Для груп Telegram Desktop дає id БЕЗ префікса -100,
 * яким той самий чат позначений у Bot API: без вирівнювання жива й
 * імпортована історія однієї групи лежали б як два різні чати.
 * @param {any} root
 */
function exportChatId(root) {
  const id = Number(root.id);
  if (!Number.isFinite(id)) return String(root.name ?? 'chat').slice(0, 40);
  const group = /group|channel|supergroup/i.test(String(root.type ?? ''));
  return group && id > 0 ? `-100${id}` : String(id);
}

/** `date_unixtime` («1714560000») або `date` («2024-05-01T12:00:00»). @param {any} m */
function exportDate(m) {
  const unix = Number(m.date_unixtime);
  if (Number.isFinite(unix) && unix > 0) return Math.floor(unix);
  const ms = Date.parse(String(m.date ?? ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * `text` буває рядком або масивом із рядків і обʼєктів `{type, text}`
 * (посилання, згадки, код). Зводимо до одного рядка.
 * @param {unknown} value
 */
export function flattenText(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      const text = /** @type {any} */ (part)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Вид вкладення - ЯРЛИК; самі файли експорту не читаються. @param {any} m */
function exportMedia(m) {
  if (typeof m.media_type === 'string' && m.media_type) return String(m.media_type).slice(0, 32);
  if (m.photo) return 'photo';
  if (m.file) return 'document';
  return null;
}

/**
 * @typedef {{ now: () => number, download: (fileId: string) => Promise<unknown>,
 *   save: (msg: import('../inbox/store.mjs').InboxInput) => Promise<{ saved: boolean }>,
 *   send: (text: string) => Promise<void> }} ExportIo
 */

/**
 * Машина станів (без платформи - для тестів).
 * @param {Env} env @param {ExportParams} params
 * @param {{ do: (name: string, fn: () => Promise<any>) => Promise<any> }} step
 * @param {ExportIo} io
 */
export async function runInboxExport(env, params, step, io) {
  const { chainId } = params;
  /** @type {any} */
  const raw = await step.do('download', () => io.download(params.fileId));
  const parsed = parseExport(raw);
  if (!parsed) {
    await step.do('reject', async () => {
      await io.send(HINT_WRONG_FORMAT);
      await patchChainState(env, chainId, 'failed', { awaiting: null, reason: 'bad-format' });
    });
    return { ok: false, reason: 'bad-format' };
  }

  const take = parsed.messages.slice(0, IMPORT_MAX);
  const skipped = parsed.messages.length - take.length;
  let imported = 0;
  for (let i = 0; i < take.length; i += BATCH) {
    const chunk = take.slice(i, i + BATCH);
    imported += /** @type {number} */ (
      await step.do(`import-${i / BATCH}`, async () => {
        let n = 0;
        for (const msg of chunk) {
          const out = await io.save(msg);
          if (out.saved) n += 1;
        }
        return n;
      })
    );
  }

  await step.do('done', async () => {
    const years = yearsOf(take);
    const tail = skipped ? ` Перші ${IMPORT_MAX} - решту (${skipped}) не брав.` : '';
    await io.send(
      `Завантажив ${imported} ${messagesWord(imported)} чату «${parsed.title}»${years}.${tail} Що шукати?`,
    );
    await patchChainState(env, chainId, 'done', {
      awaiting: null,
      chat_id_import: parsed.chatId,
      imported,
    });
  });
  return { ok: true, imported, skipped, chatId: parsed.chatId };
}

/** « за 2024-2026» або порожньо. @param {import('../inbox/store.mjs').InboxInput[]} rows */
function yearsOf(rows) {
  const years = rows
    .map((r) => (r.dateS ? new Date(r.dateS * 1000).getUTCFullYear() : null))
    .filter((y) => y != null);
  if (!years.length) return '';
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? ` за ${min}` : ` за ${min}-${max}`;
}

/** @param {number} n */
function messagesWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'повідомлення';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'повідомлення';
  return 'повідомлень';
}

/**
 * Створити ланцюг і запустити Workflow. Викликає prerouter, коли власник
 * надіслав .json у тему асистента.
 * @param {Env} env
 * @param {{ fileId: string, fileName?: string, chatId?: number | string | null, threadId?: string | null }} input
 * @param {number} nowMs
 */
export async function startInboxExport(env, input, nowMs) {
  const binding = /** @type {any} */ (env).INBOX_EXPORT;
  if (!binding) throw new Error('привʼязки Workflow INBOX_EXPORT немає');
  const chainId = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(
      `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'running', ?, ?)`,
    )
    .bind(
      chainId,
      CHAIN_KIND,
      JSON.stringify({
        file_name: String(input.fileName ?? 'result.json').slice(0, 120),
        chat_id: input.chatId ?? null,
        thread_id: input.threadId ?? null,
        awaiting: null,
      }),
      iso,
      iso,
    )
    .run();
  const instance = await binding.create({
    id: chainId,
    params: {
      chainId,
      fileId: input.fileId,
      fileName: input.fileName,
      chat_id: input.chatId ?? null,
      thread_id: input.threadId ?? null,
    },
  });
  await db(env)
    .prepare('UPDATE chains SET workflow_id = ? WHERE id = ?')
    .bind(String(instance?.id ?? chainId), chainId)
    .run();
  return { chainId };
}

/** Бойове io: файл із Telegram, запис у D1, повідомлення власнику.
 *  @param {Env} env @param {ExportParams} params @returns {ExportIo} */
export function productionIo(env, params) {
  const target = chainTarget(env, {
    chat_id: params.chat_id ?? null,
    thread_id: params.thread_id ?? null,
  });
  return {
    now: () => Date.now(),
    download: (fileId) => downloadTelegramJson(env, fileId),
    // `viaImport` вимикає ДОБОВУ стелю вхідних: вона захищає від чужого
    // потоку, а імпорт - свідома дія власника, і 5 000 рядків архіву не мають
    // «зʼїсти» ліміт живих повідомлень.
    save: (msg) => saveInboxMessage(env, { ...msg, viaImport: true }, Date.now()),
    send: (text) =>
      postChainMessage(env, target, {
        kind: 'send',
        payload: { text },
        label: `inbox-export ${params.chainId}`,
      }),
  };
}

/**
 * Завантажити JSON-файл, надісланий у Telegram. Дві межі: `file_size` з
 * getFile і реальна довжина тіла - перша економить трафік, друга не вірить
 * першій.
 * @param {Env} env @param {string} fileId
 */
export async function downloadTelegramJson(env, fileId) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не заданий - файл не завантажити');
  const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(30_000),
  });
  const info = /** @type {any} */ (await infoRes.json().catch(() => null));
  if (!infoRes.ok || !info?.ok || !info.result?.file_path) {
    // Найчастіша причина - файл понад 20 МБ: Telegram getFile такі не віддає.
    throw new Error(`Telegram getFile: ${info?.description ?? `HTTP ${infoRes.status}`}`);
  }
  const size = Number(info.result.file_size);
  if (Number.isFinite(size) && size > FILE_MAX_BYTES) {
    throw new Error(`Файл ${Math.round(size / 1024 / 1024)} МБ - більше за стелю 20 МБ`);
  }
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${info.result.file_path}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!fileRes.ok) throw new Error(`Telegram file: HTTP ${fileRes.status}`);
  const text = await fileRes.text();
  if (text.length > FILE_MAX_BYTES) throw new Error('Файл більший за стелю 20 МБ');
  try {
    return JSON.parse(text);
  } catch {
    // Не JSON - це вже відповідь S-2-7, і машина станів скаже її словами.
    return null;
  }
}

/** Workflow-клас (wrangler.jsonc `workflows`, worker.js export). */
export class InboxExport extends WorkflowEntrypoint {
  /**
   * @override
   * @param {any} event - WorkflowEvent<ExportParams>
   * @param {any} step - WorkflowStep
   */
  async run(event, step) {
    const env = /** @type {Env} */ (this.env);
    const params = /** @type {ExportParams} */ (event.payload);
    try {
      return await runInboxExport(env, params, step, productionIo(env, params));
    } catch (/** @type {any} */ e) {
      console.error(`inbox-export ${params.chainId} впав`, e?.message);
      await productionIo(env, params)
        .send(`Не вийшло розібрати експорт: ${String(e?.message ?? e)}`)
        .catch(() => {});
      await patchChainState(env, params.chainId, 'failed', { awaiting: null }).catch(
        (/** @type {any} */ e2) =>
          console.error(`inbox-export ${params.chainId}: статус failed не записано`, e2?.message),
      );
      throw e;
    }
  }
}
