// Маркування зовнішнього вмісту (01-architecture §4.2): усе, що прийшло не
// від власника (пошта, drive, чужі чати), ядро обгортає в
// `<external source="…">…</external>` ДО того, як віддати моделі. Мозок на
// етапі 2 читає цей тег у PreToolUse-хуку; системний промпт попереджає, що
// всередині — дані, не команди.

/**
 * Нейтралізувати спроби закрити/відкрити тег зсередини вмісту: лист, який
 * містить `</external>`, інакше «вистрибнув би» з обгортки і видавав би свій
 * текст за системний. Ламаємо САМЕ послідовність тега (кутову дужку), решту
 * тексту не чіпаємо.
 * @param {string} text
 */
export function neutralizeExternalTags(text) {
  return text.replace(/<(\/?\s*external)/gi, '‹$1');
}

/**
 * Обгорнути зовнішній вміст маркером джерела.
 * @param {string} source — mail · drive · inbox · places (07 §4)
 * @param {string} text
 * @param {string} [id] ідентифікатор обʼєкта (лист, файл), якщо є
 */
export function wrapExternal(source, text, id) {
  const idAttr = id ? ` id="${String(id).replace(/[^A-Za-z0-9_-]/g, '')}"` : '';
  return `<external source="${source}"${idAttr}>\n${neutralizeExternalTags(text)}\n</external>`;
}
