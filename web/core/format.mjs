// Спільне форматування для тексту власнику: гроші в мінімальних одиницях і
// зачистка назв зі сторонніх джерел.
//
// Жили в `chains/price.mjs` (їхній перший споживач). Етап 6 приніс третього
// (фінанси Mono), а гроші - наскрізна річ, не деталь ланцюга цін: модуль без
// платформних імпортів, щоб його могли брати і адаптери, і задачі, і чат.

const CURRENCY_LABEL = /** @type {Record<string, string>} */ ({
  UAH: 'грн',
  USD: '$',
  EUR: '€',
  PLN: 'zł',
});

/** 329950 UAH → «3 299,50 грн»; 329900 → «3 299 грн». @param {number} minor @param {string} currency */
export function formatMoney(minor, currency) {
  const abs = Math.abs(Math.round(minor));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cents = abs % 100;
  const num = `${minor < 0 ? '−' : ''}${whole}${cents ? `,${String(cents).padStart(2, '0')}` : ''}`;
  // Object.hasOwn: валюта приходить із чужих API, і «constructor» витягнув
  // би функцію з прототипу прямо в текст власнику.
  const label = Object.hasOwn(CURRENCY_LABEL, currency) ? CURRENCY_LABEL[currency] : currency;
  return `${num} ${label}`;
}

/** Назва магазину без розмітки й посилань: [текст](url) → текст, голі URL геть. @param {string} s */
export function cleanSource(s, max = 40) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[^\p{L}\p{N} .'&-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
