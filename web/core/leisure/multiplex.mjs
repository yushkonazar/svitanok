import { cleanText, normalizeLeisureItem } from './model.mjs';
import { sourceText, decodeHtml, metaContent } from './source-html.mjs';
import { leisureLocalInstant } from './schedule.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';

/** Movie JSON-LD may be malformed on the publisher page. Read scoped visible labels instead.
 * @param {string} html */
export function multiplexFilmDetails(html) {
  const visible = (/** @type {string} */ key) =>
    decodeHtml(
      cleanText(
        new RegExp(
          '<p[^>]*class=["\']key["\'][^>]*>\\s*' +
            key +
            ':?\\s*</p>\\s*<p[^>]*class=["\']val["\'][^>]*>([\\s\\S]*?)</p>',
          'i',
        ).exec(html)?.[1],
      ),
    );
  const duration = /^(\d{1,2}):(\d{2})$/.exec(visible('Тривалість'));
  const original = /"alternativeHeadline"\s*:\s*"([^"\n]+)"/.exec(html)?.[1] ?? '';
  const year = /"dateCreated"\s*:\s*"(20\d{2})-/.exec(html)?.[1];
  return {
    durationMinutes: duration ? Number(duration[1]) * 60 + Number(duration[2]) : null,
    genre: visible('Жанр'),
    summary: metaContent(html, 'description') || metaContent(html, 'Description'),
    film: {
      originalTitle: decodeHtml(original),
      year: year ? Number(year) : null,
      countries: visible('Виробництво'),
      language: decodeHtml(
        cleanText(/id=["']mvi_language["'][^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1]),
      ),
      imdbId: /imdb\.com\/title\/(tt\d{5,12})/.exec(html)?.[1],
    },
  };
}
/** One public schedule contains explicit date anchors for published sessions only.
 * @param {string} html @param {number} nowMs */
export function parseMultiplexSchedule(html, nowMs) {
  /** @type {Map<string,any>} */ const films = new Map();
  for (const block of html.split(/<div\s+class=["']film["'][^>]*>/i).slice(1)) {
    const path = /href=["'](\/movie\/\d+)(?:#[^"']*)?["']/i.exec(block)?.[1];
    if (!path) continue;
    const sessions = [];
    for (const a of block.matchAll(
      /<a\b([^>]*data-session-id=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi,
    )) {
      const attrs = Object.fromEntries(
        [...(a[1] ?? '').matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
          m[1],
          decodeHtml(m[2] ?? m[3] ?? ''),
        ]),
      );
      if (/locked|disabled/.test(attrs.class ?? '')) continue;
      const date = /^(\d{2})(\d{2})(\d{4})$/.exec(attrs['data-anchor'] ?? '');
      const time = /\b([012]?\d:[0-5]\d)\b/
        .exec(cleanText((a[2] ?? '').replace(/<[^>]*>/g, ' ')))?.[1]
        ?.padStart(5, '0');
      if (!date || !time) continue;
      const key = `${date[3]}-${date[2]}-${date[1]}`;
      let start;
      try {
        start = leisureLocalInstant(key, time);
      } catch {
        continue;
      }
      if (start < nowMs || start > nowMs + 21 * 86400000) continue;
      const low = Number(attrs['data-low']),
        high = Number(attrs['data-high']);
      const tag = decodeHtml(
        cleanText(/class=["']tag["'][^>]*>([\s\S]*?)<\/p>/i.exec(a[2] ?? '')?.[1], 80),
      );
      sessions.push({
        id: 'multiplex:' + attrs['data-session-id'],
        cinema: 'Multiplex Victoria Gardens',
        cinemaSlug: 'multiplex-victoria',
        address: 'Львів, Кульпарківська, 226А',
        startAt: new Date(start).toISOString(),
        endAt: null,
        format: tag,
        language: /UaSUB|SDH/i.test(tag) ? tag : '',
        price: low > 0 && low === high ? low : null,
        url: `https://new.multiplex.ua/order/cinema/0000000020/session/${encodeURIComponent(attrs['data-session-id'] ?? '')}`,
      });
    }
    if (!sessions.length) continue;
    const title = decodeHtml(/data-name=["']([^"']+)["']/i.exec(block)?.[1] ?? '');
    if (!title) continue;
    const poster = /background-image:\s*url\(['"]?([^)'"\s]+)['"]?\)/i.exec(block)?.[1];
    const film = films.get(path) ?? {
      title,
      source: 'Multiplex',
      sourceUrl: 'https://multiplex.ua' + path,
      category: 'cinema',
      sessions: [],
      media: poster
        ? [
            {
              url: new URL(poster, 'https://multiplex.ua').href,
              kind: 'poster',
              credit: 'Multiplex',
            },
          ]
        : [],
      age: decodeHtml(cleanText(/class=["']age["'][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1])),
    };
    for (const session of sessions)
      if (!film.sessions.some((/** @type {any} */ s) => s.id === session.id))
        film.sessions.push(session);
    films.set(path, film);
  }
  return [...films.values()];
}
/** @param {number} nowMs @param {any} settings */
export async function collectMultiplex(nowMs, settings) {
  if (!settings.cinemas.includes('multiplex-victoria')) return [];
  const html = await sourceText('https://multiplex.ua/cinema/lviv/victoriagardens');
  const raw = parseMultiplexSchedule(html, nowMs),
    offset = Number(settings.sourceOffset ?? 0),
    limit = Math.min(10, Number(settings.sourceBatch ?? 10));
  const result = [];
  for (const item of raw.slice(offset, offset + limit))
    try {
      const details = multiplexFilmDetails(await sourceText(item.sourceUrl));
      Object.assign(item, details);
      item.sessions.forEach((/** @type {any} */ s) => {
        if (details.durationMinutes)
          s.endAt = new Date(Date.parse(s.startAt) + details.durationMinutes * 60000).toISOString();
      });
      const dates = item.sessions
        .map((/** @type {any} */ s) => kyivDateKey(new Date(s.startAt)))
        .sort();
      const normalized = await normalizeLeisureItem(
        { ...item, startDate: dates[0], endDate: dates.at(-1), status: 'available' },
        nowMs,
      );
      if (normalized) result.push(normalized);
    } catch {
      /* No duration means this film cannot become a confirmed route anchor. */
    }
  return Object.assign(result, { nextOffset: raw.length > offset + limit ? offset + limit : null });
}
