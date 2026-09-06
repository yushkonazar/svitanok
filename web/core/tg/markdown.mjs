// Markdown моделі → HTML Telegram (приймання етапу 4, 06.09: deliver слав
// parse_mode HTML, а модель пише Markdown - «**» виходили текстом). Підтримка
// рівно того, що Telegram уміє показати: жирний, курсив, закреслення, код,
// код-блок, посилання, цитата; заголовки стають жирним рядком, маркери
// списків - «•», лінійки зникають. Усе інше - як є, уже екрановане.
//
// Порядок важливий: код і код-блоки виймаються ДО екранування й інлайн-
// розмітки (усередині коду «*» - символ, не курсив), решта екранується
// цілком, і лише тоді накладаються теги - тож жоден символ моделі не може
// стати тегом.

import { escapeHtml } from '../../tg-core.mjs';
import { splitMessage, TG_TEXT_LIMIT } from './outbox-core.mjs';

/** Стеля частини у Markdown ДО конвертації: теги й сутності (&amp;) додають
 *  довжини, а 4096 Telegram рахує по готовому HTML. */
export const MD_PART_LIMIT = 3_500;

const HOLD_OPEN = '';
const HOLD_CLOSE = '';
const HOLD_RE = /(\d+)/g;
/** Літера/цифра будь-якої абетки - межа слова для курсиву (JS \w - лише ASCII,
 *  і «_слово_далі» кирилицею інакше ставало б курсивом). */
const WORD = '\\p{L}\\p{N}';
const BOLD_RE = /\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/gu;
const BOLD_US_RE = /__(?=\S)([^\n]+?)(?<=\S)__/gu;
const STRIKE_RE = /~~(?=\S)([^\n]+?)(?<=\S)~~/gu;
const ITALIC_STAR_RE = new RegExp(
  `(^|[^${WORD}*])\\*(?=[^\\s*])([^*\\n]+?)(?<=[^\\s*])\\*(?![${WORD}])`,
  'gu',
);
const ITALIC_US_RE = new RegExp(
  `(^|[^${WORD}_])_(?=[^\\s_])([^_\\n]+?)(?<=[^\\s_])_(?![${WORD}])`,
  'gu',
);
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * @param {unknown} md
 * @returns {string} HTML для parse_mode HTML; порожній рядок для порожнього входу
 */
export function mdToTelegramHtml(md) {
  const src = String(md ?? '').replace(/\r\n/g, '\n');
  /** @type {string[]} */
  const held = [];
  const hold = (/** @type {string} */ html) => {
    held.push(html);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  };
  let text = src.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) =>
    hold(`<pre>${escapeHtml(String(code).replace(/\n$/, ''))}</pre>`),
  );
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  text = escapeHtml(text);

  text = text
    .split('\n')
    .map((line) => {
      let m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (m) return `<b>${m[1]}</b>`;
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '';
      m = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (m) return `${m[1]}• ${m[2]}`;
      m = line.match(/^\s*&gt;\s?(.*)$/);
      if (m) return `<blockquote>${m[1]}</blockquote>`;
      return line;
    })
    .join('\n')
    .replace(/<\/blockquote>\n<blockquote>/g, '\n');

  text = text
    .replace(LINK_RE, '<a href="$2">$1</a>')
    .replace(BOLD_RE, '<b>$1</b>')
    .replace(BOLD_US_RE, '<b>$1</b>')
    .replace(STRIKE_RE, '<s>$1</s>')
    .replace(ITALIC_STAR_RE, '$1<i>$2</i>')
    .replace(ITALIC_US_RE, '$1<i>$2</i>');

  return text
    .replace(HOLD_RE, (_, i) => held[Number(i)] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Частини для enqueueOutbox: Markdown ріжеться ДО конвертації (щоб тег не
 * розполовинився між повідомленнями), кожна частина несе plain_text -
 * оригінал для фолбеку, якщо Telegram не прийме розмітку. Частина, що після
 * конвертації переросла стелю, їде як звичайний текст.
 * @param {unknown} md
 * @returns {{ text: string, plain_text?: string, parse_mode?: undefined }[]}
 */
export function renderMdParts(md) {
  return splitMessage(String(md ?? ''), MD_PART_LIMIT).map((part) => {
    const html = mdToTelegramHtml(part);
    if (!html || html.length > TG_TEXT_LIMIT) return { text: part, parse_mode: undefined };
    return { text: html, plain_text: part };
  });
}
