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
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Only publisher image CDNs; neither article metadata nor redirects can choose arbitrary hosts.
 * @param {string} value */
export function safeNewsImage(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443'))
      return null;
    if (
      !/^(?:ichef\.bbci\.co\.uk|(?:e\d+|e)\.365dm\.com|img-cdn\.hltv\.org|static\.hltv\.org|i\.guim\.co\.uk|(?:img|cdn|imgcdn|static)\.pravda\.com\.ua|img\.pravda\.com)$/.test(
        u.hostname,
      )
    )
      return null;
    return u.href;
  } catch {
    return null;
  }
}
/** @param {string} text */
export async function newsFingerprint(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
