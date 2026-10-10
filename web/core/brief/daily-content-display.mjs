export const CONTENT_TOPICS = {
  space: 'Космос',
  nature: 'Природа',
  science: 'Наука',
  technology: 'Технології',
  history: 'Історія',
  culture: 'Культура',
  mind: 'Погляд на життя',
};
/** @param {string} value */
export function contentHash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
/** @param {Record<string, any>} item @param {'fact'|'quote'} kind */
export function contentIdentity(item, kind) {
  return (
    item.id ??
    `${kind}-${contentHash(kind === 'fact' ? item.fact : `${item.author}:${item.reference ?? item.text}`)}`
  );
}
