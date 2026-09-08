// InboxExport (07 §6, S-2-6, S-2-7): власник надсилає `result.json` з
// Telegram Desktop → історія чату лягає у `inbox_messages`.
//
// Навіщо Workflow, якщо подій тут немає: два платформні бюджети на Workers
// Free - 50 ПІДЗАПИТІВ і 10 мс CPU на виклик - не дають зробити імпорт одним
// запитом, а кожен крок Workflow має власний бюджет. Тому кроки нарізані по
// шматках повідомлень.
//
// ⚠️ Через межу кроку не можна передавати розібраний експорт: стеля стану
// кроку - 1 МіБ. Тому кожен крок сам завантажує й розбирає файл, а повертає
// лише невеликий підсумок. Ціна - повторне завантаження на крок; вона й
// диктує стелю розміру файлу нижче.
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
import { saveInboxBatch } from '../inbox/store.mjs';

export const CHAIN_KIND = 'inbox-export';
/**
 * Стеля розміру файлу. Telegram віддає ботам до 20 МБ, але тут вирішує НЕ
 * Telegram: кожен крок розбирає файл заново, а на Workers Free крок має 10 мс
 * CPU. `JSON.parse` мегабайта - вже на межі цього бюджету, тож більший експорт
 * ми чесно відмовляємось читати замість того, щоб гинути на «Exceeded CPU».
 * Це видима межа безкоштовного плану, а не властивість формату.
 */
export const FILE_MAX_BYTES = 1024 * 1024;
/** Скільки повідомлень імпортуємо за один файл. */
export const IMPORT_MAX = 5_000;
/** Скільки повідомлень бере один крок (2 підзапити на завантаження + 2 на пачку). */
export const MESSAGES_PER_STEP = 500;
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
 *   saveMany: (msgs: import('../inbox/store.mjs').InboxInput[])
 *     => Promise<{ inserted: number, present: number }>,
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
  // Перший крок - розвідка: розбирає файл і каже, СКІЛЬКИ там повідомлень.
  // Повертає лише числа й назву, тож стеля стану кроку (1 МіБ) недосяжна.
  const head = /** @type {{ ok: boolean, total?: number, chatId?: string, title?: string }} */ (
    await step.do('probe', async () => {
      const parsed = parseExport(await io.download(params.fileId));
      if (!parsed) return { ok: false };
      return {
        ok: true,
        total: parsed.messages.length,
        chatId: parsed.chatId,
        title: parsed.title,
      };
    })
  );

  if (!head.ok) {
    await step.do('reject', async () => {
      await io.send(HINT_WRONG_FORMAT);
      await patchChainState(env, chainId, 'failed', { awaiting: null, reason: 'bad-format' });
    });
    return { ok: false, reason: 'bad-format' };
  }

  const total = Number(head.total ?? 0);
  const take = Math.min(total, IMPORT_MAX);
  const skipped = total - take;
  let stored = 0;
  let years = '';
  for (let from = 0; from < take; from += MESSAGES_PER_STEP) {
    const slice = /** @type {{ stored: number, years: string }} */ (
      await step.do(`import-${from / MESSAGES_PER_STEP}`, async () => {
        // Розбираємо заново: передати сюди готовий масив через межу кроку
        // не можна (1 МіБ), а тримати його в памʼяті між кроками - нічим.
        const parsed = parseExport(await io.download(params.fileId));
        if (!parsed) return { stored: 0, years: '' };
        const chunk = parsed.messages.slice(from, from + MESSAGES_PER_STEP);
        const out = await io.saveMany(chunk);
        // `present` теж рахуємо: повтор кроку після збою мусить дати власнику
        // «скільки повідомлень тепер у базі», а не «скільки додав саме цей раз».
        return { stored: out.inserted + out.present, years: yearsOf(chunk) };
      })
    );
    stored += slice.stored;
    if (!years) years = slice.years;
  }

  await step.do('done', async () => {
    const tail = skipped ? ` Перші ${IMPORT_MAX} - решту (${skipped}) не брав.` : '';
    await io.send(
      `Завантажив ${stored} ${messagesWord(stored)} чату «${head.title}»${years}.${tail} Що шукати?`,
    );
    await patchChainState(env, chainId, 'done', {
      awaiting: null,
      chat_id_import: head.chatId,
      imported: stored,
    });
  });
  return { ok: true, imported: stored, skipped, chatId: head.chatId };
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
    // Пачками, а не поштучно: на Free 50 підзапитів на крок, а поштучний
    // запис коштує два. Добова стеля вхідних тут не діє взагалі - вона
    // захищає від чужого потоку, а імпорт це свідома дія власника.
    saveMany: (msgs) => saveInboxBatch(env, msgs, Date.now()),
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
    throw new Error(tooBig(size));
  }
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${info.result.file_path}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!fileRes.ok) throw new Error(`Telegram file: HTTP ${fileRes.status}`);
  const text = await fileRes.text();
  if (text.length > FILE_MAX_BYTES) throw new Error(tooBig(text.length));
  try {
    return JSON.parse(text);
  } catch {
    // Не JSON - це вже відповідь S-2-7, і машина станів скаже її словами.
    return null;
  }
}

/** Текст відмови по розміру - з причиною і з тим, що робити. @param {number} size */
export function tooBig(size) {
  return `Файл ${Math.round(size / 1024)} КБ, а я читаю до ${Math.round(FILE_MAX_BYTES / 1024)} КБ - експортуй коротший період (без медіа).`;
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
