// @ts-check
// Чиста логіка памʼяті діалогу асистента per-thread (Блок CM, 🤖Асистент):
// зберігає кілька останніх реплік розмови (користувач↔асистент) на (chatId,
// threadId), щоб працювали follow-up-и («перенеси її на годину пізніше» —
// «її» = попередня подія). Без I/O — Worker читає/пише окремий KV-ключ
// `assistantHistory` (НЕ `state`, той самий мотив, що sentMessages: трекінг на
// кожне повідомлення не має ділити гонку писарів `state`-блоба).
//
// Ключовий інваріант бюджету: історія йде в transcript (user-prompt хоста,
// MAX_PROMPT_LEN=4000) РАЗОМ із own-data дайджестом (до 1500) і календарем
// (до 900) — тому тримаємо коротко: ≤MAX_HISTORY_TURNS реплік, кожна
// ≤MAX_TURN_LEN, рендер ≤MAX_RENDER_LEN (бюджети зведено так, щоб сума
// історія+дайджест+календар+текст користувача лишалась під 4000, ревʼю CM).

export const MAX_HISTORY_TURNS = 6; // ~3 обміни
const MAX_TURN_LEN = 200;
const MAX_RENDER_LEN = 500;

/**
 * TTL ключа `assistantHistory` (аудит §KV: «жоден ключ не має TTL»).
 *
 * Це «стільки ТИШІ», а не «стільки життя»: ключ переписується на кожному обміні,
 * і кожен запис відсуває межу. Тобто розмова живе, доки нею користуються, а
 * покинута — зникає сама. Навіщо взагалі: тут осідають теми листів і назви
 * подій, тобто найчутливіший залишок роботи асистента, і тримати його роками
 * заради «раптом знадобиться» немає причин — сама памʼять і так лише
 * MAX_HISTORY_TURNS реплік, тобто про давню розмову вона вже нічого не знає.
 */
export const ASSISTANT_HISTORY_TTL_S = 30 * 86_400;

/**
 * Одна репліка розмови.
 * @typedef {{ role: 'user'|'assistant', text: string }} HistoryTurn
 */

/** Ключ історії за (chatId, threadId) — той самий формат, що sentMessagesKey.
 *  @param {string|number|null|undefined} chatId
 *  @param {string|number|null|undefined} threadId */
export function historyKey(chatId, threadId) {
  return `${chatId}:${threadId ?? ''}`;
}

/** Сплющити переноси рядків + обрізати одну репліку (як clip в assistant-data-core). */
function clipTurn(/** @type {unknown} */ text) {
  const t = String(text ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
  return t.length > MAX_TURN_LEN ? t.slice(0, MAX_TURN_LEN - 1).trimEnd() + '…' : t;
}

/**
 * Додати репліку до історії треду (новий обʼєкт). role: 'user'|'assistant'
 * (будь-що інше -> 'user'). Порожня після clip репліка не додається (не
 * засмічуємо історію). Кап на MAX_HISTORY_TURNS останніх.
 * @param {KvBlob|null|undefined} history
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 * @param {string} role
 * @param {unknown} text
 * @returns {KvBlob}
 */
export function appendTurn(history, chatId, threadId, role, text) {
  const clipped = clipTurn(text);
  const store = history && typeof history === 'object' ? history : {};
  if (!clipped) return store;
  const key = historyKey(chatId, threadId);
  const list = Array.isArray(store[key]) ? store[key] : [];
  const turn = { role: role === 'assistant' ? 'assistant' : 'user', text: clipped };
  return { ...store, [key]: [...list, turn].slice(-MAX_HISTORY_TURNS) };
}

/**
 * Відрендерити історію треду як префікс-контекст для промпту. Бере НАЙСВІЖІШІ
 * репліки в межах MAX_RENDER_LEN (старіші відкидає, якщо бюджет вичерпано).
 * Порожня історія -> '' (без префікса). Формат:
 *   "Попередня розмова:\nКористувач: ...\nТи: ...\n\n"
 * @param {KvBlob|null|undefined} history
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 */
export function renderHistoryForPrompt(history, chatId, threadId) {
  const list = history?.[historyKey(chatId, threadId)];
  if (!Array.isArray(list) || list.length === 0) return '';
  /** @type {string[]} */
  const lines = [];
  let total = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    const label = t?.role === 'assistant' ? 'Ти' : 'Користувач';
    const line = `${label}: ${clipTurn(t?.text)}`;
    if (total + line.length > MAX_RENDER_LEN) break;
    lines.unshift(line);
    total += line.length;
  }
  return lines.length ? `Попередня розмова:\n${lines.join('\n')}\n\n` : '';
}
