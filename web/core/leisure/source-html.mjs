/** Explicit hosts only, including every redirect hop. Publisher media has a separate allowlist. */
export const SOURCE_HOSTS = new Set([
  'concert.ua',
  'lviv.travel',
  'jamfactory.ua',
  'www.lvivart.center',
  'planetakino.ua',
  'www.lvivgallery.org.ua',
  'hromadske.radio',
  'anchor.fm',
  'podcasters.spotify.com',
  'opera.lviv.ua',
  'philharmonia.lviv.ua',
  'lvivskansen.org',
  'teatrlesi.lviv.ua',
  'www.lvivconcert.house',
  'multiplex.ua',
  'bookforum.ua',
  'program.bookforum.ua',
]);
/** @param {string} value */
export function decodeHtml(value) {
  const codePoint = (/** @type {number} */ n) =>
    Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)));
}
/** @param {string} html */
export function structuredNodes(html) {
  /** @type {any[]} */ const nodes = [];
  const visit = (/** @type {any} */ value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      nodes.push(value);
      for (const v of Object.values(value)) if (v && typeof v === 'object') visit(v);
    }
  };
  for (const m of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ))
    try {
      visit(JSON.parse(decodeHtml(m[1] ?? '')));
    } catch {
      /* Independent malformed block. */
    }
  return nodes;
}
/** @param {string} html @param {string} base @param {(url: URL)=>boolean} accept */
export function sourceLinks(html, base, accept) {
  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi))
    try {
      const url = new URL(decodeHtml(m[1] ?? ''), base);
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        SOURCE_HOSTS.has(url.hostname) &&
        accept(url)
      ) {
        url.hash = '';
        links.add(url.href);
      }
    } catch {
      /* Invalid publisher reference. */
    }
  return [...links];
}
/** @param {Response} response @param {number} max */
export async function boundedBytes(response, max) {
  if (Number(response.headers.get('content-length')) > max) throw new Error('source-too-large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('source-empty');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error('source-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
/** @param {string} url @returns {Promise<string>} */
export async function sourceText(url) {
  let target = new URL(url);
  for (let redirects = 0; redirects < 3; redirects++) {
    if (
      !SOURCE_HOSTS.has(target.hostname) ||
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port
    )
      throw new Error('source-not-allowed');
    const response = await fetch(target.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: {
        'user-agent': 'Svitanok leisure personal catalogue',
        accept: 'text/html,application/json,application/rss+xml,application/xml',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('source-redirect');
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) throw new Error(`source-http-${response.status}`);
    return new TextDecoder().decode(await boundedBytes(response, 2_000_000));
  }
  throw new Error('source-redirect-limit');
}
/** Main event content only; related cards and page footer cannot supply event facts. @param {string} html */
export function eventBody(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<br\s*\/?\s*>/gi, ' ');
  const start = html.search(/<h1\b/i);
  const body = start < 0 ? '' : html.slice(start);
  const end = body.search(
    /(?:Схожі події|Інші цікаві події|Вас також може зацікавити|<footer\b|Про Concert\.ua)/i,
  );
  return end < 0 ? body : body.slice(0, end);
}
/** @param {string} html @param {string} name */
export function metaContent(html, name) {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = Object.fromEntries(
      [...tag[0].matchAll(/([\w:-]+)=["']([^"']*)["']/g)].map((m) => [
        m[1],
        decodeHtml(m[2] ?? ''),
      ]),
    );
    if (attrs.property === name || attrs.name === name) return attrs.content ?? '';
  }
  return '';
}
