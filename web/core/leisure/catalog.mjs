import { placesSearch } from '../adapters/maps.mjs';
import { kyivDateKey, kyivHour } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { cleanText, httpLink, leisureWeek, normalizeLeisureItem } from './model.mjs';
import { leisureDb, leisureSettings, publishLeisureEdition } from './store.mjs';
import { parseNuxtData } from './nuxt-data.mjs';
import { queueLeisureDigest } from './notifications.mjs';
import { leisureDiscoveryQueries } from './discovery-queries.mjs';

const SOURCE_HOSTS = new Set([
  'concert.ua',
  'lviv.travel',
  'jamfactory.ua',
  'www.lvivart.center',
  'planetakino.ua',
  'www.lvivgallery.org.ua',
  'hromadske.radio',
]);
export const PUBLIC_LEISURE_SOURCES = [
  {
    id: 'podcasts',
    name: 'Громадське радіо · Книжкова полиця',
    url: 'https://hromadske.radio/podcasts/knyzhkova-polytsia-z-tetianoiu-kurmanovoiu/feed',
  },
  { id: 'concert', name: 'Concert.ua', url: 'https://concert.ua/uk/catalog/lviv' },
  { id: 'lviv', name: 'Lviv.travel', url: 'https://lviv.travel/ua/events' },
  { id: 'jam', name: 'Jam Factory', url: 'https://jamfactory.ua/events/' },
  {
    id: 'art',
    name: 'Муніципальний мистецький центр',
    url: 'https://www.lvivart.center/wp-json/wp/v2/events?per_page=40',
  },
  { id: 'planeta', name: 'Планета кіно', url: 'https://planetakino.ua/' },
  {
    id: 'nearby',
    name: 'Lviv.travel · поблизу',
    url: 'https://lviv.travel/ua/around-lviv/place-attractions',
  },
];
/** @param {string} value */
export function decodeHtml(value) {
  const codePoint = (/** @type {number} */ n) =>
    Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)));
}
/** @param {string} html */
export function structuredNodes(html) {
  /** @type {any[]} */ const nodes = [];
  /** @param {any} value */ const visit = (value) => {
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
      /* A malformed block cannot discard the other events. */
    }
  return nodes;
}
/** @param {string} html @param {string} base @param {(url: URL)=>boolean} accept */
export function sourceLinks(html, base, accept) {
  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi))
    try {
      const url = new URL(decodeHtml(m[1] ?? ''), base);
      if (url.protocol === 'https:' && SOURCE_HOSTS.has(url.hostname) && accept(url)) {
        url.hash = '';
        links.add(url.href);
      }
    } catch {
      /* Ignore invalid references. */
    }
  return [...links];
}
/** @param {string} url @returns {Promise<string>} */
async function sourceText(url) {
  let target = new URL(url);
  for (let redirects = 0; redirects < 3; redirects++) {
    if (
      !SOURCE_HOSTS.has(target.hostname) ||
      target.protocol !== 'https:' ||
      target.username ||
      target.password
    )
      throw new Error('source-not-allowed');
    const response = await fetch(target.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: {
        'user-agent': 'Svitanok/0.4 leisure personal catalogue',
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
    if (Number(response.headers.get('content-length')) > 2_000_000)
      throw new Error('source-too-large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('source-empty');
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 2_000_000) {
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
    return new TextDecoder().decode(bytes);
  }
  throw new Error('source-redirect-limit');
}
/** @param {any} event @param {string} source @param {string} url */
export function eventCandidate(event, source, url) {
  const type = String(event['@type'] ?? '');
  if (!/Event/.test(type)) return null;
  const location = event.location,
    offers = Array.isArray(event.offers) ? event.offers[0] : event.offers;
  const title = decodeHtml(String(event.name ?? ''));
  if (/афіша|події цього тижня|розклад подій/i.test(title)) return null;
  const category = /стендап|stand.?up|шоу|театр|вистав[аи]/i.test(title)
    ? 'show'
    : /фестивал|festival|ярмарок/i.test(title)
      ? 'festival'
      : /виставк|exhibition/i.test(title)
        ? 'exhibition'
        : /лекці|зустріч|майстер.?клас|воркшоп|дискусі/i.test(title)
          ? 'meetup'
          : 'concert';
  const address =
    typeof location?.address === 'string'
      ? location.address
      : [location?.address?.addressLocality, location?.address?.streetAddress]
          .filter(Boolean)
          .join(', ');
  const numeric = offers?.lowPrice ?? offers?.price;
  const status = /Cancel/i.test(event.eventStatus ?? '')
    ? 'cancelled'
    : /Postpone/i.test(event.eventStatus ?? '')
      ? 'postponed'
      : /SoldOut|OutOfStock/i.test(offers?.availability ?? '')
        ? 'sold-out'
        : 'available';
  return {
    title,
    summary: decodeHtml(String(event.description ?? '')),
    category,
    venue: location?.name,
    address,
    startDate: event.startDate,
    endDate: event.endDate,
    startAt: event.startDate,
    endAt: event.endDate,
    priceMin: numeric == null ? null : Number(numeric),
    priceBasis: 'person',
    priceNote: 'Опублікована мінімальна ціна квитка; сервісні збори окремо.',
    source,
    sourceUrl: httpLink(event.url) ?? url,
    status,
    lat: location?.geo?.latitude,
    lon: location?.geo?.longitude,
  };
}
const MONTHS = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
/** Explicit years only: publication date is never substituted for an event date.
 * @param {string} text */
export function sourceDateRange(text) {
  const calendar = /dates=(\d{4})(\d{2})(\d{2})T\d+\/(\d{4})(\d{2})(\d{2})T\d+/.exec(
    decodeHtml(text),
  );
  if (calendar)
    return {
      startDate: `${calendar[1]}-${calendar[2]}-${calendar[3]}`,
      endDate: `${calendar[4]}-${calendar[5]}-${calendar[6]}`,
    };
  const short = /(\d{2})\/(\d{2})\/(\d{2})\s*[―–-]\s*(\d{2})\/(\d{2})\/(\d{2})/.exec(text);
  if (short)
    return {
      startDate: `20${short[3]}-${short[2]}-${short[1]}`,
      endDate: `20${short[6]}-${short[5]}-${short[4]}`,
    };
  const matches = [
    ...cleanText(text, 15000).matchAll(
      /(\d{1,2})\s+(січ\S*|лют\S*|бер\S*|кві\S*|тра\S*|чер\S*|лип\S*|сер\S*|вер\S*|жов\S*|лис\S*|гру\S*)\s+(20\d{2})/gi,
    ),
  ];
  if (matches[0]) {
    const m = matches[0],
      month = MONTHS.findIndex((x) => (m[2] ?? '').toLowerCase().startsWith(x)) + 1;
    const key = `${m[3]}-${String(month).padStart(2, '0')}-${(m[1] ?? '').padStart(2, '0')}`;
    return { startDate: key, endDate: key };
  }
  return null;
}
/** @param {string} html @param {string} url @param {string} source */
export function articleCandidate(html, url, source) {
  const title = decodeHtml(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '');
  if (/афіша|події цього тижня|розклад подій/i.test(cleanText(title))) return null;
  const range = sourceDateRange(html);
  if (!title || !range) return null;
  const body = decodeHtml(cleanText(html, 20000));
  const exactPrice =
    /(?:Стандартний|Вартість квитка|Ціна квитка|Квиток)\s*[—–:-]?\s*(\d+(?:[.,]\d+)?)\s*(?:грн|₴)/i.exec(
      body,
    );
  const student = /(?:Для студентів|Студентам)[^.]{0,90}/i.exec(body)?.[0] ?? '';
  const explicitFree = /Вхід (?:на виставку )?безкоштовний(?: за умови|[.,])/i.test(body);
  const address = /Львів,\s*(?:вул\.?|вулиця|площа|пл\.)[^.;]{3,100}/i.exec(body)?.[0] ?? null;
  return {
    title,
    summary: 'Відкрий джерело, щоб переглянути програму та умови відвідування.',
    category: /виставк/i.test(title)
      ? 'exhibition'
      : /кіно|фільм/i.test(title)
        ? 'cinema'
        : /концерт|джаз/i.test(title)
          ? 'concert'
          : /фестивал|ярмарок/i.test(title)
            ? 'festival'
            : /лекці|зустріч|майстер.?клас|воркшоп|дискусі/i.test(title)
              ? 'meetup'
              : 'show',
    ...range,
    sourceUrl: url,
    source,
    address,
    priceMin: explicitFree
      ? 0
      : exactPrice
        ? Number((exactPrice[1] ?? '').replace(',', '.'))
        : null,
    free: explicitFree,
    priceBasis: 'person',
    studentNote: student,
    registration: /попередн[яьої]+\s+реєстрац|попередньої\s+реєстрац/i.test(body),
  };
}
/** Recheck only an already approved, selected public event page. Never infer cancellation from page chrome.
 * @param {any} item @param {number} nowMs */
export async function checkLeisureSource(item, nowMs) {
  if (['food', 'cinema'].includes(item.category)) return { item, verified: false };
  const html = await sourceText(item.sourceUrl);
  const nodes = structuredNodes(html)
    .map((n) => eventCandidate(n, item.source, item.sourceUrl))
    .filter((n) => n !== null);
  const same = nodes.find(
    (n) => n.title.toLocaleLowerCase('uk') === item.title.toLocaleLowerCase('uk'),
  );
  const article = same ?? articleCandidate(html, item.sourceUrl, item.source);
  if (!article || article.title.toLocaleLowerCase('uk') !== item.title.toLocaleLowerCase('uk'))
    return { item, verified: false };
  const updated = await normalizeLeisureItem({ ...article, category: item.category }, nowMs);
  if (!updated) return { item, verified: false };
  return {
    item: {
      ...item,
      ...updated,
      id: item.id,
      sourceUrl: item.sourceUrl,
      venueId: item.venueId,
      placeId: item.placeId,
      status: same ? updated.status : item.status,
      checkedAt: new Date(nowMs).toISOString(),
    },
    verified: Boolean(same),
  };
}
/** @param {any} source @param {number} nowMs @param {any} settings */
export async function collectSource(source, nowMs, settings) {
  if (source.id === 'podcasts')
    return settings.categories?.includes('podcast') ? collectPodcastFeed(source, nowMs) : [];
  if (source.id === 'planeta') return collectPlaneta(nowMs, settings);
  if (source.id === 'nearby') return collectNearby(source, nowMs, settings);
  const html = await sourceText(source.url);
  /** @type {any[]} */ let raw = [];
  const offset = Number(settings.sourceOffset ?? 0),
    limit = Number(settings.sourceBatch ?? 48);
  /** @type {number|null} */ let nextOffset;
  if (source.id === 'art') {
    const data = JSON.parse(html);
    const entries = Array.isArray(data) ? data : [];
    nextOffset = entries.length > offset + limit ? offset + limit : null;
    for (const entry of entries.slice(offset, offset + limit)) {
      const url = httpLink(entry.link);
      if (url && SOURCE_HOSTS.has(new URL(url).hostname)) {
        try {
          const leaf = await sourceText(url);
          const item = articleCandidate(leaf, url, source.name);
          if (item) raw.push(item);
        } catch {
          /* Other entries remain usable. */
        }
      }
    }
  } else if (source.id === 'concert') {
    const candidates = /** @type {any[]} */ (
      structuredNodes(html)
        .map((n) => eventCandidate(n, source.name, source.url))
        .filter(Boolean)
    );
    const unique = [...new Map(candidates.map((c) => [c.sourceUrl, c])).values()];
    const today = kyivDateKey(new Date(nowMs)),
      horizon = addDaysToDateKey(leisureWeek(nowMs), 20);
    const filteredCandidates = unique.filter(
      (c) =>
        c.startDate && c.startDate.slice(0, 10) >= today && c.startDate.slice(0, 10) <= horizon,
    );
    nextOffset = filteredCandidates.length > offset + limit ? offset + limit : null;
    for (const candidate of filteredCandidates.slice(offset, offset + limit)) {
      if (new URL(candidate.sourceUrl).hostname !== 'concert.ua') continue;
      try {
        const leaf = await sourceText(candidate.sourceUrl);
        const exact =
          structuredNodes(leaf)
            .map((n) => eventCandidate(n, source.name, candidate.sourceUrl))
            .find(Boolean) ?? candidate;
        const contentStart = Math.max(0, leaf.search(/<h1\b/i)),
          contentEnd = leaf.search(/Про Concert.ua/);
        const visible = cleanText(
          leaf.slice(contentStart, contentEnd > contentStart ? contentEnd : undefined),
          30000,
        );
        if (/SOLD\s*OUT|Усі квитки продано|Квитки розпродано/i.test(visible))
          exact.status = 'sold-out';
        raw.push(exact);
      } catch {
        /* A leaf price/status was not verified: do not claim a fresh offer. */
      }
    }
  } else {
    const links = sourceLinks(html, source.url, (u) =>
      source.id === 'lviv'
        ? u.hostname === 'lviv.travel' &&
          u.pathname.startsWith('/ua/events/') &&
          !/\/c-|\/events\/$|afisha|podii-tsoho-tyzhnia/.test(u.pathname)
        : u.hostname === 'jamfactory.ua' && /^\/events\/[^/]+\/$/.test(u.pathname),
    );
    nextOffset = links.length > offset + limit ? offset + limit : null;
    for (const url of links.slice(offset, offset + limit)) {
      try {
        const leaf = await sourceText(url);
        const entries = structuredNodes(leaf)
          .map((n) => eventCandidate(n, source.name, url))
          .filter(Boolean);
        if (entries.length) raw.push(...entries);
        else {
          const candidate = articleCandidate(leaf, url, source.name);
          if (candidate) raw.push(candidate);
        }
      } catch {
        /* Keep independent sources usable. */
      }
    }
  }
  const result = [];
  for (const candidate of raw)
    try {
      const normalized = await normalizeLeisureItem(candidate, nowMs);
      if (normalized) result.push(normalized);
    } catch {
      /* A malformed date only removes that candidate. */
    }
  return Object.assign(result, { nextOffset });
}
/** Official nearby-place directory. Availability and admission are not invented.
 * @param {any} source @param {number} nowMs @param {any} [settings] */
export async function collectNearby(source, nowMs, settings = {}) {
  const html = await sourceText(source.url);
  const links = sourceLinks(
    html,
    source.url,
    (u) =>
      u.hostname === 'lviv.travel' &&
      /^\/ua\/places\/(?:attractions|parks)\/[^/]+\/?$/.test(u.pathname),
  );
  const weekIndex = Math.floor(Date.parse(`${leisureWeek(nowMs)}T12:00:00Z`) / (7 * 86400000));
  const offset = links.length ? (weekIndex * 6) % links.length : 0;
  const rotated = [...links.slice(offset), ...links.slice(0, offset)],
    start = Number(settings.sourceOffset ?? 0),
    limit = Number(settings.sourceBatch ?? 24);
  const chosen = rotated.slice(start, start + limit);
  const results = [];
  for (const url of chosen) {
    try {
      const leaf = await sourceText(url),
        title = decodeHtml(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(leaf)?.[1] ?? '');
      const addressLink =
        /<a\b[^>]*href=["']https?:\/\/(?:maps\.google\.com|www\.google\.com\/maps)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(
          leaf,
        )?.[1];
      const meta = /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(
        leaf,
      )?.[1];
      const item = await normalizeLeisureItem(
        {
          title,
          category: 'trip',
          venue: title,
          address: addressLink ? decodeHtml(cleanText(addressLink, 250)) : null,
          summary: meta
            ? decodeHtml(meta)
            : 'Місце для поїздки зі Львова. Перед виїздом перевір доступність і години роботи у джерелі.',
          source: source.name,
          sourceUrl: url,
          priceNote: 'Вхід, пальне та інші витрати уточнюються окремо.',
        },
        nowMs,
      );
      if (item) results.push(item);
    } catch {
      /* A place without verified source data is omitted. */
    }
  }
  return Object.assign(results, {
    nextOffset: rotated.length > start + limit ? start + limit : null,
  });
}
/** Only published genre words, not country labels or mood descriptions.
 * @param {any} movie */
export function publishedFilmGenres(movie) {
  const explicit = [
    ...(Array.isArray(movie.genres) ? movie.genres : []),
    ...(Array.isArray(movie.categories)
      ? movie.categories
      : Array.isArray(movie.categories?.genres)
        ? movie.categories.genres
        : []),
  ].map((c) => (typeof c === 'string' ? c : c.name));
  const tags = (Array.isArray(movie.cloudTags) ? movie.cloudTags : []).filter(
    (/** @type {unknown} */ t) =>
      typeof t === 'string' &&
      /бойов|екшн|трилер|комеді|драм|фантаст|фентез|жах|анімац|мульт|документ|романт|мелодрам|пригод|кримін|детектив|історич|мюзикл/i.test(
        t,
      ),
  );
  return [...new Set([...explicit, ...tags].filter(Boolean))].join(', ');
}
/** Public publisher-linked RSS, bounded metadata only; no audio download.
 * @param {any} source @param {number} nowMs */
export async function collectPodcastFeed(source, nowMs) {
  const xml = await sourceText(source.url),
    result = [];
  for (const match of [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 10)) {
    const body = match[1] ?? '';
    const field = (/** @type {string} */ name) =>
      decodeHtml(
        (
          new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(
            body,
          )?.[1] ?? ''
        ).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'),
      ).trim();
    const link = httpLink(field('link'));
    if (!link || new URL(link).hostname !== 'hromadske.radio') continue;
    const duration = field('itunes:duration'),
      parts = duration.split(':').map(Number);
    const seconds =
      parts.length === 3
        ? (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
        : parts.length === 2
          ? (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
          : Number(duration);
    const normalized = await normalizeLeisureItem(
      {
        title: field('title'),
        category: 'podcast',
        guid: field('guid') || link,
        identity: field('guid') || link,
        source: source.name,
        sourceUrl: link,
        summary: cleanText(field('description'), 300),
        durationMinutes: seconds > 0 ? Math.ceil(seconds / 60) : null,
        publishedAt: field('pubDate'),
        priceNote: 'Умови прослуховування — на платформі видавця.',
      },
      nowMs,
    );
    if (normalized) result.push(normalized);
  }
  return result;
}
/** Verified schedule data for the explicitly selected cinema/date. No checkout requests.
 * @param {number} nowMs @param {any} settings */
export async function collectPlaneta(nowMs, settings) {
  const today = kyivDateKey(new Date(nowMs)),
    end = addDaysToDateKey(leisureWeek(nowMs), 6);
  /** @type {Map<string,any>} */ const movies = new Map();
  let verifiedPages = 0;
  for (const selected of settings.cinemas) {
    const slug = selected === 'forum-lviv' ? 'forum-lviv' : 'king-cross-leopolis',
      cinema = selected === 'forum-lviv' ? 'Forum Lviv' : 'King Cross Leopolis',
      address = selected === 'forum-lviv' ? 'Львів, Під Дубом, 7Б' : 'Сокільники, Стрийська, 30';
    for (let date = today; date <= end; date = addDaysToDateKey(date, 1)) {
      let state;
      try {
        state = parseNuxtData(
          await sourceText(`https://planetakino.ua/schedule/?cinema=${slug}&date=${date}`),
        );
      } catch {
        continue;
      }
      const list = state?.data?.[0]?.movies;
      if (!Array.isArray(list)) continue;
      verifiedPages++;
      for (const movie of list) {
        if (!movie.slug || !movie.name || !Array.isArray(movie.offlineRental?.sessions)) continue;
        const url = `https://planetakino.ua/movie/${encodeURIComponent(movie.slug)}/`;
        const current = movies.get(movie.id) ?? {
          title: movie.name,
          category: 'cinema',
          summary: movie.shortDescription ?? '',
          source: 'Планета кіно',
          sourceUrl: url,
          identity: url,
          startDate: movie.offlineRental.start,
          endDate: movie.offlineRental.end,
          durationMinutes: Math.round(Number(movie.durationInSec) / 60),
          age: movie.ageRestrictions,
          genre: publishedFilmGenres(movie),
          sessions: [],
          studentNote: (Array.isArray(movie.offlineRental.labels)
            ? movie.offlineRental.labels
            : []
          ).some((/** @type {any} */ l) => l.group === 'DISCOUNT')
            ? 'Джерело позначає дію знижок. Студентські умови й ціну перевір у касі.'
            : 'Студентська знижка на ці покази не підтверджена.',
        };
        for (const session of movie.offlineRental.sessions) {
          const startAt = session.startSessionAt;
          if (
            !session.id ||
            !Number.isFinite(Date.parse(startAt)) ||
            kyivDateKey(new Date(startAt)) !== date ||
            Date.parse(startAt) < nowMs
          )
            continue;
          if (current.sessions.some((/** @type {any} */ s) => s.id === session.id)) continue;
          current.sessions.push({
            id: session.id,
            cinema,
            cinemaSlug: slug,
            address,
            startAt,
            endAt:
              current.durationMinutes > 0
                ? new Date(Date.parse(startAt) + current.durationMinutes * 60000).toISOString()
                : null,
            format: [session.rentalTechnology?.name, session.dimensionType]
              .filter(Boolean)
              .join(' · '),
            language: '',
            price: null,
            url: `${url}?cinema=${slug}`,
          });
        }
        movies.set(movie.id, current);
      }
    }
  }
  const result = [];
  if (!verifiedPages) throw new Error('planeta-schedule-unavailable');
  for (const raw of movies.values()) {
    raw.status = raw.sessions.length ? 'available' : 'schedule-pending';
    if (raw.sessions.length) {
      const dates = raw.sessions
        .map((/** @type {any} */ s) => kyivDateKey(new Date(s.startAt)))
        .sort();
      raw.startDate = dates[0];
      raw.endDate = dates[dates.length - 1];
    }
    try {
      const item = await normalizeLeisureItem(raw, nowMs);
      if (item) result.push(item);
    } catch {
      /* A malformed film cannot discard the cinema catalogue. */
    }
  }
  return result;
}
/** @param {Env} env @param {number} [nowMs] @param {boolean} [cinemaOnly] */
export async function refreshLeisureCatalog(env, nowMs = Date.now(), cinemaOnly = false) {
  const settings = await leisureSettings(env);
  if (!settings.enabled) return { message: 'Оновлення дозвілля вимкнено.' };
  const db = leisureDb(env);
  const last = await db
    .prepare("SELECT updated_at FROM leisure_records WHERE id='refresh-lock'")
    .first();
  if (last && nowMs - Date.parse(String(last.updated_at)) < 300000)
    return { message: 'Добірка вже оновлюється або щойно оновлена.' };
  const locked = await db
    .prepare(
      "INSERT INTO leisure_records (id,kind,data_json,updated_at) VALUES ('refresh-lock','system','{}',?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at WHERE updated_at < ?",
    )
    .bind(new Date(nowMs).toISOString(), new Date(nowMs - 300000).toISOString())
    .run();
  if (!locked.meta.changes) return { message: 'Добірка вже оновлюється.' };
  const chosen = cinemaOnly
    ? PUBLIC_LEISURE_SOURCES.filter((s) => s.id === 'planeta')
    : PUBLIC_LEISURE_SOURCES;
  const outputs = await Promise.allSettled(
    chosen.map((source) => collectSource(source, nowMs, settings)),
  );
  const sources = outputs.map((result, i) => ({
    id: chosen[i]?.id ?? '',
    name: chosen[i]?.name ?? '',
    url: chosen[i]?.url ?? '',
    status:
      result.status === 'fulfilled' && result.value.length
        ? 'ok'
        : result.status === 'fulfilled'
          ? 'empty'
          : 'unavailable',
    checkedAt: new Date(nowMs).toISOString(),
    count: result.status === 'fulfilled' ? result.value.length : 0,
  }));
  const items = outputs.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!cinemaOnly && env.MAPS_API_KEY) {
    try {
      const queries = leisureDiscoveryQueries(settings, null, nowMs);
      const outputs = await Promise.allSettled(
        queries.map((entry) =>
          placesSearch(env, { query: entry.query, city: settings.city, limit: 8 }, nowMs),
        ),
      );
      const fresh = outputs.flatMap((r, index) =>
        r.status === 'fulfilled' && r.value.source === 'api'
          ? [{ ...r.value, leisureCategory: queries[index]?.category ?? 'food' }]
          : [],
      );
      if (!fresh.length) throw new Error('places-not-fresh');
      const places = {
        places: [
          ...new Map(
            fresh
              .flatMap((r) => r.places.map((p) => ({ ...p, leisureCategory: r.leisureCategory })))
              .map((p) => [p.place_id, p]),
          ).values(),
        ],
      };
      for (const place of places.places) {
        const item = await normalizeLeisureItem(
          {
            title: place.name,
            address: place.address,
            venue: place.name,
            placeId: place.place_id,
            placeType: place.place_type,
            lat: place.lat,
            lon: place.lon,
            category: place.leisureCategory,
            source: 'Google Places',
            sourceUrl:
              place.maps_uri ??
              `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${encodeURIComponent(place.place_id)}`,
            summary: 'Заклад у Львові. Чек і бронювання перевіряються окремо.',
          },
          nowMs,
        );
        if (item) items.push(item);
      }
      sources.push({
        id: 'places',
        name: 'Google Places',
        url: 'https://maps.google.com/',
        status: 'ok',
        checkedAt: new Date(nowMs).toISOString(),
        count: places.places.length,
      });
    } catch {
      sources.push({
        id: 'places',
        name: 'Google Places',
        url: 'https://maps.google.com/',
        status: 'unavailable',
        checkedAt: new Date(nowMs).toISOString(),
        count: 0,
      });
    }
  }
  const edition = await publishLeisureEdition(env, items, sources, nowMs, cinemaOnly);
  return {
    message: items.length
      ? 'Добірку оновлено.'
      : 'Не вдалося підтвердити нові варіанти. Попередню добірку збережено.',
    week: edition.week,
    count: items.length,
  };
}
/** Monday 08:00 local; a targeted cinema supplement after the evening publication.
 * @param {Env} env @param {number} [nowMs] */
export async function leisureCatalogTask(env, nowMs = Date.now()) {
  if (!env.DB) return;
  const settings = await leisureSettings(env);
  if (!settings.enabled) return;
  const week = leisureWeek(nowMs),
    today = kyivDateKey(new Date(nowMs)),
    hour = kyivHour(new Date(nowMs));
  const row = await env.DB.prepare('SELECT data_json FROM leisure_editions WHERE week=?')
    .bind(week)
    .first();
  const edition = row ? JSON.parse(String(row.data_json)) : null;
  if (edition && edition.catalogVersion !== 3)
    return env.LEISURE_CATALOG?.getByName('owner').request('full', nowMs);
  if (edition && settings.telegram && hour >= settings.updateHour)
    await queueLeisureDigest(env, nowMs);
  if (today === week && hour >= settings.updateHour - 1 && !edition)
    return env.LEISURE_CATALOG?.getByName('owner').request('full', nowMs);
  if (
    hour >= settings.updateHour &&
    edition &&
    (String(edition.cinemaUpdatedAt ?? '').slice(0, 10) !==
      new Date(nowMs).toISOString().slice(0, 10) ||
      (today === week &&
        hour >= 20 &&
        kyivHour(new Date(edition.cinemaUpdatedAt ?? edition.createdAt)) < 20))
  )
    return env.LEISURE_CATALOG?.getByName('owner').request('daily', nowMs);
}
