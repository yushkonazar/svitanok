const entities = /** @type {Record<string, string>} */ ({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
});
/** @param {string} text */
export function decodeNewsText(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (s) => entities[s] ?? s)
    .replace(/&#(\d+);|&#x([0-9a-f]+);/gi, (_, dec, hex) => {
      const n = dec ? Number(dec) : parseInt(hex, 16);
      return n >= 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    });
}
/** @param {string} text */
export const cleanNewsText = (text) =>
  decodeNewsText(text)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Prefer article paragraphs over menus/credits embedded in rich RSS.
 * @param {string} html */
export function newsSourceExcerpt(html) {
  const body = decodeNewsText(html).replace(
    /<(script|style|nav|aside|header|footer|button|svg|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
  const paragraphs = [...body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)];
  if (!paragraphs.length) return cleanNewsText(body);
  const prose = paragraphs
    .filter(
      ([, attrs]) =>
        !/(?:class|id)=["'][^"']*(?:\blabel\b|\bheading-|subtext|breadcrumb|navigation|__meta)/i.test(
          attrs ?? '',
        ),
    )
    .map(([, , text]) => cleanNewsText(text ?? '').replace(/^Explanation:\s*/i, ''))
    .filter(
      (text) =>
        text.length >= 12 &&
        !/^(?:sign up (?:for|to)|subscribe to|continue reading|read more|APOD$|Astronomy Picture of the Day|Discover the cosmos|Each day a different image|Tomorrow[’']s picture|Credit(?:s)?\b)/i.test(
          text,
        ),
    );
  return prose.join(' ');
}
/** Only publisher image CDNs; neither article metadata nor redirects can choose arbitrary hosts.
 * @param {string} value */
export function safeNewsImage(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443'))
      return null;
    if (
      !/^(?:ichef\.bbci\.co\.uk|(?:e\d+|e)\.365dm\.com|img-cdn\.hltv\.org|static\.hltv\.org|i\.guim\.co\.uk|(?:img|cdn|imgcdn|static)\.pravda\.com\.ua|img\.pravda\.com|cdn[0-9]?\.suspilne\.media|s\.dou\.ua|www\.nasa\.gov|science\.nasa\.gov|images-assets\.nasa\.gov|assets\.science\.nasa\.gov)$/.test(
        u.hostname,
      )
    )
      return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Formatting changes alone do not create another unread version. @param {string} text */
export const canonicalNewsText = (text) =>
  cleanNewsText(text)
    .normalize('NFKC')
    .toLocaleLowerCase('uk-UA')
    .replace(/(\d),(?=\d)/g, '$1.')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[−—–]/g, '-')
    .replace(/[^\p{L}\p{N}%₴$€£.+−-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Extract source sentences that add information to the title. No generated facts.
 * @param {string} title @param {string} text @param {number} [limit] */
export function newsContext(title, text, limit = 600) {
  const headline = canonicalNewsText(title);
  const words = (/** @type {string} */ s) =>
    new Set(
      canonicalNewsText(s)
        .split(' ')
        .filter((w) => w.length > 2),
    );
  const titleWords = words(title);
  const facts = (/** @type {string} */ s) =>
    canonicalNewsText(s).match(
      /\d+(?:\.\d+)?|\b(?:not|no|without)\b|(?<!\p{L})(?:не|без)(?!\p{L})/gu,
    ) ?? [];
  const titleFacts = new Set(facts(title));
  const sentences = cleanNewsText(text)
    .replace(/^(?:The post|Read more|Continue reading)[\s\S]*$/i, '')
    .split(/(?<=[.!?])\s+|\n+/);
  const chosen = /** @type {string[]} */ ([]);
  for (let sentence of sentences) {
    sentence = sentence.trim();
    if (
      sentence.length < 12 ||
      /^(?:читайте|дивіться|підпис|реклама|the post|read more|continue reading|APOD Astronomy Picture|Discover the cosmos)/i.test(
        sentence,
      )
    )
      continue;
    const canonical = canonicalNewsText(sentence),
      tokens = words(sentence);
    const fresh = [...tokens].filter((w) => !titleWords.has(w)).length;
    const freshFact = facts(sentence).some((fact) => !titleFacts.has(fact));
    if (
      headline.includes(canonical) ||
      (!freshFact && canonical.includes(headline) && canonical.length < headline.length + 35) ||
      (!freshFact && fresh < Math.max(2, tokens.size * 0.2))
    )
      continue;
    if (chosen.includes(sentence)) continue;
    if ([...chosen, sentence].join(' ').length > limit) {
      if (!chosen.length) chosen.push(sentence.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…');
      break;
    }
    chosen.push(sentence);
    if (chosen.length === 3) break;
  }
  return chosen.join(' ');
}
/** @param {string} text */
export async function newsFingerprint(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
