import { placesSearch } from '../adapters/maps.mjs';
import { kyivDateKey, kyivHour } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { cleanText, httpLink, leisureWeek, normalizeLeisureItem } from './model.mjs';
import { leisureDb, leisureSettings, publishLeisureEdition } from './store.mjs';
import { parseNuxtData } from './nuxt-data.mjs';
import { queueLeisureDigest } from './notifications.mjs';
import {
  leisureDiscoveryQueries,
  leisureDiscoveryBounds,
  leisureDiscoveredCategory,
} from './discovery-queries.mjs';

import {
  SOURCE_HOSTS,
  decodeHtml,
  structuredNodes,
  sourceLinks,
  sourceText,
} from './source-html.mjs';
import {
  VENUE_LEISURE_SOURCES,
  collectVenueSource,
  parsePhilharmonia,
  parseOrganEvents,
  parseOperaCalendar,
  leisureSourceDiagnostics,
} from './venue-sources.mjs';
import { collectMultiplex } from './multiplex.mjs';
export { decodeHtml, structuredNodes, sourceLinks } from './source-html.mjs';
export const PUBLIC_LEISURE_SOURCES = [
  ...VENUE_LEISURE_SOURCES,
  {
    id: 'podcasts',
    name: 'Громадське радіо · Книжкова полиця',
    url: 'https://hromadske.radio/podcasts/knyzhkova-polytsia-z-tetianoiu-kurmanovoiu/feed',
  },
  {
    id: 'podcast-leaders',
    kind: 'podcast',
    name: 'Радіо Сковорода · Лідерський подкаст',
    url: 'https://anchor.fm/s/1015506c0/podcast/rss',
  },
  {
    id: 'podcast-art',
    kind: 'podcast',
    name: 'Радіо Сковорода · Нотатки з мистецтва',
    url: 'https://anchor.fm/s/c7eae5a8/podcast/rss',
  },
  {
    id: 'podcast-existence',
    kind: 'podcast',
    name: 'Куншт · Екзистенція',
    url: 'https://anchor.fm/s/ff03bc54/podcast/rss',
  },
  {
    id: 'podcast-truth',
    kind: 'podcast',
    name: 'Куншт · Пост правди',
    url: 'https://anchor.fm/s/107bbbfa4/podcast/rss',
  },
  { id: 'concert', name: 'Concert.ua', url: 'https://concert.ua/uk/catalog/lviv' },
  { id: 'lviv', name: 'Lviv.travel', url: 'https://lviv.travel/ua/events' },
  { id: 'jam', name: 'Jam Factory', url: 'https://jamfactory.ua/events/' },
  {
    id: 'art',
    name: 'Муніципальний мистецький центр',
    url: 'https://www.lvivart.center/wp-json/wp/v2/events?per_page=40&_embed=wp:featuredmedia',
  },
  { id: 'planeta', name: 'Планета кіно', url: 'https://planetakino.ua/' },
  {
    id: 'multiplex',
    name: 'Multiplex Victoria Gardens',
    url: 'https://multiplex.ua/cinema/lviv/victoriagardens',
  },
  {
    id: 'nearby',
    name: 'Lviv.travel · поблизу',
    url: 'https://lviv.travel/ua/around-lviv/place-attractions',
  },
];
export { eventCandidate, articleCandidate, sourceDateRange } from './publisher-parsers.mjs';
import { eventCandidate, parsePublisherEvent, publisherMedia } from './publisher-parsers.mjs';
/** Recheck only an already approved, selected public event page. Never infer cancellation from page chrome.
 * @param {any} item @param {number} nowMs */
export async function checkLeisureSource(item, nowMs) {
  if (item.category === 'food' || (item.category === 'cinema' && item.source === 'Планета кіно'))
    return { item, verified: false };
  const host = new URL(item.sourceUrl).hostname;
  const html = await sourceText(
    host === 'opera.lviv.ua' ? 'https://opera.lviv.ua/afisha/month/' : item.sourceUrl,
  );
  const article =
    host === 'opera.lviv.ua'
      ? parseOperaCalendar(html, item.source, nowMs).find((i) => i.sourceUrl === item.sourceUrl)
      : host === 'philharmonia.lviv.ua'
        ? parsePhilharmonia(html, item.sourceUrl, item.source)
        : host === 'www.lvivconcert.house'
          ? (parseOrganEvents(html, item.source).find((i) => i.sourceUrl === item.sourceUrl) ??
            parsePublisherEvent(html, item.sourceUrl, item.source, item.title))
          : parsePublisherEvent(html, item.sourceUrl, item.source, item.title);
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
      status: updated.status,
      checkedAt: new Date(nowMs).toISOString(),
    },
    verified:
      (!!updated.startAt ||
        !!updated.schedule?.occurrences?.length ||
        updated.schedule?.kind === 'recurring') &&
      !updated.qualityWarnings.length &&
      updated.schedule?.precision === 'exact',
  };
}
/** @param {any} source @param {number} nowMs @param {any} settings */
export async function collectSource(source, nowMs, settings) {
  if (source.id === 'podcasts' || source.kind === 'podcast')
    return settings.categories?.includes('podcast') ? collectPodcastFeed(source, nowMs) : [];
  if (source.id === 'planeta') return collectPlaneta(nowMs, settings);
  if (source.id === 'multiplex') return collectMultiplex(nowMs, settings);
  if (source.id === 'nearby' || source.id === 'attractions')
    return collectNearby(source, nowMs, settings);
  if (VENUE_LEISURE_SOURCES.some((s) => s.id === source.id))
    return collectVenueSource(source, nowMs, settings);
  const html = await sourceText(source.url);
  /** @type {any[]} */ let raw = [];
  let attempted;
  let pageFailures = 0;
  const offset = Number(settings.sourceOffset ?? 0),
    limit = Number(settings.sourceBatch ?? 48);
  /** @type {number|null} */ let nextOffset;
  if (source.id === 'art') {
    const data = JSON.parse(html);
    const entries = Array.isArray(data) ? data : [];
    attempted = entries.slice(offset, offset + limit).length;
    nextOffset = entries.length > offset + limit ? offset + limit : null;
    for (const entry of entries.slice(offset, offset + limit)) {
      const url = httpLink(entry.link);
      if (url && SOURCE_HOSTS.has(new URL(url).hostname)) {
        try {
          const leaf = await sourceText(url);
          const item = parsePublisherEvent(leaf, url, source.name);
          if (item) raw.push(item);
        } catch {
          pageFailures++;
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
    attempted = filteredCandidates.slice(offset, offset + limit).length;
    for (const candidate of filteredCandidates.slice(offset, offset + limit)) {
      if (new URL(candidate.sourceUrl).hostname !== 'concert.ua') continue;
      try {
        const leaf = await sourceText(candidate.sourceUrl);
        const exact =
          parsePublisherEvent(leaf, candidate.sourceUrl, source.name, candidate.title) ?? candidate;
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
        pageFailures++;
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
    attempted = links.slice(offset, offset + limit).length;
    for (const url of links.slice(offset, offset + limit)) {
      try {
        const leaf = await sourceText(url);
        const candidate = parsePublisherEvent(leaf, url, source.name);
        if (candidate) raw.push(candidate);
      } catch {
        pageFailures++;
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
  return Object.assign(result, {
    nextOffset,
    diagnostics: leisureSourceDiagnostics(attempted, raw.length, result, nowMs, pageFailures),
  });
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
          category: source.id === 'attractions' ? 'place' : 'trip',
          venue: title,
          address: addressLink ? decodeHtml(cleanText(addressLink, 250)) : null,
          summary: meta
            ? decodeHtml(meta)
            : 'Місце для поїздки зі Львова. Перед виїздом перевір доступність і години роботи у джерелі.',
          source: source.name,
          sourceUrl: url,
          priceNote: 'Вхід, пальне та інші витрати уточнюються окремо.',
          media: publisherMedia(leaf, url, source.name),
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
  const channel = xml.split(/<item\b/i)[0] ?? '';
  const field = (/** @type {string} */ body, /** @type {string} */ name) =>
    decodeHtml(
      (
        new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(body)?.[1] ??
        ''
      ).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'),
    ).trim();
  const series = field(channel, 'title'),
    publisher = field(channel, 'itunes:author');
  const language = field(channel, 'language');
  const cover = /<itunes:image\b[^>]*href=["']([^"']+)/i.exec(channel)?.[1];
  const linkHosts = new Set([
    'hromadske.radio',
    'anchor.fm',
    'podcasters.spotify.com',
    'open.spotify.com',
    'radioskovoroda.com',
    'skovoroda.com',
    'kunsht.com.ua',
  ]);
  for (const match of [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 10)) {
    const body = match[1] ?? '',
      link = httpLink(field(body, 'link'));
    if (!link || !linkHosts.has(new URL(link).hostname)) continue;
    const published = Date.parse(field(body, 'pubDate'));
    if (
      !Number.isFinite(published) ||
      published > nowMs + 3600000 ||
      nowMs - published > 180 * 86400000
    )
      continue;
    const duration = field(body, 'itunes:duration'),
      parts = duration.split(':').map(Number);
    const seconds =
      parts.length === 3
        ? (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
        : parts.length === 2
          ? (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
          : Number(duration);
    const image = /<itunes:image\b[^>]*href=["']([^"']+)/i.exec(body)?.[1] ?? cover;
    const explicit = field(body, 'itunes:explicit') || field(channel, 'itunes:explicit');
    const normalized = await normalizeLeisureItem(
      {
        title: field(body, 'title'),
        category: 'podcast',
        guid: field(body, 'guid') || link,
        identity: field(body, 'guid') || link,
        source: source.name,
        sourceUrl: link,
        summary: cleanText(field(body, 'description'), 650),
        durationMinutes: seconds > 0 ? Math.ceil(seconds / 60) : null,
        publishedAt: new Date(published).toISOString(),
        priceNote: 'Умови прослуховування — на платформі видавця.',
        podcast: {
          series,
          publisher,
          language,
          explicit: /^(true|yes|explicit)$/i.test(explicit)
            ? true
            : /^(false|no|clean)$/i.test(explicit)
              ? false
              : null,
        },
        media: image
          ? [{ url: decodeHtml(image), kind: 'cover', credit: publisher || source.name }]
          : [],
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
    end = addDaysToDateKey(today, 13);
  /** @type {Map<string,any>} */ const movies = new Map();
  let verifiedPages = 0;
  for (const selected of settings.cinemas.filter((/** @type {string} */ c) =>
    ['forum-lviv', 'king-cross'].includes(c),
  )) {
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
          media: [...(movie.posters?.vertical ?? []), ...(movie.posters?.horizontal ?? [])]
            .slice(0, 4)
            .map((/** @type {any} */ p) => ({
              url: p.url,
              kind: 'poster',
              credit: 'Планета кіно',
            })),
          film: {
            originalTitle: movie.originalName,
            year: Number(movie.year),
            imdbRating: movie.rating?.imdb?.rating,
            imdbVotes: movie.rating?.imdb?.voteCount,
            imdbId: /tt\d{5,12}/.exec(movie.imdbUrl ?? '')?.[0],
          },
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
  if (
    !verifiedPages &&
    settings.cinemas.some((/** @type {string} */ c) => ['forum-lviv', 'king-cross'].includes(c))
  )
    throw new Error('planeta-schedule-unavailable');
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
          placesSearch(
            env,
            {
              query: entry.query,
              city: settings.city,
              limit: 20,
              scope: 'leisure',
              bounds: leisureDiscoveryBounds(settings.city),
            },
            nowMs,
          ),
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
            category: leisureDiscoveredCategory(place, place.leisureCategory),
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
  if (edition && edition.catalogVersion !== 5)
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
