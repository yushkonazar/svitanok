// Чиста логіка Telegram-вебхука (P0/P1): парсинг апдейтів, перевірка secret-token,
// власник, дедуп, callback_data (кодування/декодування), резолв callback → подія
// для recordEvent. Без I/O — щоб покрити тестами (worker.js імпортує це, KV/HTTP
// робить Worker). Дзеркалить кілька примітивів дашборда (textHash) — щоб чат і
// Mini App домовлялись про ідентичність збереженого.

export const CB_VERSION = 'v1';

/**
 * Апдейт Telegram після нормалізації — розрізняльний союз за `kind`.
 * @typedef {{ kind: 'callback', updateId: number|null, callbackId: string|null,
 *             fromId: number|null, chatId: number|null, messageId: number|null,
 *             threadId: number|null, data: string, replyMarkup: KvBlob|null }} ParsedCallback
 * @typedef {{ kind: 'message', updateId: number|null, fromId: number|null,
 *             chatId: number|null, messageId: number|null, threadId: number|null,
 *             text: string, location: { latitude: number, longitude: number }|null,
 *             voice: { fileId: string, durationS: number, fileSize: number|null }|null }} ParsedMessage
 * @typedef {{ kind: 'other', updateId: number|null }} ParsedOther
 * @typedef {ParsedCallback|ParsedMessage|ParsedOther} ParsedUpdate
 */

/**
 * Куди слати відповідь. Окремо від ParsedUpdate з двох причин: у крон-контексті
 * вхідного апдейту немає взагалі, а обробники дістають уже обрану гілку союзу.
 *
 * Усі поля опційні НАВМИСНО: parseUpdate віддає `chatId: null`, коли Telegram
 * його не дав, і робити тут поле обовʼязковим означало б описувати не те, що
 * справді приходить.
 * @typedef {{ chatId?: string|number|null, threadId?: string|number|null,
 *             messageId?: number|null }} SendTarget
 */

// Дзеркало textHash з web/public/index.html — стабільний ID для обраного без url
// (факт/цитата). МАЄ збігатися символ-у-символ, інакше чат і дашборд дедуплять
// збереження по-різному.
export function textHash(/** @type {unknown} */ s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Дзеркало escapeHtml з src/core/telegram.ts — Worker не імпортує TS.
// Екранує й `"` (атрибут-безпека href, як у TS-оригіналі).
export function escapeHtml(/** @type {unknown} */ s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Markdown моделі -> HTML Telegram (для вільного тексту асистента).
 *
 * LLM пише Markdown за замовчуванням — так навчена будь-яка. А `reply` йшов у
 * Telegram БЕЗ parse_mode, тобто голим текстом: власник бачив дослівні
 * `**жирний**` і рядки `---`.
 *
 * ⚠️ ПОРЯДОК ТУТ — ЦЕ БЕЗПЕКА, а не косметика. У відповідь асистента потрапляє
 * сторонній текст (теми листів, імена відправників, назви файлів у Drive), тож
 * спершу екрануємо ВСЕ, і лише потім вставляємо власні теги. Наслідок:
 * у виводі не може виявитись тега, якого ми туди не поставили — навіть якщо
 * лист містить `<script>` чи `&`.
 *
 * Другий інваріант — вивід ЗАВЖДИ валідний HTML. Конвертуємо лише ПАРНІ
 * маркери; непарна зірочка лишається текстом. Якби ми віддали Telegram
 * незакритий тег, той відповів би 400, і повідомлення просто зникло б.
 *
 * Свідомо НЕ підтримуємо: таблиці, посилання [text](url), fenced-блоки ```.
 * Асистент ними не користується, а кожна така конструкція — ще один шлях
 * зібрати невалідну розмітку.
 * @param {unknown} text
 */
export function mdToTelegramHtml(text) {
  const src = String(text ?? '');
  if (!src) return '';
  // Вміст `code` ховаємо в плейсхолдери ДО решти перетворень — інакше `**` чи
  // `_` всередині коду перетворились би на теги. Маркер `<C0>` безпечний саме
  // тому, що escapeHtml уже відпрацював: після нього `<` у тексті бути НЕ може,
  // отже підміна назад не зачепить нічого, крім наших власних вставок.
  /** @type {string[]} */
  const codes = [];
  let out = escapeHtml(src).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `<C${codes.length - 1}>`;
  });
  out = out
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '') // --- *** ___ -> порожній рядок
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>') // ## Заголовок
    .replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([^\n]+?)__/g, '<b>$1</b>')
    // Курсив: маркер лише на межі слова, інакше «2 * 3 = 6» стало б тегом.
    .replace(/(^|[\s(])\*([^\s*][^\n*]*?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^\s_][^\n_]*?)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/^\s*[-*]\s+/gm, '• ');
  return out.replace(/<C(\d+)>/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/** Дзеркало link() з src/core/telegram.ts — url і text екрануються ОКРЕМО
 *  (не конкатенувати перед екрануванням — інакше лапка в url ламає href). */
export function link(/** @type {unknown} */ url, /** @type {unknown} */ text) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

/**
 * Константночасне порівняння двох рядків — без короткого замикання, тож не
 * зливає позицію першого розбіжного символу (той самий мотив, що timingSafeEqual
 * у agent-run-core). Різна довжина або не-рядок -> false. Спільне ядро
 * verifyWebhookSecret (secret-token вебхука) і HMAC-звірки initData у worker.js.
 * @param {unknown} a
 * @param {unknown} b
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Константний-час порівняння secret-token (X-Telegram-Bot-Api-Secret-Token).
 *  @param {unknown} header
 *  @param {unknown} secret */
export function verifyWebhookSecret(header, secret) {
  if (typeof secret !== 'string' || !secret) return false; // порожній секрет — не автентифікуємо
  return constantTimeEqual(header, secret);
}

/** Нормалізувати апдейт: тип + ключові поля. Невідоме -> kind:'other'.
 *  @param {any} update сире тіло вебхука
 *  @returns {ParsedUpdate} */
export function parseUpdate(update) {
  if (!update || typeof update !== 'object') return { kind: 'other', updateId: null };
  const updateId = typeof update.update_id === 'number' ? update.update_id : null;
  if (update.callback_query) {
    const cq = update.callback_query;
    return {
      kind: 'callback',
      updateId,
      callbackId: cq.id ?? null,
      fromId: cq.from?.id ?? null,
      chatId: cq.message?.chat?.id ?? null,
      messageId: cq.message?.message_id ?? null,
      threadId: cq.message?.message_thread_id ?? null,
      data: typeof cq.data === 'string' ? cq.data : '',
      replyMarkup: cq.message?.reply_markup ?? null,
    };
  }
  if (update.message) {
    const m = update.message;
    // location — відповідь на /locate: KeyboardButton{request_location:true}
    // шле {latitude, longitude, horizontal_accuracy?}, без тексту в тому ж
    // повідомленні. Лише координати нам потрібні — решту полів (heading,
    // live_period тощо, для Live Location) свідомо не читаємо: той шлях
    // навмисно НЕ обраний (фідбек власника — ненадійний фоновий дозвіл ОС +
    // 8-годинний ліміт Telegram; одноразовий тап натомість).
    const loc = m.location;
    const location =
      loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)
        ? { latitude: loc.latitude, longitude: loc.longitude }
        : null;
    // voice (кейс 6, 01 §3.3) — лише посилання: file_id для getFile, тривалість
    // для гейта «довге голосове» і квоти deepgram_min. Саме аудіо сюди не
    // приходить і ніде не зберігається (ADR-010).
    const v = m.voice;
    const voice =
      v && typeof v.file_id === 'string' && v.file_id
        ? {
            fileId: v.file_id,
            durationS: Number.isFinite(v.duration) ? Number(v.duration) : 0,
            fileSize: Number.isFinite(v.file_size) ? Number(v.file_size) : null,
          }
        : null;
    return {
      kind: 'message',
      updateId,
      fromId: m.from?.id ?? null,
      chatId: m.chat?.id ?? null,
      messageId: m.message_id ?? null, // G1: щоб /clear міг видалити й вхідні власника
      threadId: m.message_thread_id ?? null,
      text: typeof m.text === 'string' ? m.text : '',
      location,
      voice,
    };
  }
  return { kind: 'other', updateId };
}

/**
 * Дозволений відправник? Порівнюємо from.id з дозволеним id (single-user
 * бот) АБО множиною дозволених id (Set/масив — кілька учасників супергрупи,
 * TELEGRAM_ALLOWED_USER_IDS). Той самий виклик, той самий сенс — worker.js
 * вирішує, один id прийшов чи декілька.
 * @param {KvBlob|null|undefined} parsed
 * @param {Set<string>|Array<string|number>|string|number|null|undefined} ownerIds
 */
export function isOwner(parsed, ownerIds) {
  if (parsed?.fromId == null || ownerIds == null) return false;
  const id = String(parsed.fromId);
  if (ownerIds instanceof Set) return ownerIds.has(id);
  if (Array.isArray(ownerIds)) return ownerIds.some((x) => String(x) === id);
  return id === String(ownerIds);
}

/** Дедуп: апдейт уже оброблений, якщо update_id <= lastUpdateId (Telegram передоставляє).
 *  @param {unknown} lastUpdateId
 *  @param {unknown} updateId */
export function isDuplicate(lastUpdateId, updateId) {
  if (typeof updateId !== 'number') return false; // без id не дедупимо (не блокуємо)
  if (typeof lastUpdateId !== 'number') return false;
  return updateId <= lastUpdateId;
}

/** callback_data: `v1:<dateKey>:<code>[:<idx>]`. Модуль дає `code[:idx]`, дату — render.
 *  @param {string} dateKey
 *  @param {string} action
 *  @returns {string|null} null, якщо не влізло в 64 байти */
export function buildCallbackData(dateKey, action) {
  const s = `${CB_VERSION}:${dateKey}:${action}`;
  // Telegram-ліміт callback_data — 1..64 байти (UTF-8).
  if (new TextEncoder().encode(s).length > 64) return null;
  return s;
}

/** Розібрати callback_data -> {v,dateKey,code,idx}|null. idx — число або null.
 *  @param {unknown} data
 *  @returns {{ v: string, dateKey: string, code: string, idx: number|null }|null} */
export function parseCallbackData(data) {
  if (typeof data !== 'string') return null;
  const parts = data.split(':');
  if (parts.length < 3 || parts[0] !== CB_VERSION) return null;
  // `?? ''` не змінює поведінки: довжину звірено вище, тож обидва елементи є.
  const [, dateKey = '', code = '', idxRaw] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  if (!code) return null;
  const idx = idxRaw === undefined ? null : Number(idxRaw);
  if (idxRaw !== undefined && !Number.isInteger(idx)) return null;
  return { v: CB_VERSION, dateKey, code, idx };
}

/**
 * Резолв callback у подію для recordEvent, за опублікованим briefing (той самий,
 * що читає дашборд). Повертає {event, toast} або {error}. Ідентичність айтема —
 * індекс у block.data.items (jobs) або сам блок-сінглтон (fact/stoic).
 *
 * Форма результату — «щось одне з двох» через опційні поля, а не розрізняльний
 * союз: викликачі перевіряють res.error на істинність, і союз змусив би
 * кожного з них писати `'error' in res`.
 * @param {KvBlob|null|undefined} briefing
 * @param {string} code
 * @param {number|null} [idx] відсутній = блок-сінглтон (fact/stoic)
 * @returns {{ event?: KvBlob, toast?: string, error?: 'stale'|'unknown' }}
 */
export function resolveCallback(briefing, code, idx) {
  /** @type {KvBlob[]} */
  const blocks = Array.isArray(briefing?.blocks) ? briefing.blocks : [];
  const find = (/** @type {string} */ id) => blocks.find((b) => b && b.id === id);
  switch (code) {
    case 'js':
    case 'ja': {
      const items = find('jobs')?.data?.items;
      // `idx != null` не змінює поведінки: items[null] в JS і так undefined,
      // тобто нижче спрацював би той самий `!it -> stale`.
      const it = Array.isArray(items) && idx != null ? items[idx] : null;
      if (!it || !it.url) return { error: 'stale' };
      const stage = code === 'js' ? 'saved' : 'applied';
      /** @type {{ type: string, url: string, title: string, stage: string, fit?: number }} */
      const event = { type: 'job_stage', url: it.url, title: it.title || '', stage };
      if (code === 'ja' && typeof it.score === 'number' && it.score >= 0) event.fit = it.score;
      return { event, toast: stage === 'saved' ? '💾 Збережено' : '✅ Позначено «подав»' };
    }
    case 'sf': {
      const text = find('fact')?.data?.fact;
      if (!text) return { error: 'stale' };
      return {
        event: { type: 'save_item', kind: 'fact', id: textHash(text), title: text },
        toast: '🔖 Факт збережено',
      };
    }
    case 'sq': {
      const d = find('stoic')?.data;
      if (!d?.text) return { error: 'stale' };
      const title = `«${d.text}» — ${d.author}`;
      return {
        event: { type: 'save_item', kind: 'quote', id: textHash(title), title },
        toast: '🔖 Цитату збережено',
      };
    }
    default:
      return { error: 'unknown' };
  }
}

/**
 * Дзеркало buildMiniAppButton з src/core/telegram.ts. Пріоритет:
 * 1. botUsername заданий -> Direct Link Mini App (t.me/<username>?startapp) —
 *    завжди launch-ить повноцінний Mini App з initData, і з групи, і з
 *    приватного чату (обходить обмеження web_app-кнопки нижче). Потребує
 *    одноразового owner-кроку в @BotFather (Configure Mini App).
 * 2. botUsername не заданий -> фолбек за chatId (стандартна конвенція
 *    Telegram: групи/супергрупи від'ємні): chatId < 0 -> звичайна url-кнопка
 *    (без initData, дашборд деградує на SAMPLE, §H1); інакше -> web_app
 *    (Telegram Bot API дозволяє web_app ЛИШЕ в приватних чатах —
 *    BUTTON_TYPE_INVALID у групі інакше).
 * @param {string} text
 * @param {string} url
 * @param {string|number|null} [chatId]
 * @param {string|null} [botUsername] не заданий -> фолбек за chatId
 */
export function buildMiniAppButton(text, url, chatId, botUsername) {
  const username = botUsername ? String(botUsername).trim().replace(/^@/, '') : '';
  if (username) return { text, url: `https://t.me/${username}?startapp` };
  const isGroup = chatId != null && Number(chatId) < 0;
  return isGroup ? { text, url } : { text, web_app: { url } };
}

/** Позначити натиснуту кнопку галкою (✓) у reply_markup — легкий зворотний звʼязок.
 *  @param {KvBlob|null|undefined} replyMarkup
 *  @param {string} tappedData */
export function markButtonDone(replyMarkup, tappedData) {
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return replyMarkup;
  return {
    inline_keyboard: rows.map((/** @type {unknown} */ row) =>
      Array.isArray(row)
        ? row.map((/** @type {KvBlob} */ btn) =>
            btn && btn.callback_data === tappedData && !String(btn.text).startsWith('✓')
              ? { ...btn, text: `✓ ${btn.text}` }
              : btn,
          )
        : row,
    ),
  };
}

/* ══════════════════════════════════════════════════════════════════════
   /clear (§C5) — ring-buffer message_id надісланих БОТОМ повідомлень, per
   чат+тема. Дозволяє видалити N останніх, не читаючи всю історію чату
   (Telegram Bot API не дає прочитати/перелічити чужу історію взагалі —
   бот пам'ятає лише те, що сам надіслав). Зберігається в ОКРЕМОМУ KV-
   ключі ('sentMessages', worker.js), не в 'state' — щоб не додавати
   зайвий read-modify-write (і вікно гонки) на КОЖНУ відповідь бота до
   блоба, який і так ділять reminders/roadmapProgress/mockWeights/...
   ══════════════════════════════════════════════════════════════════════ */

// На чат+тему; більш ніж достатньо для будь-якого розумного /clear N (max 50).
const SENT_MESSAGES_CAP = 50;

/** Скільки повідомлень /clear видаляє за раз: кожне - окремий підзапит
 *  Worker'а, і стеля тут та сама, що тримала maxN у parseClearCount. */
const MAX_CLEAR_DELETES = 40;

/** Ключ ring-buffer-а в об'єкті sentMessages: один на чат+тему.
 *  @param {string|number|null|undefined} chatId
 *  @param {string|number|null|undefined} threadId */
export function sentMessagesKey(chatId, threadId) {
  return `${chatId}:${threadId ?? ''}`;
}

/** Запис ring-buffer-а: id повідомлення і чиє воно.
 *  @typedef {{ id: number, own: boolean }} TrackedMessage */

/** Нормалізувати список: старі записи - голі числа (усі від бота).
 *  @param {unknown} list
 *  @returns {TrackedMessage[]} */
export function trackedMessages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((e) =>
      typeof e === 'number'
        ? { id: e, own: false }
        : e && typeof e === 'object' && typeof (/** @type {any} */ (e).id) === 'number'
          ? { id: /** @type {any} */ (e).id, own: Boolean(/** @type {any} */ (e).own) }
          : null,
    )
    .filter((/** @type {TrackedMessage|null} */ e) => e !== null);
}

/** Додати message_id у ring buffer (чиста — повертає новий об'єкт, капнутий).
 *  `own` - повідомлення ВЛАСНИКА, не бота: /clear рахує обміни за ними.
 *  @param {KvBlob|null|undefined} sentMessages
 *  @param {string|number|null|undefined} chatId
 *  @param {string|number|null|undefined} threadId
 *  @param {number} messageId
 *  @param {boolean} [own]
 *  @returns {KvBlob} */
export function recordSentMessage(sentMessages, chatId, threadId, messageId, own = false) {
  const key = sentMessagesKey(chatId, threadId);
  const store = sentMessages && typeof sentMessages === 'object' ? sentMessages : {};
  const list = trackedMessages(store[key]);
  return { ...store, [key]: [...list, { id: messageId, own }].slice(-SENT_MESSAGES_CAP) };
}

/**
 * Що видаляє /clear N. N - це ОБМІНИ, а не повідомлення: рахуються запити
 * власника, а разом із кожним іде все, що асистент на нього відповів. Раніше
 * N означало «останні N рядків чату», тож «/clear 3» зазвичай зносив два
 * запити власника й одну відповідь - половину розмови замість трьох обмінів
 * (скарга власника 30.08).
 *
 * Саме тригерне повідомлення (/clear …) у рахунок НЕ йде, але видаляється:
 * інакше команда зʼїдала б один із замовлених обмінів.
 *
 * @param {KvBlob|null|undefined} sentMessages
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 * @param {number} n
 * @param {number|null} [triggerId] - message_id самої команди
 * @returns {number[]} id у порядку від найстаршого
 */
export function lastExchangeMessages(sentMessages, chatId, threadId, n, triggerId = null) {
  const all = trackedMessages(sentMessages?.[sentMessagesKey(chatId, threadId)]);
  const rest = triggerId == null ? all : all.filter((e) => e.id !== triggerId);
  let seen = 0;
  let from = rest.length;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i]?.own) {
      seen += 1;
      from = i;
      if (seen === n) break;
    }
  }
  // Жодного запиту власника в буфері - це або порожньо, або записи старого
  // формату (голі числа). Тоді поводимось як раніше: останні N повідомлень.
  const picked = seen === 0 ? rest.slice(-n) : rest.slice(from);
  // Стеля ВИДАЛЕНЬ, не обмінів: один обмін - це кілька повідомлень, і «40
  // обмінів» легко перетворились би на сотню deleteMessage, тобто вихід за
  // ліміт підзапитів Worker'а. Ріжемо найстаріші - свіже важливіше.
  const ids = picked.slice(-MAX_CLEAR_DELETES).map((e) => e.id);
  return triggerId == null ? ids : [...ids, triggerId];
}

/** Розібрати аргумент /clear -> клампована кількість [1,maxN]; невалідне/відсутнє -> defaultN.
 *  maxN=40 (не 50) — запас перед типовим лімітом ~50 subrequests/інвокацію
 *  Cloudflare Worker: /clear ще й читає+пише sentMessages (±2) і шле
 *  підсумкове повідомлення (ще ±2) поверх самих deleteMessage-викликів.
 *  @param {string|null|undefined} args
 *  @param {number} [defaultN]
 *  @param {number} [maxN] */
export function parseClearCount(args, defaultN = 20, maxN = 40) {
  const n = parseInt(String(args ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return defaultN;
  return Math.min(maxN, n);
}

/** Розбити масив на шматки розміром size (останній може бути коротшим) —
 *  для /clear: видаляти пачками, не всі N одразу (обережність до rate-limit
 *  Telegram) і не повністю послідовно (менше wall-clock часу в ctx.waitUntil).
 *  @template T
 *  @param {T[]} arr
 *  @param {number} size
 *  @returns {T[][]} */
export function chunkArray(arr, size) {
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Підсумкове повідомлення після спроби видалення (Telegram не дає видалити
 *  повідомлення старші за 48 год — deleted може бути менше за attempted).
 *  @param {number} deleted
 *  @param {number} attempted */
export function formatClearResult(deleted, attempted, exchanges = 0) {
  if (attempted === 0) return 'Нема що очищати — я ще не памʼятаю повідомлень у цьому чаті.';
  // plural - той самий хелпер, що й у решті зведень цього модуля.
  const what =
    exchanges > 0 ? ` (${exchanges} ${plural(exchanges, ['обмін', 'обміни', 'обмінів'])})` : '';
  return `🗑 Видалено ${deleted} із ${attempted} повідомлень${what}. Старші за 48 год Telegram не дає видалити.`;
}

/**
 * Скільки мс кулдауну /brief ще лишилось (0 = можна запускати) — SL2. Захищає
 * від спаму `workflow_dispatch` (палить хвилини Actions + квоту KV/новин), бо
 * guard гасить лише подвійну ВІДПРАВКУ, а джоба однаково стартує. Некоректний
 * lastMs (не число / ≤0) -> 0 (дозволити, перший запуск).
 * @param {unknown} lastMs
 * @param {number} nowMs
 * @param {number} cooldownMs
 */
export function briefCooldownRemainingMs(lastMs, nowMs, cooldownMs) {
  if (typeof lastMs !== 'number' || !(lastMs > 0)) return 0;
  const elapsed = nowMs - lastMs;
  return elapsed >= cooldownMs ? 0 : cooldownMs - elapsed;
}

// Вікно ранкового авто-dispatch (київські години, кінець НЕвключний).
// sendGuard оркестратора має вікно [8,12) (config.sendHour/sendWindowHours), але
// наше вікно закривається НА ГОДИНУ РАНІШЕ (ревʼю A): між workflow_dispatch і
// самим sendGuard стоїть черга Actions + завантаження раннера + npm ci + install
// claude CLI — хвилини. Спроба об 11:57 доїхала б до guard'а вже о 12:0x
// («after window») і скіпнулась би, а мітка dispatch була б поставлена -> день
// БЕЗ брифінгу взагалі. Остання спроба о 10:55 лишає guard'у ~годину запасу.
export const BRIEF_WINDOW_START_HOUR = 8;
export const BRIEF_WINDOW_END_HOUR = 11;
// Мінімальний проміжок між двома dispatch (ревʼю A): ручний /brief не ставить
// денну мітку (він може бути й поза вікном), тож без цього гейта авто-спроба за
// 5 хв після /brief вистрілила б ДРУГИЙ workflow_dispatch — холостий Actions-ран.
// Водночас це НЕ вбиває ретрай: якщо dispatch впав, наступна спроба буде за 15 хв.
export const MIN_DISPATCH_GAP_MS = 15 * 60_000;

/**
 * A2: чи має цей тік пʼятихвилинного крону вистрілити workflow_dispatch брифінгу.
 *
 * Раніше dispatch висів на ЄДИНІЙ спробі (погодинний крон, kyivHour()===8).
 * 14.07 jitter крону Cloudflare (Free) відсунув її на ~50 хв — брифінг прийшов
 * о 08:56. Тепер спроб до 36 у вікні, а від дублів тримають три умови:
 *   lastSentDate  — оркестратор уже надіслав брифінг сьогодні (нема чого диспатчити);
 *   lastAutoDate  — ми вже успішно диспатчили сьогодні (мітка ставиться ЛИШЕ
 *                   після підтвердження GitHub, тож збій ретраїться наступним тіком);
 *   lastDispatchMs — БУДЬ-ЯКИЙ dispatch (у т.ч. ручний /brief) свіжіший за 15 хв.
 *
 * Кожне поле опційне НАВМИСНО: функція сама відсіює все, що не проходить
 * `Number.isFinite`/`typeof`, і викликач цілком може не мати частини стану
 * (перший запуск — порожній блоб briefDispatch).
 * @param {{ kyivHour?: unknown, todayKey?: unknown, nowMs?: unknown,
 *           lastAutoDate?: unknown, lastDispatchMs?: unknown,
 *           lastSentDate?: unknown }} opts
 */
export function shouldAutoDispatchBrief({
  kyivHour,
  todayKey,
  nowMs,
  lastAutoDate,
  lastDispatchMs,
  lastSentDate,
}) {
  // `typeof` тут нічого не додає до перевірки — Number.isFinite і так істинний
  // лише для чисел, — але повідомляє її компілятору. Той самий прийом, що
  // нижче для lastDispatchMs.
  if (typeof kyivHour !== 'number' || !Number.isFinite(kyivHour)) return false;
  if (kyivHour < BRIEF_WINDOW_START_HOUR || kyivHour >= BRIEF_WINDOW_END_HOUR) return false;
  if (typeof todayKey !== 'string' || !todayKey) return false;
  if (lastSentDate === todayKey) return false;
  if (lastAutoDate === todayKey) return false;
  // Локальна змінна замість прямого lastDispatchMs: значення приходить із
  // блоба KV, тобто нетипізоване, а Number.isFinite саме собою типу не звужує.
  // Поведінка та сама — нечисло й раніше провалювало першу ж перевірку.
  const lastMs = typeof lastDispatchMs === 'number' ? lastDispatchMs : NaN;
  const now = typeof nowMs === 'number' ? nowMs : NaN;
  if (
    Number.isFinite(now) &&
    Number.isFinite(lastMs) &&
    lastMs > 0 &&
    now - lastMs < MIN_DISPATCH_GAP_MS
  ) {
    return false;
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════
   Команди / Налаштування (Блок P4) — parseCommand + текстові форматери.
   ══════════════════════════════════════════════════════════════════════ */

// Реєстр для Telegram "/" меню (setMyCommands) — команда без "/" + короткий опис.
// Фаза C: /mock прибрано (був літеральним STUB_REPLY, обіцяв неготову функцію);
// /help відокремлено від /start (§C3); /reminders (список+скасувати, §C4) і
// /clear (§C5) додано за рекомендацією аудиту команд vs Mini App.
export const COMMANDS = [
  { command: 'start', description: 'Почати роботу з ботом' },
  { command: 'help', description: 'Список усіх команд' },
  { command: 'brief', description: 'Запустити ранковий брифінг' },
  { command: 'stats', description: 'Стрік і статистика' },
  { command: 'jobs', description: 'Активна воронка вакансій' },
  { command: 'save', description: 'Збережене (факти/цитати/новини)' },
  { command: 'settings', description: 'Відкрити Mini App' },
  { command: 'remind', description: 'Нагадування (напр. через 20 хв ...)' },
  { command: 'reminders', description: 'Список активних нагадувань' },
  { command: 'agenda', description: 'Найближчі події календаря — тиждень наперед' },
  { command: 'agent', description: 'Що вміє асистент — повний перелік (вільний текст)' },
  { command: 'plan', description: 'План дня (LLM читає календар, пропонує таймлайн)' },
  { command: 'roadmap', description: 'IT-роадмеп (теми, прогрес)' },
  { command: 'clear', description: 'Видалити останні N повідомлень — мої та твої (за замовч. 20)' },
  { command: 'whereami', description: 'chat_id/thread_id цього чату (для налаштування тем)' },
  { command: 'locate', description: 'Оновити позицію за GPS (для точної погоди в Mini App)' },
];

// Ярлик кнопки скасування тимчасової клавіатури /locate — окремий рядок, а не
// KEYBOARD_ALIASES: не команда, а вихід зі стану «чекаю на геопозицію».
export const LOCATE_CANCEL_LABEL = '⬅️ Скасувати';

// Reply-keyboard «пад» швидких дій (персистентний, шлеться раз на /start).
// Ревʼю Telegram-механік (фідбек власника): попередній набір (Статистика/
// Вакансії/Збережене/Налаштування/Роадмеп) дублював навігацію Mini App —
// кожна кнопка означала «відкрий екран, який і так відкритий апкою». Тут
// лишається те, чого в апці НЕМАЄ і що дає відповідь одразу в чаті, без
// переходу нікуди: план дня й нагадування читає LLM/rule-based фолбек,
// «Сьогодні» — список подій, «Брифінг» — ручний перезапуск ранкового
// повідомлення (тепер справді працює, §fix worker.js dispatchBrief force).
export const REPLY_KEYBOARD = [
  ['📅 Сьогодні', '🧠 План дня'],
  ['⏰ Нагадування', '🔄 Брифінг'],
];

/** Звичайна reply-клавіатура (персистентна). Виноситься сюди разом із
 *  locateKeyboard: обидві — чиста форма Telegram-обʼєкта, і потрібні вони й
 *  командам, і погодно-гео шляху. */
export function normalKeyboard() {
  return { keyboard: REPLY_KEYBOARD, resize_keyboard: true, is_persistent: true };
}

/** Клавіатура, що чекає на GPS-позицію (/locate) — request_location доступний
 *  ЛИШЕ як властивість KeyboardButton, inline-кнопки цього не вміють (Bot API).
 *  Скасування — окремий рядок: без нього власник лишався б із однокнопковою
 *  клавіатурою, якщо передумав ділитись позицією. */
export function locateKeyboard() {
  return {
    keyboard: [[{ text: '📍 Надіслати позицію', request_location: true }], [LOCATE_CANCEL_LABEL]],
    resize_keyboard: true,
  };
}

// Лейбл reply-keyboard кнопки -> та сама команда, що й відповідний "/xxx".
/** @type {Record<string, string>} */
const KEYBOARD_ALIASES = {
  '📅 Сьогодні': 'agenda',
  '🧠 План дня': 'plan',
  '⏰ Нагадування': 'reminders',
  '🔄 Брифінг': 'brief',
};

/**
 * Розібрати вхідне повідомлення на команду: slash-команда (з опційним
 * "@botname" у групових чатах) АБО лейбл reply-keyboard — обидва мапляться
 * в один канонічний {cmd, args}. Звичайний текст (майбутній асистент, P2) -> null.
 * @param {unknown} text
 * @returns {{ cmd: string, args: string }|null}
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (KEYBOARD_ALIASES[trimmed]) return { cmd: KEYBOARD_ALIASES[trimmed], args: '' };
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  // `?? ''` недосяжне: split завжди віддає щонайменше один елемент.
  const cmd = head ? (head.split('@')[0] ?? '').toLowerCase() : '';
  if (!cmd) return null;
  return { cmd, args: rest.join(' ') };
}

/**
 * Unicode прогрес-бар (█ заповнено/░ порожньо), фіксована ширина. total<=0 -> ''
 * (немає сенсу малювати бар без знаменника).
 *
 * Обгорнутий у `[...]`+`<code>` (моноширинний, візуально відмежований пілюлею
 * в клієнтах Telegram) НАВМИСНО: 10 підряд символів ░/█ без меж у звичайному
 * пропорційному шрифті чату зливаються в суцільну «хатчовану» пляму — на
 * практиці виглядає як зіпсоване/зафарбоване зображення, а не як індикатор
 * прогресу (баг, знайдений на живому скріншоті). Дужки+код-блок дають чітку
 * межу й моноширинність незалежно від клієнта/шрифту.
 * @param {number} done
 * @param {number} total
 * @param {number} [width]
 */
export function progressBar(done, total, width = 10) {
  if (!(total > 0)) return '';
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `<code>[${bar}]</code>`;
}

// Дзеркало STAGES зі stats-core.mjs (worker.js не імпортує TS, а тут — тексти для
// Telegram). Термінальні (F1) — в кінці: це вихід із воронки, не прогрес.
/** @type {Record<string, string>} */
const STAGE_LABEL = {
  saved: '💾 Збережено',
  applied: '✅ Подано',
  interview: '🗣 Співбесіда',
  offer: '🎉 Офер',
  rejected: '🚫 Відмова',
  failed: '💔 Провал співбесіди',
};
const STAGE_ORDER = ['saved', 'applied', 'interview', 'offer', 'rejected', 'failed'];

/** /jobs — активна воронка вакансій, згрупована за стадією (з /api/stats.funnelList).
 *  @param {unknown} funnelList */
export function formatJobsMessage(funnelList) {
  /** @type {KvBlob[]} */
  const list = Array.isArray(funnelList) ? funnelList : [];
  if (list.length === 0) {
    return '💼 <b>Воронка вакансій</b>\n\nПоки порожньо — тисни 💾/✅ під вакансіями в брифінгу.';
  }
  const byStage = new Map(STAGE_ORDER.map((st) => /** @type {[string, KvBlob[]]} */ ([st, []])));
  // `?.push` замість has+get — той самий результат: ключів поза STAGE_ORDER тут
  // немає, тож `get` невизначене рівно тоді, коли `has` було б false.
  for (const it of list) byStage.get(it.stage)?.push(it);

  const lines = ['💼 <b>Воронка вакансій</b>', ''];
  for (const st of STAGE_ORDER) {
    const items = byStage.get(st) ?? [];
    if (items.length === 0) continue;
    lines.push(STAGE_LABEL[st] ?? st);
    for (const it of items) lines.push(`• ${escapeHtml(it.title || it.url || '?')}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** @type {Record<string, string>} */
const KIND_ICON = { news: '🗞', fact: '🧠', quote: '🏛', question: '🎤' };

/** /save — останнє збережене (факти/цитати/новини/питання), з /api/stats.savedList.
 *  Фаза C2: news-записи мають url (Mini App-версія лінкує) — тепер клікабельні
 *  й тут; fact/quote/question url не мають (dedup по id=textHash), лишаються
 *  плейн-текстом, як і раніше.
 *  @param {unknown} savedList */
export function formatSavedMessage(savedList) {
  /** @type {KvBlob[]} */
  const list = Array.isArray(savedList) ? savedList : [];
  if (list.length === 0) {
    return '🔖 <b>Збережене</b>\n\nПоки нічого — тисни 🔖/💾 в брифінгу.';
  }
  const lines = ['🔖 <b>Збережене</b>', ''];
  for (const it of list) {
    const icon = KIND_ICON[it.kind] || '🔖';
    const label = it.title || '?';
    lines.push(it.url ? `${icon} ${link(it.url, label)}` : `${icon} ${escapeHtml(label)}`);
  }
  return lines.join('\n');
}

/**
 * Українське відмінювання за числом — ОДНЕ правило на воркер.
 *
 * ⚠️ mod100 перевіряється окремо: 11-14 закінчуються на 1-4, але вимагають
 * форми «багато». Правило «дивись лише на останню цифру» дає «11 співбесіда».
 * Дзеркало pluralUk із web/app/src/lib/plural.ts — клієнт і воркер живуть у
 * різних світах модулів (.ts проти .mjs), тож імпортувати одне в інше нічим.
 * @param {number} n
 * @param {[string, string, string]} forms
 */
function plural(n, forms) {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/** Підпис стадії у зведенні «без руху». */
/** @type {Record<string, string>} */
const STALE_STAGE = { saved: 'збережено', applied: 'подано', interview: 'співбесіда' };

/** Підпис кроку воронки — «куди дійшли»: саме це очікування й міряється. */
/** @type {Record<string, string>} */
const SPEED_STEP = {
  applied: 'Збережено → подано',
  interview: 'Подано → співбесіда',
  offer: 'Співбесіда → офер',
};

/** Скільки рядків показуємо в чаті: це зведення, а не архів. */
const CHAT_STALE = 3;
const CHAT_GAP = 2;

/** Нижче цього розрив «відмітив ↔ дається» — округлення, а не сигнал. */
const CHAT_GAP_MIN = 15;

/**
 * /stats — зведення в чаті.
 *
 * ⚠️ ЧОМУ НЕ ПРОСТО «ТЕ САМЕ, ЩО НА ДАШБОРДІ». Дашборд ГОРТАЮТЬ, повідомлення
 * в чаті ПРОБІГАЮТЬ очима. Тому сюди йде не все нове, а лише те, з чого можна
 * щось зробити просто зараз: вакансії без руху (це буквально список справ) і
 * розрив «відмітив пройденим, а питання не даються» (це список на повторення).
 * Решта — тренди, розподіли, історія — лишається там, де її можна роздивитись.
 *
 * Кожен блок зʼявляється, ЛИШЕ коли має вміст: «0 вакансій без руху» — рядок,
 * який щодня займає місце й нічого не каже.
 * @param {KvBlob|null|undefined} stats
 */
export function formatStatsMessage(stats) {
  const s = stats || {};
  const streaks = s.streaks || {};
  const funnel = s.funnel || {};
  const goal = s.goal || {};
  const speed = s.funnelSpeed || {};
  const goalBar = progressBar(goal.weeklyApplied ?? 0, goal.weeklyTarget ?? 0);
  const interview = funnel.interview ?? 0;
  const offer = funnel.offer ?? 0;
  const rejected = funnel.rejected ?? 0;
  const failed = funnel.failed ?? 0;
  const lines = [
    '📊 <b>Статистика</b>',
    '',
    `🔥 Стрік відкриттів: ${streaks.openDays ?? 0} дн. (рекорд ${streaks.bestOpenDays ?? 0})`,
    `🎯 Тижнева ціль: ${goalBar ? goalBar + ' ' : ''}${goal.weeklyApplied ?? 0}/${goal.weeklyTarget ?? 0} подано`,
    // ⚠️ Відмінки живі скрізь у рядку, а не лише де впало в око: доти тут
    // стояло «2 співбесід», «1 відмов» і дужковий обхід «офер(и)/провал(ів)» —
    // три способи не відмінювати в одному повідомленні.
    `💼 Воронка: ${funnel.saved ?? 0} збережено · ${funnel.applied ?? 0} подано · ` +
      `${interview} ${plural(interview, ['співбесіда', 'співбесіди', 'співбесід'])} · ` +
      `${offer} ${plural(offer, ['офер', 'офери', 'оферів'])}`,
    // Термінальні (F1) — окремим рядком і лише коли є: у порожній воронці
    // «0 відмов» лише шумить.
    ...(rejected || failed
      ? [
          `🚫 Закрито: ${rejected} ${plural(rejected, ['відмова', 'відмови', 'відмов'])} · ` +
            `${failed} ${plural(failed, ['провал', 'провали', 'провалів'])} співбесід`,
        ]
      : []),
    `🎤 Mock-стрік: ${streaks.mockDays ?? 0} дн.`,
  ];
  if (typeof s.avgFitApplied === 'number') {
    lines.push(`📈 Середній fit поданих: ${s.avgFitApplied}%`);
  }

  // Найдієвіше з усього повідомлення: список того, що чекає на рух.
  /** @type {KvBlob[]} */
  const stale = Array.isArray(speed.stale) ? speed.stale : [];
  if (stale.length > 0) {
    lines.push('', `⏳ <b>Лежить без руху</b> (${speed.staleAfterDays ?? 21}+ дн.)`);
    for (const j of stale.slice(0, CHAT_STALE)) {
      const label = STALE_STAGE[j.stage] ?? j.stage;
      lines.push(`• ${escapeHtml(j.title || j.url || '?')} — ${label}, ${j.days} дн.`);
    }
    if (stale.length > CHAT_STALE) lines.push(`• …ще ${stale.length - CHAT_STALE}`);
  }

  // Медіани кроків — лише там, де вони є. Крок без медіани в чат не йде:
  // «замало переходів» доречне на дашборді, а тут це шум у зведенні.
  /** @type {KvBlob[]} */
  const rawSteps = Array.isArray(speed.steps) ? speed.steps : [];
  const steps = rawSteps.filter((st) => typeof st.medianDays === 'number');
  if (steps.length > 0) {
    lines.push('');
    for (const st of steps) {
      lines.push(`🕰 ${SPEED_STEP[st.to] ?? st.to}: зазвичай ${st.medianDays} дн.`);
    }
  }

  // Розрив «відмітив пройденим ↔ питання не даються» — список на повторення.
  // Теми без питань (easePct === null) сюди не потрапляють за побудовою: нуль
  // тут означав би найгіршу оцінку за те, що тему жодного разу не питали.
  /** @type {KvBlob[]} */
  const topics = s.mastery?.topics ?? [];
  const gaps = topics
    .filter((t) => typeof t.easePct === 'number' && t.total > 0)
    // Приведення потрібне через розсипання Record: у літералі індексна
    // сигнатура KvBlob губиться, і лишається сам donePct.
    .map((t) => /** @type {KvBlob} */ ({ ...t, donePct: Math.round((t.done / t.total) * 100) }))
    .filter((t) => t.donePct - t.easePct >= CHAT_GAP_MIN)
    .sort((a, b) => b.donePct - b.easePct - (a.donePct - a.easePct));
  if (gaps.length > 0) {
    lines.push('', '🎓 <b>Відмітив, а не дається</b>');
    for (const t of gaps.slice(0, CHAT_GAP)) {
      lines.push(`• ${escapeHtml(t.title)} — ${t.donePct}% пройдено, ${t.easePct}% дається`);
    }
  }

  return lines.join('\n');
}

/**
 * /whereami — chat_id + thread_id ПОТОЧНОГО чату/теми. Головний спосіб
 * знайти реальні id тем після створення forum-супергрупи (натиснути в
 * кожній темі, скопіювати значення для TOPIC_*-секретів) — без потреби
 * грепати логи Worker'а.
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 * @param {KvBlob|null} [me] відповідь getMe (форми не гарантує ніхто)
 * @param {string|number|null} [assistantTopic] undefined = не звіряти тему
 */
export function formatWhereAmI(chatId, threadId, me = null, assistantTopic = undefined) {
  const lines = [
    '📍 <b>Де я</b>',
    '',
    `chat_id: <code>${escapeHtml(String(chatId ?? '?'))}</code>`,
    `thread_id: <code>${threadId == null ? 'немає (не тема форуму)' : escapeHtml(String(threadId))}</code>`,
  ];
  // Діагностика «написав вільним текстом — і тиша».
  //
  // can_read_all_group_messages з getMe відбиває ЛИШЕ налаштування приватності,
  // а не права адміна: бот-адмін отримує все навіть із увімкненою приватністю.
  // Тому не лякаємо, коли приватність увімкнена, — лише кажемо, від чого це
  // залежить. Інакше попередження брехало б адмін-ботам.
  if (me && typeof me.can_read_all_group_messages === 'boolean') {
    lines.push(
      '',
      me.can_read_all_group_messages
        ? '✅ Приватність вимкнена — вільний текст доходить до мене'
        : 'ℹ️ Приватність УВІМКНЕНА. Вільний текст доходить, лише якщо я адмін групи.\n' +
            'Якщо не адмін: @BotFather → /setprivacy → Disable, тоді перезапустити діалог.',
    );
  }
  // Тема має значення: вільний текст іде до асистента лише в темі 🤖Асистент
  // (або в чаті без тем). Тому показуємо, чи збігається поточна тема з
  // налаштованою, — без цього «мовчання» неможливо відрізнити від «не та тема».
  if (assistantTopic !== undefined) {
    const here = threadId == null || String(threadId) === String(assistantTopic);
    lines.push(
      '',
      assistantTopic == null
        ? '⚠️ TOPIC_ASSISTANT не заданий у воркері — вільний текст працює лише в чаті без тем.'
        : `🤖 Тема асистента: <code>${escapeHtml(String(assistantTopic))}</code>` +
            (here
              ? ' — це вона, вільний текст тут працює'
              : ' — тут вільний текст НЕ піде до асистента'),
    );
  }
  return lines.join('\n');
}
