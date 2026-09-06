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

/** Маркери вийнятого коду - приватна область Unicode; з входу такі символи
 *  зрізаються (HOLD_STRIP), інакше літеральний «0» підставив би held[0]. */
const HOLD_OPEN = '';
const HOLD_CLOSE = '';
const HOLD_RE = /(\d+)/g;
const HOLD_STRIP = /[]/g;
/** @typedef {{ text: string, parse_mode?: 'HTML', plain_text?: string }} MdPart */
/** Літера/цифра будь-якої абетки - межа слова для курсиву (JS \w - лише ASCII,
 *  і «_слово_далі» кирилицею інакше ставало б курсивом). */
const WORD = '\\p{L}\\p{N}';
const BOLD_RE = /\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/gu;
/** «__init__.py» - не жирний: за Markdown це жирний «init», але дандер (чистий
 *  ASCII-ідентифікатор між «__») у відповідях про Python частіший за жирний
 *  через підкреслення; межі слова - ті самі, що в курсиву. */
const BOLD_US_RE = new RegExp(
  `(^|[^${WORD}_])__(?![A-Za-z0-9]+__)(?=\\S)([^\\n]+?)(?<=\\S)__(?![${WORD}])`,
  'gu',
);
const STRIKE_RE = /~~(?=\S)([^\n]+?)(?<=\S)~~/gu;
const ITALIC_STAR_RE = new RegExp(
  `(^|[^${WORD}*])\\*(?=[^\\s*])([^*\\n]+?)(?<=[^\\s*])\\*(?![${WORD}])`,
  'gu',
);
const ITALIC_US_RE = new RegExp(
  `(^|[^${WORD}_])_(?=[^\\s_])([^_\\n]+?)(?<=[^\\s_])_(?![${WORD}])`,
  'gu',
);
/** URL з однією парою дужок усередині («…/Київ_(місто)») - як у Вікіпедії. */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g;
/** Голий URL (уже після екранування, тому «&amp;» усередині - норма). */
const BARE_URL_RE = /https?:\/\/(?:[^\s<()]|\([^\s()]*\))+/g;
/** Код-блок: мова рахується лише коли після неї перенос - «```code```» в один
 *  рядок інакше втрачав би вміст (мова зʼїдала його цілком). */
const FENCE_RE = /```(?:[\w+-]*\n)?([\s\S]*?)```/g;

/**
 * @param {unknown} md
 * @returns {string} HTML для parse_mode HTML; порожній рядок для порожнього входу
 */
export function mdToTelegramHtml(md) {
  const src = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .replace(HOLD_STRIP, '');
  /** @type {string[]} */
  const held = [];
  const hold = (/** @type {string} */ html) => {
    held.push(html);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  };
  let text = src.replace(FENCE_RE, (_, code) =>
    hold(`<pre>${escapeHtml(String(code).replace(/\n$/, ''))}</pre>`),
  );
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  text = escapeHtml(text);
  // Посилання й голі URL - теж у сховок: «_» і «*» всередині адреси інакше
  // ставали б курсивом просто в href, і Telegram відкидав би всю розмітку.
  text = text.replace(LINK_RE, (_, label, url) => hold(`<a href="${url}">${label}</a>`));
  text = text.replace(BARE_URL_RE, (url) => hold(url));

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
    .replace(BOLD_RE, '<b>$1</b>')
    .replace(BOLD_US_RE, '$1<b>$2</b>')
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
 * конвертації переросла стелю, їде як звичайний текст. Режим розмітки несе
 * сама частина - викликачу не треба класти parse_mode у payload.
 * @param {unknown} md
 * @returns {MdPart[]}
 */
export function renderMdParts(md) {
  const parts = splitMessage(String(md ?? ''), MD_PART_LIMIT);
  // Розріз усередині код-блоку: закрити огорожу в цій частині й відкрити в
  // наступній - інакше «**» з коду стали б тегами, а бектики - текстом.
  let open = false;
  for (let i = 0; i < parts.length; i += 1) {
    /** @type {string} */
    let part = (open ? '```\n' : '') + (parts[i] ?? '');
    open = ((part.match(/```/g) ?? []).length & 1) === 1;
    if (open && i < parts.length - 1) part += '\n```';
    parts[i] = part;
  }
  return parts.map((part) => {
    const html = mdToTelegramHtml(part);
    if (!html || html.length > TG_TEXT_LIMIT) return { text: part };
    return { text: html, parse_mode: 'HTML', plain_text: part };
  });
}
