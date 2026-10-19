import { kyivDateKey } from '../../kyiv-time.mjs';
import { cleanText, normalizeLeisureItem } from './model.mjs';
import {
  sourceText,
  sourceLinks,
  structuredNodes,
  decodeHtml,
  eventBody,
  metaContent,
} from './source-html.mjs';
import {
  articleCandidate,
  eventCandidate,
  publisherMedia,
  publisherBooking,
  eventCategory,
} from './publisher-parsers.mjs';
import { leisureMediaUrl } from './content-facts.mjs';
import { leisureLocalInstant } from './schedule.mjs';

export const VENUE_LEISURE_SOURCES = [
  { id: 'opera', name: 'Львівська опера', url: 'https://opera.lviv.ua/afisha/month/' },
  { id: 'philharmonia', name: 'Львівська філармонія', url: 'https://philharmonia.lviv.ua/events/' },
  { id: 'organ', name: 'Львівський органний зал', url: 'https://www.lvivconcert.house/events' },
  { id: 'lesia', name: 'Театр Лесі', url: 'https://teatrlesi.lviv.ua/afisha/' },
  {
    id: 'skansen',
    name: 'Львівський скансен · майстер-класи',
    url: 'https://lvivskansen.org/master-classes/',
  },
  {
    id: 'attractions',
    name: 'Lviv.travel · музеї та атракції',
    url: 'https://lviv.travel/ua/places/attractions',
  },
  { id: 'bookforum', name: 'BookForum · сезонна програма', url: 'https://bookforum.ua/' },
];
/** Join calendar occurrences to public show links. Broken Event redirects are never followed.
 * @param {string} html @param {string} source @param {number} nowMs */
export function parseOperaCalendar(html, source, nowMs) {
  const nameKey = (/** @type {string} */ s) =>
    decodeHtml(cleanText(s))
      .toLocaleLowerCase('uk')
      .replace(/[^\p{L}\p{N}]/gu, '');
  /** @type {Map<string,any>} */ const links = new Map();
  for (const m of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = m[1] ?? '';
    const anchor =
      /<a\b[^>]*href=["'](https:\/\/opera\.lviv\.ua\/shows\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(
        block,
      );
    const date = /datetime=["'](\d{4}-\d{2}-\d{2})/i.exec(block)?.[1];
    if (!anchor || !date) continue;
    const spans = [
      ...block.matchAll(/show-details-item[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/gi),
    ].map((s) => decodeHtml(cleanText(s[1])));
    links.set(nameKey(anchor[2] ?? '') + '|' + date, {
      url: anchor[1],
      stage: spans.at(-1),
      format: spans[0],
    });
  }
  /** @type {Map<string,any>} */ const groups = new Map();
  const seen = new Set();
  for (const node of structuredNodes(html)) {
    const e = eventCandidate(node, source, 'https://opera.lviv.ua/afisha/month/');
    if (!e || !Number.isFinite(Date.parse(e.startAt)) || Date.parse(e.endAt || e.startAt) < nowMs)
      continue;
    const date = String(e.startDate).slice(0, 10),
      stamp = e.sourceUrl + '|' + e.startAt;
    if (seen.has(stamp)) continue;
    seen.add(stamp);
    const detail = links.get(nameKey(e.title) + '|' + date);
    const key = detail?.url || e.sourceUrl;
    const group = groups.get(key) ?? {
      ...e,
      identity: 'opera-show:' + key,
      sourceUrl: detail?.url || 'https://opera.lviv.ua/afisha/month/',
      category: /салон|концерт/i.test(detail?.format ?? '') ? 'concert' : 'show',
      venue: detail?.stage ? source + ' · ' + detail.stage : source,
      schedule: { kind: 'once', precision: 'exact', occurrences: [] },
      startAt: null,
      endAt: null,
    };
    group.schedule.occurrences.push({ startAt: e.startAt, endAt: e.endAt });
    group.schedule.occurrences.sort((/** @type {any} */ a, /** @type {any} */ b) =>
      a.startAt.localeCompare(b.startAt),
    );
    group.startDate = group.schedule.occurrences[0].startAt.slice(0, 10);
    group.endDate = group.schedule.occurrences.at(-1).startAt.slice(0, 10);
    groups.set(key, group);
  }
  return [...groups.values()];
}
/** @param {string} html @param {string} url @param {string} source */
export function parsePhilharmonia(html, url, source) {
  const item = articleCandidate(html, url, source);
  if (!item) return null;
  const main = eventBody(html);
  const price = decodeHtml(cleanText(/price-icon\.svg[^>]*>([\s\S]*?)<\/p>/i.exec(main)?.[1]));
  const amount = /^(?:₴\s*)?(\d+)(?:\s*[–—-]\s*(\d+))?\s*(?:грн|₴)?$/.exec(price);
  const free = /^Вхід вільний$/i.test(price);
  const photo = leisureMediaUrl(
    /class=["']event-photo["'][^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)/i.exec(main)?.[1],
    url,
  );
  const desc = /class=["']event-description["'][^>]*>([\s\S]*?)(?:<\/section>|<footer\b)/i.exec(
    main,
  )?.[1];
  return {
    ...item,
    category: 'concert',
    venue: cleanText(/location-icon\.svg[^>]*>([\s\S]*?)<\/p>/i.exec(main)?.[1]) || source,
    address: null, // A chamber/organ location must not silently inherit the main hall address.
    summary: desc ? decodeHtml(cleanText(desc, 650)) : item.summary,
    priceMin: free ? 0 : amount ? Number(amount[1]) : null,
    priceMax: free ? 0 : amount ? Number(amount[2] ?? amount[1]) : null,
    free,
    priceNote: 'Опублікована ціна квитка; сервісні збори уточнюються при купівлі.',
    media: photo ? [{ url: photo, kind: 'poster', credit: source }] : item.media,
  };
}
/** Read the public SSR data; never call Wix private APIs or execute site scripts.
 * @param {string} html @param {string} source */
export function parseOrganEvents(html, source) {
  const json = /<script\b[^>]*id=["']wix-warmup-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(
    html,
  )?.[1];
  if (!json) return [];
  /** @type {Map<string,any>} */ const events = new Map();
  const visit = (/** @type {any} */ v, depth = 0) => {
    if (depth > 18 || !v) return;
    if (typeof v === 'string' && v.length < 1_000_000 && v.includes('"scheduling"')) {
      try {
        visit(JSON.parse(v), depth + 1);
      } catch {
        /* Non-JSON component. */
      }
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (typeof v === 'object') {
      if (v.scheduling?.config && v.slug && v.title && !v.scheduling.config.scheduleTbd)
        events.set(v.id || v.slug, v);
      else Object.values(v).forEach((x) => visit(x, depth + 1));
    }
  };
  try {
    visit(JSON.parse(json));
  } catch {
    return [];
  }
  return [...events.values()].map((e) => {
    const cfg = e.scheduling.config,
      url = 'https://www.lvivconcert.house/event-details/' + encodeURIComponent(e.slug);
    const multiDay = cfg.startDate?.slice(0, 10) !== cfg.endDate?.slice(0, 10);
    return {
      title: e.title,
      category: eventCategory(e.title),
      summary: e.description || e.about || '',
      startDate: cfg.startDate,
      endDate: cfg.endDate || cfg.startDate,
      startAt: multiDay ? null : cfg.startDate,
      endAt: multiDay ? null : cfg.endDate,
      venue: e.location?.name,
      address: e.location?.address,
      lat: e.location?.coordinates?.lat,
      lon: e.location?.coordinates?.lng,
      source,
      sourceUrl: url,
      siteUrl: 'https://www.lvivconcert.house/',
      bookingUrl: url,
      // Wix ticketing soldOut belongs to native tickets; many events use external tickets.
      // Do not claim cancellation/sold-out from an unused widget's default state.
      status: 'available',
      registration: false,
      schedule: multiDay
        ? { kind: 'visit', precision: 'date' }
        : { kind: 'once', precision: 'exact' },
      evidence: [
        { field: 'schedule', status: 'published', note: 'Опублікований календар Органного залу' },
      ],
      media: e.mainImage?.url ? [{ url: e.mainImage.url, kind: 'poster', credit: source }] : [],
    };
  });
}
/** @param {string} html @param {string} source @param {number} nowMs */
export function parseLesiaListing(html, source, nowMs) {
  const current = kyivDateKey(new Date(nowMs)),
    year = Number(current.slice(0, 4));
  return html
    .split(/<div\b[^>]*class=["']single-performance single-afisha[^"']*["'][^>]*>/i)
    .slice(1)
    .flatMap((block) => {
      const dateHtml =
        /class=["']single-performance__date[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? '';
      const date = decodeHtml(cleanText(dateHtml));
      const m =
        /(\d{1,2})\s+(січ\S*|лют\S*|бер\S*|кві\S*|тра\S*|чер\S*|лип\S*|сер\S*|вер\S*|жов\S*|лис\S*|гру\S*)/i.exec(
          date,
        );
      const time = /\b([012]?\d:[0-5]\d)\b/.exec(date)?.[1]?.padStart(5, '0');
      const title = decodeHtml(
        cleanText(
          /class=["']single-performance__title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1],
        ),
      );
      const url = sourceLinks(block, 'https://teatrlesi.lviv.ua/', (u) =>
        u.pathname.startsWith('/event/'),
      )[0];
      if (!m || !time || !title || !url) return [];
      const month =
        [
          'січ',
          'лют',
          'бер',
          'кві',
          'тра',
          'чер',
          'лип',
          'сер',
          'вер',
          'жов',
          'лис',
          'гру',
        ].findIndex((x) => (m[2] ?? '').startsWith(x)) + 1;
      const eventYear = month < Number(current.slice(5, 7)) - 6 ? year + 1 : year;
      const key = `${eventYear}-${String(month).padStart(2, '0')}-${m[1]?.padStart(2, '0')}`;
      let startAt;
      try {
        startAt = new Date(leisureLocalInstant(key, time)).toISOString();
      } catch {
        return [];
      }
      const image = /data-lazy-src=["']([^"']+)["']/i.exec(block)?.[1];
      return [
        {
          title,
          category: 'show',
          startDate: key,
          endDate: key,
          startAt,
          source,
          sourceUrl: url,
          venue: 'Театр Лесі Українки',
          bookingUrl: publisherBooking(block, url),
          media: image ? [{ url: image, kind: 'poster', credit: source }] : [],
          schedule: { kind: 'once', precision: 'inferred' },
          qualityWarnings: [
            'Афіша не вказує рік вистави. Перед плануванням підтвердь дату у квитковому сервісі.',
          ],
          evidence: [
            {
              field: 'schedule',
              status: 'inferred',
              note: 'День і місяць з афіші; рік потребує підтвердження',
            },
          ],
        },
      ];
    });
}
/** @param {string} html @param {string} url @param {string} source */
export function parseSkansenWorkshop(html, url, source) {
  const main = eventBody(html).split(/Вам також може сподобатись|<footer\b/i)[0] ?? '';
  const title = decodeHtml(cleanText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1]));
  if (!title) return null;
  const desc = decodeHtml(
    cleanText(
      /class=["']service-description["'][^>]*>([\s\S]*?)<div[^>]*id=["']tabs-2-content/i.exec(
        main,
      )?.[1] ?? main,
      12000,
    ),
  );
  const prices = [
    ...desc.matchAll(/([^.!?]{0,90}?)\s*[–—:-]\s*(\d+)\s*грн(?:\.\s*\/\s*([^(),.]{1,25}))?/gi),
  ].map((m) => ({
    min: Number(m[2]),
    max: Number(m[2]),
    currency: 'UAH',
    eligibility: cleanText(m[1], 120),
    note: cleanText(m[0], 200),
  }));
  return {
    title: title + ' · Львівський скансен',
    category: 'meetup',
    summary: desc.slice(0, 650),
    venue: 'Львівський скансен',
    source,
    sourceUrl: url,
    siteUrl: 'https://lvivskansen.org/',
    bookingUrl: url,
    registration: true,
    schedule: { kind: 'on-request', precision: 'date', confirmationRequired: true },
    priceOffers: prices,
    priceBasis: 'unknown',
    priceNote: 'Вартість залежить від формату й групи. Вхід до музею може оплачуватися окремо.',
    qualityWarnings: ['Попередньо узгодь формат для двох, час, наявність місць і повну вартість.'],
    media: publisherMedia(html, url, source),
    evidence: [
      {
        field: 'schedule',
        status: 'unknown',
        note: 'Активність за записом; вільний час не підтверджений',
      },
    ],
  };
}

/** @param {any} source @param {number} nowMs @param {any} settings */
export async function collectVenueSource(source, nowMs, settings) {
  const html = await sourceText(source.url),
    offset = Number(settings.sourceOffset ?? 0),
    limit = Math.min(10, Number(settings.sourceBatch ?? 10));
  /** @type {any[]} */ let raw = [],
    chosen = [];
  let attempted = 0,
    pageFailures = 0;
  if (source.id === 'bookforum') {
    raw = structuredNodes(html)
      .map((n) => eventCandidate(n, source.name, source.url))
      .filter(Boolean);
    // An archived edition is never moved into the current year.
    chosen = raw
      .filter((i) => i.startDate?.slice(0, 10) >= kyivDateKey(new Date(nowMs)))
      .slice(offset, offset + limit);
  } else if (source.id === 'organ') raw = parseOrganEvents(html, source.name);
  else if (source.id === 'lesia') raw = parseLesiaListing(html, source.name, nowMs);
  else if (source.id === 'opera') {
    raw = parseOperaCalendar(html, source.name, nowMs);
    chosen = raw.slice(offset, offset + limit);
    attempted = chosen.length;
    for (const item of chosen)
      try {
        if (!new URL(item.sourceUrl).pathname.startsWith('/shows/')) continue;
        const leaf = await sourceText(item.sourceUrl);
        item.media = publisherMedia(leaf, item.sourceUrl, source.name);
        item.summary = metaContent(leaf, 'description') || item.summary;
        item.bookingUrl = publisherBooking(eventBody(leaf), item.sourceUrl);
      } catch {
        pageFailures++;
        /* Listing still has the published schedule. */
      }
  } else {
    const links = sourceLinks(html, source.url, (u) =>
      source.id === 'philharmonia'
        ? u.hostname === 'philharmonia.lviv.ua' && /^\/event\/[^/]+\/?$/.test(u.pathname)
        : u.hostname === 'lvivskansen.org' && /^\/majster-klasy\/[^/]+\/?$/.test(u.pathname),
    );
    attempted = links.slice(offset, offset + limit).length;
    for (const url of links.slice(offset, offset + limit))
      try {
        const leaf = await sourceText(url),
          candidate =
            source.id === 'philharmonia'
              ? parsePhilharmonia(leaf, url, source.name)
              : parseSkansenWorkshop(leaf, url, source.name);
        if (candidate) raw.push(candidate);
      } catch {
        pageFailures++;
        /* Other venue entries are independent. */
      }
    chosen = raw;
    // Pagination is based on attempted source entries, never the number successfully parsed.
    Object.assign(chosen, { nextOffset: links.length > offset + limit ? offset + limit : null });
  }
  if (['organ', 'lesia'].includes(source.id)) chosen = raw.slice(offset, offset + limit);
  if (['organ', 'lesia', 'bookforum'].includes(source.id)) attempted = chosen.length;
  const result = [];
  for (const candidate of chosen)
    try {
      const item = await normalizeLeisureItem(candidate, nowMs);
      if (item && (!item.endDate || item.endDate >= kyivDateKey(new Date(nowMs))))
        result.push(item);
    } catch {
      /* Reject malformed source facts. */
    }
  return Object.assign(result, {
    diagnostics: leisureSourceDiagnostics(attempted, chosen.length, result, nowMs, pageFailures),
    nextOffset:
      /** @type {any} */ (chosen).nextOffset ??
      (raw.length > offset + limit ? offset + limit : null),
  });
}

/** @param {any[]} items */
export function leisureSourceCoverage(items) {
  return {
    withMedia: items.filter((i) => i.media?.length).length,
    withPrice: items.filter((i) => i.price?.min != null).length,
    withTime: items.filter(
      (i) =>
        i.startAt ||
        i.sessions?.length ||
        i.schedule?.occurrences?.length ||
        i.schedule?.kind === 'recurring',
    ).length,
    needsCheck: items.filter(
      (i) =>
        i.qualityWarnings?.length ||
        ['inferred', 'conflicting'].includes(i.schedule?.precision) ||
        i.schedule?.kind === 'on-request',
    ).length,
  };
}

/** Counters describe this attempted batch, so pagination can safely sum them.
 * @param {number} attempted @param {number} parsed @param {any[]} items @param {number} nowMs @param {number} [pageFailures] */
export function leisureSourceDiagnostics(attempted, parsed, items, nowMs, pageFailures = 0) {
  const today = kyivDateKey(new Date(nowMs));
  const upcoming = items.filter(
    (i) =>
      (!i.endDate || i.endDate >= today) &&
      (!i.endAt || Date.parse(i.endAt) > nowMs || i.schedule?.kind === 'recurring'),
  ).length;
  return {
    attempted,
    parsed,
    accepted: items.length,
    upcoming,
    past: items.length - upcoming,
    invalid: Math.max(0, parsed - items.length),
    unparsed: Math.max(0, attempted - parsed - pageFailures),
    pageFailures,
  };
}
