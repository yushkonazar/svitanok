// Чиста логіка Telegram-вебхука (P0/P1): парсинг апдейтів, перевірка secret-token,
// власник, дедуп, callback_data (кодування/декодування), резолв callback → подія
// для recordEvent. Без I/O — щоб покрити тестами (worker.js імпортує це, KV/HTTP
// робить Worker). Дзеркалить кілька примітивів дашборда (textHash) — щоб чат і
// Mini App домовлялись про ідентичність збереженого.

export const CB_VERSION = 'v1';

// Дзеркало textHash з web/public/index.html — стабільний ID для обраного без url
// (факт/цитата). МАЄ збігатися символ-у-символ, інакше чат і дашборд дедуплять
// збереження по-різному.
export function textHash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Константний-час порівняння secret-token (X-Telegram-Bot-Api-Secret-Token). */
export function verifyWebhookSecret(header, secret) {
  if (typeof header !== 'string' || typeof secret !== 'string' || !secret) return false;
  if (header.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/** Нормалізувати апдейт: тип + ключові поля. Невідоме -> kind:'other'. */
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
    return {
      kind: 'message',
      updateId,
      fromId: m.from?.id ?? null,
      chatId: m.chat?.id ?? null,
      threadId: m.message_thread_id ?? null,
      text: typeof m.text === 'string' ? m.text : '',
    };
  }
  return { kind: 'other', updateId };
}

/** Власник? Порівнюємо from.id з дозволеним chatId (single-user бот). */
export function isOwner(parsed, ownerChatId) {
  if (parsed?.fromId == null || ownerChatId == null) return false;
  return String(parsed.fromId) === String(ownerChatId);
}

/** Дедуп: апдейт уже оброблений, якщо update_id <= lastUpdateId (Telegram передоставляє). */
export function isDuplicate(lastUpdateId, updateId) {
  if (typeof updateId !== 'number') return false; // без id не дедупимо (не блокуємо)
  if (typeof lastUpdateId !== 'number') return false;
  return updateId <= lastUpdateId;
}

/** callback_data: `v1:<dateKey>:<code>[:<idx>]`. Модуль дає `code[:idx]`, дату — render. */
export function buildCallbackData(dateKey, action) {
  const s = `${CB_VERSION}:${dateKey}:${action}`;
  // Telegram-ліміт callback_data — 1..64 байти (UTF-8).
  if (new TextEncoder().encode(s).length > 64) return null;
  return s;
}

/** Розібрати callback_data -> {v,dateKey,code,idx}|null. idx — число або null. */
export function parseCallbackData(data) {
  if (typeof data !== 'string') return null;
  const parts = data.split(':');
  if (parts.length < 3 || parts[0] !== CB_VERSION) return null;
  const [, dateKey, code, idxRaw] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  if (!code) return null;
  const idx = idxRaw === undefined ? null : Number(idxRaw);
  if (idxRaw !== undefined && !Number.isInteger(idx)) return null;
  return { v: parts[0], dateKey, code, idx };
}

/**
 * Резолв callback у подію для recordEvent, за опублікованим briefing (той самий,
 * що читає дашборд). Повертає {event, toast} або {error}. Ідентичність айтема —
 * індекс у block.data.items (jobs) або сам блок-сінглтон (fact/stoic).
 */
export function resolveCallback(briefing, code, idx) {
  const blocks = Array.isArray(briefing?.blocks) ? briefing.blocks : [];
  const find = (id) => blocks.find((b) => b && b.id === id);
  switch (code) {
    case 'js':
    case 'ja': {
      const items = find('jobs')?.data?.items;
      const it = Array.isArray(items) ? items[idx] : null;
      if (!it || !it.url) return { error: 'stale' };
      const stage = code === 'js' ? 'saved' : 'applied';
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

/** Позначити натиснуту кнопку галкою (✓) у reply_markup — легкий зворотний звʼязок. */
export function markButtonDone(replyMarkup, tappedData) {
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return replyMarkup;
  return {
    inline_keyboard: rows.map((row) =>
      Array.isArray(row)
        ? row.map((btn) =>
            btn && btn.callback_data === tappedData && !String(btn.text).startsWith('✓')
              ? { ...btn, text: `✓ ${btn.text}` }
              : btn,
          )
        : row,
    ),
  };
}
