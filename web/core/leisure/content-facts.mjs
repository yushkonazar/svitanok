/** Media addresses remain publisher-owned. Only known publisher/CDN hosts may be fetched. */
export const LEISURE_MEDIA_HOSTS = new Set([
  'concert.ua',
  'images.concert.ua',
  'storage.concert.ua',
  'lviv.travel',
  'jamfactory.ua',
  'www.lvivart.center',
  'cdn.planetakino.ua',
  'planetakino.ua',
  'opera.lviv.ua',
  'philharmonia.lviv.ua',
  'lvivskansen.org',
  'teatrlesi.lviv.ua',
  'static.wixstatic.com',
  'www.lvivconcert.house',
  'hromadske.radio',
  'static.hromadske.radio',
  'd3t3ozftmdmh3i.cloudfront.net',
  'd3ctxlq1ktw2nl.cloudfront.net',
  'd3wo5wojvuv7l.cloudfront.net',
  'is1-ssl.mzstatic.com',
  'is2-ssl.mzstatic.com',
  'image-cdn-ak.spotifycdn.com',
  'i.scdn.co',
  'multiplex.ua',
]);
/** @param {unknown} value @param {string} [base] */
export function leisureMediaUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(String(value), base);
    return u.protocol === 'https:' &&
      !u.port &&
      !u.username &&
      !u.password &&
      u.href.length < 1800 &&
      LEISURE_MEDIA_HOSTS.has(u.hostname)
      ? u.href
      : null;
  } catch {
    return null;
  }
}
const text = (/** @type {unknown} */ v, max = 250) =>
  String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
/** @param {any} raw @param {string} sourceUrl @param {string} source */
export function normalizeContentFacts(raw, sourceUrl, source) {
  const media = (Array.isArray(raw.media) ? raw.media : [])
    .slice(0, 8)
    .map((/** @type {any} */ m) => ({
      url: leisureMediaUrl(m.url, sourceUrl),
      kind: ['poster', 'cover', 'photo'].includes(m.kind) ? m.kind : 'photo',
      credit: text(m.credit || source),
      alt: text(m.alt || raw.title),
    }))
    .filter((/** @type {any} */ m) => m.url);
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .slice(0, 16)
    .filter((/** @type {any} */ e) =>
      ['schedule', 'price', 'location', 'media', 'duration', 'language', 'hours'].includes(e.field),
    )
    .map((/** @type {any} */ e) => ({
      field: e.field,
      status: ['published', 'inferred', 'conflicting', 'unknown'].includes(e.status)
        ? e.status
        : 'unknown',
      note: text(e.note, 350),
    }));
  return {
    media,
    evidence,
    qualityWarnings: [
      ...new Set(
        (Array.isArray(raw.qualityWarnings) ? raw.qualityWarnings : [])
          .map((/** @type {any} */ w) => text(w, 350))
          .filter(Boolean),
      ),
    ].slice(0, 8),
    priceOffers: (Array.isArray(raw.priceOffers) ? raw.priceOffers : [])
      .slice(0, 12)
      .filter(
        (/** @type {any} */ o) =>
          typeof o.min === 'number' &&
          (o.min > 0 || (o.min === 0 && raw.free === true)) &&
          Number.isFinite(o.min),
      )
      .map((/** @type {any} */ o) => ({
        min: o.min,
        max: typeof o.max === 'number' && Number.isFinite(o.max) && o.max >= o.min ? o.max : null,
        currency: /^[A-Z]{3}$/.test(o.currency ?? '') ? o.currency : 'UAH',
        eligibility: text(o.eligibility || 'Стандартний квиток'),
        note: text(o.note, 350),
      })),
    film: raw.film
      ? {
          originalTitle: text(raw.film.originalTitle, 180),
          year:
            Number.isInteger(raw.film.year) && raw.film.year >= 1888 && raw.film.year <= 2200
              ? raw.film.year
              : null,
          countries: text(raw.film.countries),
          language: text(raw.film.language, 80),
          subtitles: text(raw.film.subtitles, 80),
          imdbRating:
            typeof raw.film.imdbRating === 'number' &&
            raw.film.imdbRating > 0 &&
            raw.film.imdbRating <= 10
              ? raw.film.imdbRating
              : null,
          imdbVotes:
            Number.isInteger(raw.film.imdbVotes) && raw.film.imdbVotes > 0
              ? raw.film.imdbVotes
              : null,
          imdbId: /^tt\d{5,12}$/.test(raw.film.imdbId ?? '') ? raw.film.imdbId : null,
        }
      : null,
    podcast: raw.podcast
      ? {
          series: text(raw.podcast.series, 180),
          publisher: text(raw.podcast.publisher, 180),
          language: text(raw.podcast.language, 50),
          explicit: typeof raw.podcast.explicit === 'boolean' ? raw.podcast.explicit : null,
        }
      : null,
  };
}

/** Costs for two; optional concession offers never replace the standard price.
 * @param {any} item @param {any} [session] */
export function leisureCostRange(item, session) {
  if (session?.price != null)
    return {
      min: Math.round(session.price * 200),
      max: Math.round(session.price * 200),
      unknown: false,
      approximate: false,
    };
  const p = item.price;
  if (p?.min == null || (p.currency ?? 'UAH') !== 'UAH' || !['person', 'pair'].includes(p.basis)) {
    const range = item.category === 'food' ? item.placeDetails?.price_range : null;
    const money = (/** @type {any} */ v) =>
      v?.currencyCode === 'UAH' &&
      v.units != null &&
      Number.isFinite(Number(v.units)) &&
      Number(v.units) >= 0
        ? Math.round((Number(v.units) + Number(v.nanos ?? 0) / 1e9) * 200)
        : null;
    const low = money(range?.startPrice),
      high = money(range?.endPrice);
    if (low != null)
      return {
        min: low,
        max: high != null && high >= low ? high : null,
        unknown: false,
        approximate: true,
      };
    return { min: 0, max: null, unknown: true, approximate: false };
  }
  const multiplier = p.basis === 'person' ? 200 : 100;
  return {
    min: Math.round(p.min * multiplier),
    max: p.max == null ? (p.min === 0 ? 0 : null) : Math.round(p.max * multiplier),
    unknown: false,
    approximate: false,
  };
}

/** Exact cross-provider film metadata only; no title-only or fuzzy merging.
 * @param {any} item */
export function leisureFilmKey(item) {
  return leisureFilmKeys(item)[0] ?? null;
}
/** Alternative exact identities are needed when only one provider publishes IMDb.
 * @param {any} item @returns {string[]} */
export function leisureFilmKeys(item) {
  if (item.category !== 'cinema') return [];
  const keys = [];
  if (/^tt\d{5,12}$/.test(item.film?.imdbId ?? '')) keys.push('imdb:' + item.film.imdbId);
  const original = String(item.film?.originalTitle ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]/gu, '');
  if (
    original &&
    Number.isInteger(item.film?.year) &&
    item.film.year >= 1888 &&
    item.film.year <= 2200
  )
    keys.push('original:' + original + ':' + item.film.year);
  return keys;
}
