import { cleanText, httpLink } from './model.mjs';
import { decodeHtml, eventBody, metaContent, structuredNodes } from './source-html.mjs';
import { leisureMediaUrl } from './content-facts.mjs';
import { leisureLocalInstant } from './schedule.mjs';
import { classifyLeisureEvent } from './taxonomy.mjs';

const MONTHS = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
/** @param {string} title */
export function eventCategory(title) {
  const category = classifyLeisureEvent({ title }).category;
  if (category !== 'event') return category;
  return /спецпоказ|кінопоказ|кіноперегляд|перегляд.*фільм|показ.*(?:фільм|стрічк)|^кіно(?:\s|:|$)/i.test(
    title,
  )
    ? 'cinema'
    : category;
}
/** @param {string} text */
export function sourceDateRange(text) {
  const calendar = /dates=(\d{4})(\d{2})(\d{2})T\d+\/(\d{4})(\d{2})(\d{2})T\d+/.exec(
    decodeHtml(text),
  );
  if (calendar)
    return {
      startDate: `${calendar[1]}-${calendar[2]}-${calendar[3]}`,
      endDate: `${calendar[4]}-${calendar[5]}-${calendar[6]}`,
    };
  const plain = decodeHtml(cleanText(text, 15000));
  const short =
    /(\d{2})[/.](\d{2})[/.](\d{4}|\d{2})(?:\s*[―–-]\s*(\d{2})[/.](\d{2})[/.](\d{4}|\d{2}))?/.exec(
      plain,
    );
  if (short) {
    const year = (/** @type {string} */ y) => (y.length === 2 ? '20' + y : y);
    const startDate = `${year(short[3] ?? '')}-${short[2]}-${short[1]}`;
    return {
      startDate,
      endDate: short[4] ? `${year(short[6] ?? '')}-${short[5]}-${short[4]}` : startDate,
    };
  }
  const m =
    /(\d{1,2})(?:\s*[–—-]\s*(\d{1,2}))?\s+(січ\S*|лют\S*|бер\S*|кві\S*|тра\S*|чер\S*|лип\S*|сер\S*|вер\S*|жов\S*|лис\S*|гру\S*)\s+(20\d{2})/i.exec(
      plain,
    );
  if (!m) return null;
  const month = MONTHS.findIndex((x) => (m[3] ?? '').toLowerCase().startsWith(x)) + 1;
  const key = (/** @type {string} */ d) =>
    `${m[4]}-${String(month).padStart(2, '0')}-${d.padStart(2, '0')}`;
  return { startDate: key(m[1] ?? ''), endDate: key(m[2] ?? m[1] ?? '') };
}
/** @param {string} html @param {string} url @param {string} source */
export function publisherMedia(html, url, source) {
  const image = leisureMediaUrl(metaContent(html, 'og:image'), url);
  return image ? [{ url: image, kind: 'poster', credit: source }] : [];
}
/** @param {string} html @param {string} base */
export function publisherBooking(html, base) {
  const allowed = new Set([
    'concert.ua',
    'secure.wayforpay.com',
    'docs.google.com',
    'widget.kontramarka.ua',
    'lviv.kontramarka.ua',
    'tickets.karabas.com',
    'karabas.com',
    'gastroli.ua',
    'philharmonia.lviv.ua',
    'www.lvivconcert.house',
  ]);
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(decodeHtml(m[1] ?? ''), base);
      if (
        allowed.has(u.hostname) &&
        /квит|ticket|реєстрац|купити|забронювати/i.test(cleanText(m[2]) + ' ' + u.pathname) &&
        httpLink(u.href)
      ) {
        u.hash = '';
        return u.href;
      }
    } catch {
      /* Invalid reference. */
    }
  }
  return null;
}
/** @param {any} event @param {string} source @param {string} url */
export function eventCandidate(event, source, url) {
  if (!/Event/.test(String(event['@type'] ?? ''))) return null;
  const title = decodeHtml(cleanText(event.name, 180));
  if (!title || /афіша|події цього тижня|розклад подій/i.test(title)) return null;
  const location = Array.isArray(event.location) ? event.location[0] : event.location;
  const offers = (Array.isArray(event.offers) ? event.offers : [event.offers]).filter(Boolean);
  const prices = offers
    .map((/** @type {any} */ o) => ({
      min: Number(o.lowPrice ?? o.price),
      max: o.highPrice != null ? Number(o.highPrice) : o.price != null ? Number(o.price) : null,
      currency: o.priceCurrency || 'UAH',
      eligibility: o.name || 'Стандартний квиток',
      note: 'Сервісні збори можуть оплачуватися окремо.',
    }))
    .filter((/** @type {any} */ p) => Number.isFinite(p.min) && p.min >= 0);
  const standard = prices.find(
    (/** @type {any} */ p) => !/пільг|студент|дитяч|пенсі|ветеран/i.test(p.eligibility),
  );
  const status = /Cancel/i.test(event.eventStatus ?? '')
    ? 'cancelled'
    : /Postpone/i.test(event.eventStatus ?? '')
      ? 'postponed'
      : offers.length &&
          offers.every((/** @type {any} */ o) => /SoldOut|OutOfStock/i.test(o.availability ?? ''))
        ? 'sold-out'
        : 'available';
  const address =
    typeof location?.address === 'string'
      ? location.address
      : [location?.address?.addressLocality, location?.address?.streetAddress]
          .filter(Boolean)
          .join(', ');
  const images = (Array.isArray(event.image) ? event.image : [event.image])
    .map((/** @type {any} */ i) => leisureMediaUrl(typeof i === 'string' ? i : i?.url, url))
    .filter(Boolean);
  const exact = /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.startDate ?? '');
  return {
    title,
    summary: decodeHtml(cleanText(event.description, 650)),
    structuredType: String(event['@type'] ?? ''),
    category: /TheaterEvent|DanceEvent/.test(String(event['@type']))
      ? 'show'
      : eventCategory(title),
    venue: location?.name,
    address,
    startDate: event.startDate,
    endDate: event.endDate || event.startDate,
    startAt: event.startDate,
    endAt: event.endDate,
    priceMin: standard?.min ?? null,
    priceMax: standard?.max ?? null,
    priceCurrency: standard?.currency,
    free:
      standard?.min === 0 &&
      (event.isAccessibleForFree === true ||
        /безкоштов|безплат|вхід вільний|free/i.test(standard.eligibility)),
    priceBasis: 'person',
    priceNote: standard?.note || '',
    priceOffers: prices,
    source,
    sourceUrl: httpLink(event.url) ?? url,
    status,
    bookingUrl: httpLink(offers[0]?.url),
    lat: Number(location?.geo?.latitude) || null,
    lon: Number(location?.geo?.longitude) || null,
    media: images.map((/** @type {any} */ image) => ({
      url: image,
      kind: 'poster',
      credit: source,
    })),
    schedule: { kind: 'once', precision: exact ? 'exact' : 'date' },
    evidence: [
      { field: 'schedule', status: 'published', note: 'Структурований розклад видавця' },
      ...(prices.length
        ? [{ field: 'price', status: 'published', note: 'Опубліковані квитки' }]
        : []),
    ],
  };
}
/** Parse the provider's own event header before reading descriptive prose.
 * @param {string} html @param {string} url @param {string} source */
export function articleCandidate(html, url, source) {
  const main = eventBody(html),
    body = decodeHtml(cleanText(main, 20000));
  const title = decodeHtml(cleanText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1], 180));
  if (!title || /афіша|події цього тижня|розклад подій/i.test(title)) return null;
  const host = new URL(url).hostname;
  const header =
    host === 'jamfactory.ua'
      ? decodeHtml(
          cleanText(
            /<span\b[^>]*class=["'][^"']*icon-calendar[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(
              main,
            )?.[1],
          ),
        )
      : host === 'www.lvivart.center'
        ? decodeHtml(cleanText(main.slice(0, main.indexOf('</header>') + 9 || 1500)))
        : body.slice(0, 500);
  let range = sourceDateRange(header),
    inferred = false;
  const shortHeader =
    /(\d{1,2})\s+(січ\S*|лют\S*|бер\S*|кві\S*|тра\S*|чер\S*|лип\S*|сер\S*|вер\S*|жов\S*|лис\S*|гру\S*)/i.exec(
      header,
    );
  if (!range && host === 'jamfactory.ua' && shortHeader) {
    const d = shortHeader[1],
      month = shortHeader[2];
    const sameDay = new RegExp('\\b' + d + '\\s+' + month + '\\s+(20\\d{2})', 'i').exec(body);
    const published =
      metaContent(html, 'article:published_time') ||
      String(
        structuredNodes(html).find(
          (n) => /WebPage|Article/.test(String(n['@type'] ?? '')) && n.datePublished,
        )?.datePublished ?? '',
      );
    const year = sameDay?.[1] ?? /^20\d{2}-/.exec(published)?.[0]?.slice(0, 4);
    if (year) {
      range = sourceDateRange(d + ' ' + month + ' ' + year);
      inferred = !sameDay;
    }
  }
  if (!range && host === 'jamfactory.ua' && shortHeader) return null;
  if (!range) range = sourceDateRange(main);
  if (!range) return null;
  const rawClock = /\b([012]?\d:[0-5]\d)\b/.exec(header)?.[1];
  const clock = rawClock?.padStart(5, '0');
  let startAt = null;
  if (clock)
    try {
      startAt = new Date(leisureLocalInstant(range.startDate, clock)).toISOString();
    } catch {
      /* Invalid wall time. */
    }
  const about =
    /<(?:div|section)\b[^>]*(?:id=["']about["']|class=["'][^"']*(?:entry-content|event-description|service-description)[^"']*["'])[^>]*>([\s\S]*)/i.exec(
      main,
    )?.[1] ?? main;
  const description = decodeHtml(cleanText(about, 20000));
  const paragraphs = [...about.matchAll(/<(?:p|li)\b[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)].map((m) =>
    decodeHtml(cleanText(m[1], 700)),
  );
  const priceOffers = paragraphs.flatMap((p) =>
    [
      ...p.matchAll(
        /((?:(?:Повний|Стандартний|Пільговий|Студентський|Дитячий)\s+)?(?:квиток)|Стандартний|Вартість(?: квитка)?|Ціна(?: квитка)?|Вхід|Гончарство|Ліпка)\s*[—–:-]?\s*(\d+(?:[.,]\d+)?)(?:\s*[–—-]\s*(\d+(?:[.,]\d+)?))?\s*(?:грн|₴)/gi,
      ),
    ].map((m) => ({
      min: Number(m[2]?.replace(',', '.')),
      max: Number((m[3] ?? m[2])?.replace(',', '.')),
      currency: 'UAH',
      eligibility: m[1] ?? '',
      note: p,
    })),
  );
  const standard = priceOffers.find(
    (p) => !/пільг|студент|дитин|пенсі|ветеран|впо|школяр/i.test(p.eligibility),
  );
  const explicitFree =
    /Вхід (?:на (?:подію|виставку) )?(?:безкоштовний|вільний)(?: за умови|[.!]|$)/i.test(
      description,
    ) && !/Вхід (?:безкоштовний|вільний) (?:для|лише)/i.test(description);
  const duration = /(?:Тривалість|триває)\s*[—–:-]?\s*(\d{1,3})\s*(хв|год)/i.exec(description);
  const bookingSection =
    host === 'jamfactory.ua'
      ? (/<div class=["']locationBox["'][^>]*>([\s\S]*?)<\/div>/i.exec(main)?.[1] ?? '')
      : main;
  const bookingUrl = publisherBooking(bookingSection, url) ?? publisherBooking(about, url);
  const address =
    host === 'jamfactory.ua'
      ? decodeHtml(
          cleanText(
            /<span\b[^>]*class=["']icon-location["'][^>]*>([\s\S]*?)<\/span>/i.exec(main)?.[1],
            250,
          ),
        ) || null
      : (/Львів,\s*(?:вул\.?|вулиця|площа|пл\.)[^.;]{3,100}/i.exec(description)?.[0] ?? null);
  return {
    title,
    category: eventCategory(title),
    summary:
      paragraphs
        .filter((p) => p.length > 55 && !/Квитки|Реєстрація|За підтримки/i.test(p))
        .slice(0, 2)
        .join(' ')
        .slice(0, 650) || 'Програма й умови — на сторінці організатора.',
    ...range,
    startAt,
    sourceUrl: url,
    source,
    address,
    bookingUrl,
    priceMin: explicitFree ? 0 : (standard?.min ?? null),
    priceMax: explicitFree ? 0 : (standard?.max ?? null),
    free: explicitFree,
    priceBasis: 'person',
    priceOffers,
    studentNote:
      /(?:Для студентів|Студентам|студент[іа][^.]{0,50})[^.]{0,120}/i.exec(description)?.[0] ?? '',
    registration:
      /реєстрац/i.test(cleanText(bookingSection)) ||
      /(?:подія|відвідування|участь)[^.]{0,35}(?:попередн[яьої]+\s+реєстрац|за реєстрацією)/i.test(
        description,
      ),
    durationMinutes: duration
      ? Number(duration[1]) * (/год/i.test(duration[2] ?? '') ? 60 : 1)
      : null,
    media: publisherMedia(html, url, source),
    schedule: { kind: 'once', precision: inferred ? 'inferred' : startAt ? 'exact' : 'date' },
    evidence: [
      {
        field: 'schedule',
        status: inferred ? 'inferred' : 'published',
        note: inferred
          ? 'Рік виведено з публікації; уточни в організатора.'
          : 'Дата з основного блоку події',
      },
    ],
    qualityWarnings: inferred ? ['Рік події потребує підтвердження організатора'] : [],
  };
}

/** Match the selected page instead of taking an unrelated recommendation from its JSON-LD.
 * @param {string} html @param {string} url @param {string} source @param {string} [title] */
export function parsePublisherEvent(html, url, source, title = '') {
  const normalizeUrl = (/** @type {string} */ u) => u.split(/[?#]/)[0]?.replace(/\/$/, '');
  const nodes = structuredNodes(html)
    .map((n) => eventCandidate(n, source, url))
    .filter(
      (n) => n && (!title || n.title.toLocaleLowerCase('uk') === title.toLocaleLowerCase('uk')),
    );
  const selected = nodes.find((n) => normalizeUrl(n?.sourceUrl ?? '') === normalizeUrl(url));
  const article = articleCandidate(html, url, source);
  if (!selected)
    return article &&
      (!title || article.title.toLocaleLowerCase('uk') === title.toLocaleLowerCase('uk'))
      ? article
      : null;
  const result = /** @type {any} */ ({
    ...selected,
    media: selected.media.length ? selected.media : publisherMedia(html, url, source),
    bookingUrl: selected.bookingUrl ?? publisherBooking(eventBody(html), url),
  });
  if (
    article &&
    !result.startAt?.includes('T') &&
    article.startAt &&
    article.startDate === result.startDate?.slice(0, 10)
  ) {
    result.startAt = article.startAt;
    result.schedule = article.schedule;
  }
  if (result.priceMin == null && article?.priceMin != null) {
    result.priceMin = article.priceMin;
    result.priceMax = article.priceMax;
    result.free = article.free;
    result.priceOffers = article.priceOffers;
  }
  const main = eventBody(html),
    text = decodeHtml(cleanText(main, 16000));
  if (new URL(url).hostname === 'lviv.travel') {
    const timeMeta =
      /c-icon--time["'][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(main)?.[1] ?? '';
    const timeText = decodeHtml(cleanText(timeMeta));
    const week = /щонеділ|щопонеділ|щовівтор|щосеред|щочетвер|щоп.ятниц|щосубот/i.exec(timeText);
    if (week) {
      const weekday = /щонеділ/i.test(week[0])
        ? 0
        : /щопонеділ/i.test(week[0])
          ? 1
          : /щовівтор/i.test(week[0])
            ? 2
            : /щосеред/i.test(week[0])
              ? 3
              : /щочетвер/i.test(week[0])
                ? 4
                : /щоп.ятниц/i.test(week[0])
                  ? 5
                  : 6;
      const clocks = [...timeText.matchAll(/\b([012]?\d:[0-5]\d)\b/g)].map((m) =>
        m[1]?.padStart(5, '0'),
      );
      result.schedule = {
        kind: 'recurring',
        timeMode: 'window',
        precision: clocks[0] ? 'exact' : 'date',
        weekdays: [weekday],
        startTime: clocks[0],
        endTime: clocks[1],
        validFrom: result.startDate?.slice(0, 10),
        validThrough: result.endDate?.slice(0, 10),
      };
      result.startAt = null;
      result.endAt = null;
    } else if (result.startDate?.slice(0, 10) === result.endDate?.slice(0, 10)) {
      const time = /\b([012]?\d:[0-5]\d)\b/.exec(timeText)?.[1]?.padStart(5, '0');
      if (time)
        try {
          const visibleAt = new Date(
            leisureLocalInstant(result.startDate.slice(0, 10), time),
          ).toISOString();
          if (
            result.startAt?.includes('T') &&
            Date.parse(result.startAt) !== Date.parse(visibleAt)
          ) {
            result.qualityWarnings = [
              'Час у заголовку та структурованому розкладі відрізняється. Потрібне підтвердження організатора.',
            ];
            result.schedule.precision = 'conflicting';
          } else {
            result.startAt = visibleAt;
            result.schedule.precision = 'exact';
          }
        } catch {
          /* Invalid source time. */
        }
    }
    const visible = sourceDateRange(text.slice(0, 6500));
    if (
      visible &&
      (visible.startDate !== result.startDate?.slice(0, 10) ||
        visible.endDate !== result.endDate?.slice(0, 10))
    ) {
      result.schedule = { ...result.schedule, precision: 'conflicting' };
      result.qualityWarnings = [
        'Дати в описі та структурованому розкладі джерела відрізняються. Потрібне підтвердження організатора.',
      ];
      result.evidence = [
        { field: 'schedule', status: 'conflicting', note: result.qualityWarnings[0] },
      ];
    }
  }
  if (/SOLD\s*OUT|Усі квитки продано|Квитки розпродано/i.test(text)) result.status = 'sold-out';
  return result;
}
