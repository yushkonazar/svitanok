import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  articleCandidate,
  eventCandidate,
  parsePublisherEvent,
} from '../web/core/leisure/publisher-parsers.mjs';
import {
  parseOrganEvents,
  parseOperaCalendar,
  parsePhilharmonia,
  parseSkansenWorkshop,
  parseLesiaListing,
  collectVenueSource,
  leisureSourceCoverage,
} from '../web/core/leisure/venue-sources.mjs';
import {
  parseMultiplexSchedule,
  multiplexFilmDetails,
  collectMultiplex,
} from '../web/core/leisure/multiplex.mjs';
import { normalizeLeisureItem } from '../web/core/leisure/model.mjs';
import {
  leisureAvailableOn,
  leisureOccurrencesOn,
  leisureSlotMatches,
  normalizeLeisureSchedule,
  leisureLocalInstant,
} from '../web/core/leisure/schedule.mjs';
import {
  leisureCostRange,
  leisureMediaUrl,
  leisureFilmKey,
} from '../web/core/leisure/content-facts.mjs';
import { sourceText, boundedBytes } from '../web/core/leisure/source-html.mjs';
import {
  leisureDiscoveredCategory,
  leisureDiscoveryBounds,
} from '../web/core/leisure/discovery-queries.mjs';
import { collectPodcastFeed } from '../web/core/leisure/catalog.mjs';
const now = Date.parse('2026-10-19T08:00Z');
const ld = (v: unknown) => '<script type="application/ld+json">' + JSON.stringify(v) + '</script>';
afterEach(() => vi.unstubAllGlobals());

describe('publisher event facts', () => {
  it('reads the single Art header date/time and its actual poster, never the publication date', async () => {
    const html =
      '<meta property="og:image" content="https://www.lvivart.center/wp-content/uploads/2026/poster.jpg"><h1>Презентація фотокниги</h1><div>19/10/26<br>18:30</div></header><div class="entry-content"><p>Розмова про фотографію та досвід.</p><p>Історія почалася 20 липня 2025 року.</p></div>';
    const raw = articleCandidate(
      html,
      'https://www.lvivart.center/events/book/',
      'Мистецький центр',
    );
    expect(raw).toMatchObject({
      startDate: '2026-10-19',
      endDate: '2026-10-19',
      startAt: '2026-10-19T15:30:00.000Z',
      category: 'meetup',
    });
    const item = await normalizeLeisureItem(raw, now);
    expect(item?.media[0]?.credit).toBe('Мистецький центр');
    expect(item?.schedule?.precision).toBe('exact');
  });
  it('keeps a film plot date and related cards out of a Jam screening schedule', () => {
    const html =
      ld({ '@type': 'WebPage', datePublished: '2026-10-16T12:00:00Z' }) +
      '<h1>Спецпоказ фільму</h1><span class="icon-calendar">28 жовтня | 18:30</span><div class="locationBox"><a href="https://docs.google.com/forms/d/e/test/viewform">Реєстрація</a></div><div id="about"><p>У ніч із 27 на 28 липня 2025 року знімали фільм.</p><p>Тривалість: 70 хв.</p></div><h2>Схожі події</h2><p>8 жовтня 2026 року</p>';
    const parsed = articleCandidate(html, 'https://jamfactory.ua/events/screening/', 'Jam Factory');
    expect(parsed).toMatchObject({
      startDate: '2026-10-28',
      startAt: '2026-10-28T16:30:00.000Z',
      durationMinutes: 70,
      registration: true,
      schedule: { precision: 'inferred' },
    });
    expect(parsed?.qualityWarnings).toHaveLength(1);
    expect(
      articleCandidate(
        html.replace(/datePublished[^}]+/, 'noDate":""'),
        'https://jamfactory.ua/events/screening/',
        'Jam',
      ),
    ).toBeNull();
  });
  it('uses the standard Jam ticket and keeps the concession with its eligibility', () => {
    const html =
      '<h1>Перформанс</h1><span class="icon-calendar">23 жовтня 19:00</span><div class="locationBox"><a href="https://secure.wayforpay.com/payment/show">Квитки</a></div><div id="about"><p>23 жовтня 2026 року.</p><p>Повний квиток – 300 грн<br>Пільговий квиток – 150 грн (для студентів).</p><p>Майстер-клас наступного дня за попередньою реєстрацією.</p></div>';
    expect(articleCandidate(html, 'https://jamfactory.ua/events/show/', 'Jam')).toMatchObject({
      priceMin: 300,
      priceMax: 300,
      registration: false,
      priceOffers: [
        { min: 300, eligibility: 'Повний квиток' },
        { min: 150, eligibility: 'Пільговий квиток' },
      ],
    });
  });
  it('selects the matching event node, preserving a non-UAH price range', async () => {
    const url = 'https://concert.ua/uk/event/correct';
    const html = ld([
      {
        '@type': 'Event',
        url: 'https://concert.ua/uk/event/other',
        name: 'Інша подія',
        startDate: '2026-11-01',
      },
      {
        '@type': 'MusicEvent',
        url,
        name: 'Мій концерт',
        startDate: '2026-10-22T19:00:00+03:00',
        endDate: '2026-10-22T21:00:00+03:00',
        offers: {
          '@type': 'AggregateOffer',
          lowPrice: '20',
          highPrice: '40',
          priceCurrency: 'EUR',
        },
      },
    ]);
    const raw = parsePublisherEvent(html, url, 'Concert.ua');
    expect(raw?.title).toBe('Мій концерт');
    const item = await normalizeLeisureItem(raw, now);
    expect(item?.price).toMatchObject({ min: 20, max: 40, currency: 'EUR' });
    expect(leisureCostRange(item).unknown).toBe(true);
    expect(eventCandidate({ '@type': 'WebPage' }, 'x', url)).toBeNull();
  });
  it('flags internally conflicting Lviv dates instead of making a ready plan', async () => {
    const url = 'https://lviv.travel/ua/events/concert';
    const html =
      ld({
        '@type': 'Event',
        url,
        name: 'Один в Каное',
        startDate: '2025-10-20',
        endDate: '2026-10-21',
      }) + '<h1>Один в Каное</h1><p>20–21 жовтня 2026 року о 19:00.</p>';
    const item = await normalizeLeisureItem(parsePublisherEvent(html, url, 'Lviv.travel'), now);
    expect(item?.schedule?.precision).toBe('conflicting');
    expect(item?.evidence[0]?.status).toBe('conflicting');
    expect(leisureAvailableOn(item, '2026-10-20')).toBe(false);
  });
  it('expands a Sunday market only on Sundays and within the published season', async () => {
    const url = 'https://lviv.travel/ua/events/fair';
    const html =
      ld({
        '@type': 'Event',
        url,
        name: 'Ветеранський ярмарок',
        startDate: '2026-03-29',
        endDate: '2026-10-31',
      }) + '<h1>Ветеранський ярмарок</h1><i class="c-icon--time"></i><p>щонеділі 10:00 - 18:00</p>';
    const item = await normalizeLeisureItem(parsePublisherEvent(html, url, 'Lviv.travel'), now);
    expect(leisureAvailableOn(item, '2026-10-22')).toBe(false);
    expect(leisureAvailableOn(item, '2026-10-25')).toBe(true);
    expect(leisureAvailableOn(item, '2026-11-01')).toBe(false);
    const a = leisureLocalInstant('2026-10-25', '12:00'),
      b = leisureLocalInstant('2026-10-25', '14:00');
    expect(leisureSlotMatches(item, a, b)).toBe(true);
    expect(leisureSlotMatches(item, a, leisureLocalInstant('2026-10-25', '19:00'))).toBe(false);
    expect(leisureOccurrencesOn(item, '2026-10-25')[0]?.startAt).toBe(
      leisureLocalInstant('2026-10-25', '10:00'),
    );
  });
});

describe('additional official providers', () => {
  it('joins public Opera show links and groups exact occurrences without following broken Event links', async () => {
    const event = {
      '@type': 'Event',
      name: 'Наталка Полтавка',
      url: 'https://opera.lviv.ua/event/broken/',
      startDate: '2026-10-22T19:00:00+03:00',
      endDate: '2026-10-22T21:00:00+03:00',
    };
    const html =
      ld([
        event,
        event,
        {
          ...event,
          url: 'https://opera.lviv.ua/event/broken-next/',
          startDate: '2026-10-24T19:00:00+03:00',
          endDate: '2026-10-24T21:00:00+03:00',
        },
      ]) +
      ['2026-10-22', '2026-10-24']
        .map(
          (d) =>
            '<article><time datetime="' +
            d +
            '"></time><a href="https://opera.lviv.ua/shows/natalka/">НАТАЛКА ПОЛТАВКА</a><div class="show-details-item"><span>Велика сцена</span></div></article>',
        )
        .join('');
    const shows = parseOperaCalendar(html, 'Опера', now);
    expect(shows).toHaveLength(1);
    expect(shows[0].sourceUrl).toBe('https://opera.lviv.ua/shows/natalka/');
    expect(shows[0].schedule.occurrences).toHaveLength(2);
    const item = await normalizeLeisureItem(shows[0], now);
    expect(leisureAvailableOn(item, '2026-10-23')).toBe(false);
    expect(leisureOccurrencesOn(item, '2026-10-24')).toHaveLength(1);
  });
  it('reads Philharmonia chamber details, a range, a poster, and ticket URL', () => {
    const html =
      '<h1>Музичний вечір</h1><div class="event-date">22.10.2026 / 18:00</div><p style="background-image:url(location-icon.svg);">Камерна сцена</p><p style="background-image:url(price-icon.svg);">220–600</p><div class="event-photo"><img src="https://philharmonia.lviv.ua/poster.webp"></div><a href="https://widget.kontramarka.ua/event/1">Купити квиток</a>';
    expect(
      parsePhilharmonia(html, 'https://philharmonia.lviv.ua/event/music/', 'Філармонія'),
    ).toMatchObject({
      startAt: '2026-10-22T15:00:00.000Z',
      priceMin: 220,
      priceMax: 600,
      venue: 'Камерна сцена',
      address: null,
      media: [{ url: 'https://philharmonia.lviv.ua/poster.webp' }],
    });
    expect(
      parsePhilharmonia(
        html.replace('220–600', 'Вхід вільний'),
        'https://philharmonia.lviv.ua/event/music/',
        'Філармонія',
      )?.free,
    ).toBe(true);
  });
  it('reads public Wix SSR schedules without interpreting an unused soldOut widget as the real ticket status', () => {
    const e = {
      id: 'event1',
      slug: 'organ-night',
      title: 'Органний концерт',
      scheduling: {
        config: { startDate: '2026-10-22T16:00:00Z', endDate: '2026-10-22T17:00:00Z' },
      },
      registration: { ticketing: { soldOut: true } },
      mainImage: { url: 'https://static.wixstatic.com/media/poster.jpg' },
      location: {
        name: 'Органний зал',
        address: 'Степана Бандери, 8',
        coordinates: { lat: 49.8, lng: 24 },
      },
    };
    const html =
      '<script type="application/json" id="wix-warmup-data">' +
      JSON.stringify({ nested: [e, { ...e, id: 'repeat' }] }) +
      '</script>';
    const items = parseOrganEvents(html, 'Органний зал');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      status: 'available',
      schedule: { precision: 'exact' },
      startAt: '2026-10-22T16:00:00Z',
      lat: 49.8,
    });
    expect(parseOrganEvents('<script id="wix-warmup-data">broken</script>', 'Орган')).toEqual([]);
  });
  it('keeps workshops as request-based activities rather than confirmed couple availability', async () => {
    const raw = parseSkansenWorkshop(
      '<h1>Гончарство</h1><div class="service-description"><p>Для груп дітей. За попереднім бронюванням. Ліпка — 300 грн./дитина.</p><p>Індивідуальний майстер-клас для 1–2 осіб — 1500 грн.</p></div>',
      'https://lvivskansen.org/majster-klasy/goncharstvo/',
      'Скансен',
    );
    const i = await normalizeLeisureItem(raw, now);
    expect(i?.schedule?.kind).toBe('on-request');
    expect(i?.price.min).toBeNull();
    expect(leisureAvailableOn(i, '2026-10-22')).toBe(false);
  });
  it('labels inferred years in Lesia listings', () => {
    const html =
      '<div class="single-performance single-afisha col"><a href="https://teatrlesi.lviv.ua/event/show/" class="single-performance__date"><span>24 жовтня</span><b>18:00</b></a><img data-lazy-src="https://teatrlesi.lviv.ua/poster.jpg"><div class="single-performance__title"><b>Вистава</b></div></div>';
    expect(parseLesiaListing(html, 'Театр Лесі', now)[0]).toMatchObject({
      startDate: '2026-10-24',
      schedule: { precision: 'inferred' },
    });
  });
  it('collects venue leaves in batches and does not redate an archived seasonal festival', async () => {
    const fetch = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(
            url.includes('/events/')
              ? '<a href="https://philharmonia.lviv.ua/event/one/">А</a><a href="https://philharmonia.lviv.ua/event/two/">Б</a>'
              : '<h1>Концерт</h1><div>22.10.2026 / 18:00</div>',
          ),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const result = await collectVenueSource(
      { id: 'philharmonia', name: 'Філармонія', url: 'https://philharmonia.lviv.ua/events/' },
      now,
      { sourceBatch: 1 },
    );
    expect(result).toHaveLength(1);
    expect(result.nextOffset).toBe(1);
    fetch.mockResolvedValue(
      new Response(
        ld({
          '@type': 'Event',
          name: 'BookForum 2026',
          url: 'https://bookforum.ua/',
          startDate: '2026-09-10',
          endDate: '2026-09-13',
        }),
      ),
    );
    expect(
      await collectVenueSource(
        { id: 'bookforum', name: 'BookForum', url: 'https://bookforum.ua/' },
        now,
        {},
      ),
    ).toHaveLength(0);
  });
  it('parses Multiplex date anchors, separates accessibility tags, and treats zero price as unknown', async () => {
    const html =
      '<div class="film"><a href="/movie/12#22102026"><div style="background-image:url(\'/images/poster.jpg\')"></div></a><a class="ns" data-session-id="42" data-name="Фільм" data-anchor="22102026" data-low="0" data-high="0"><p class="time">19:00</p><p class="tag">LUX SDH</p></a></div>';
    const film = parseMultiplexSchedule(html, now)[0];
    expect(film?.sessions[0]).toMatchObject({
      id: 'multiplex:42',
      startAt: '2026-10-22T16:00:00.000Z',
      price: null,
      format: 'LUX SDH',
    });
    const details =
      '<p class="key">Тривалість:</p><p class="val">1:59</p><p class="key">Жанр:</p><p class="val">Екшн</p><p id="mvi_language">українська</p><script>"alternativeHeadline":"Original Film","dateCreated":"2026-10-15"</script>';
    expect(multiplexFilmDetails(details)).toMatchObject({
      durationMinutes: 119,
      genre: 'Екшн',
      film: { originalTitle: 'Original Film', year: 2026, language: 'українська' },
    });
    const fetch = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(new Response(url.includes('/cinema/') ? html : details)),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await collectMultiplex(now, { cinemas: [] })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    const items = await collectMultiplex(now, { cinemas: ['multiplex-victoria'] });
    expect(items[0]?.sessions[0]?.endAt).toBe('2026-10-22T17:59:00.000Z');
  });
  it('reads publisher RSS artwork and series without downloading audio or resurfacing stale episodes', async () => {
    const xml =
      '<channel><title>Серія про мистецтво</title><language>uk</language><itunes:author>Куншт</itunes:author><itunes:image href="https://d3t3ozftmdmh3i.cloudfront.net/cover.jpg"/><item><title>Свіжий випуск</title><link>https://podcasters.spotify.com/pod/show/test/episodes/1</link><guid>one</guid><pubDate>18 Oct 2026 10:00:00 GMT</pubDate><itunes:duration>23:10</itunes:duration><enclosure url="https://audio.example/file.mp3"/></item><item><title>Архів</title><link>https://podcasters.spotify.com/pod/show/test/episodes/0</link><pubDate>1 Oct 2024 10:00:00 GMT</pubDate></item></channel>';
    const fetch = vi.fn().mockResolvedValue(new Response(xml));
    vi.stubGlobal('fetch', fetch);
    const items = await collectPodcastFeed(
      { url: 'https://anchor.fm/s/test/podcast/rss', name: 'Куншт' },
      now,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      podcast: { series: 'Серія про мистецтво', publisher: 'Куншт', language: 'uk' },
      durationMinutes: 24,
      media: [{ credit: 'Куншт' }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('quality boundaries and interpretation', () => {
  it('keeps an open upper bound and conditional prices out of an invented fixed budget', () => {
    expect(
      leisureCostRange({ price: { min: 0, max: null, currency: 'UAH', basis: 'person' } }),
    ).toMatchObject({ min: 0, max: 0, unknown: false });
    expect(
      leisureCostRange({ price: { min: 300, max: 800, currency: 'UAH', basis: 'person' } }),
    ).toMatchObject({ min: 60000, max: 160000, unknown: false });
    expect(
      leisureCostRange({ price: { min: 300, currency: 'UAH', basis: 'unknown' } }).unknown,
    ).toBe(true);
    expect(
      leisureCostRange({
        category: 'food',
        placeDetails: { price_range: { startPrice: { units: '400', currencyCode: 'UAH' } } },
      }),
    ).toMatchObject({ min: 80000, max: null, approximate: true });
    expect(
      leisureCostRange({
        category: 'place',
        placeDetails: { price_range: { startPrice: { units: '400', currencyCode: 'UAH' } } },
      }).unknown,
    ).toBe(true);
  });
  it('requires exact original film metadata and keeps remakes apart', () => {
    const a = { category: 'cinema', sessions: [{}], film: { originalTitle: 'Film!', year: 2026 } };
    expect(leisureFilmKey(a)).toBe('original:film:2026');
    expect(leisureFilmKey({ ...a, film: { originalTitle: 'Film!', year: 1995 } })).not.toBe(
      leisureFilmKey(a),
    );
    expect(leisureFilmKey({ category: 'cinema', title: 'Film' })).toBeNull();
  });
  it('normalizes recurrence exceptions and rejects invalid wall times', () => {
    const schedule = normalizeLeisureSchedule({
      kind: 'recurring',
      weekdays: [0, 7, 0],
      excludedDates: ['2026-10-25', 'bad'],
      startTime: '10:00',
      precision: 'exact',
    });
    expect(schedule?.weekdays).toEqual([0]);
    expect(leisureAvailableOn({ schedule }, '2026-10-25')).toBe(false);
    expect(() => leisureLocalInstant('2026-03-29', '03:30')).toThrow();
  });
  it('enforces publisher media hosts and every redirect hop', async () => {
    expect(leisureMediaUrl('https://lviv.travel.attacker.example/img.jpg')).toBeNull();
    expect(leisureMediaUrl('https://lviv.travel:444/img.jpg')).toBeNull();
    expect(leisureMediaUrl('javascript:alert(1)')).toBeNull();
    expect(leisureMediaUrl(undefined, 'https://opera.lviv.ua/')).toBeNull();
    expect(leisureMediaUrl('', 'https://opera.lviv.ua/')).toBeNull();
    expect(leisureMediaUrl('/poster.jpg', 'https://philharmonia.lviv.ua/event/x')).toBe(
      'https://philharmonia.lviv.ua/poster.jpg',
    );
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(sourceText('https://lviv.travel/ua/events')).rejects.toThrow('source-not-allowed');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      boundedBytes(new Response('x', { headers: { 'content-length': '3000001' } }), 2000000),
    ).rejects.toThrow('source-too-large');
    await expect(boundedBytes(new Response('12345'), 4)).rejects.toThrow('source-too-large');
  });
  it('uses local bounds, excludes closed/misclassified results and reports practical coverage', () => {
    expect(leisureDiscoveryBounds('Львів')?.west).toBe(23.82);
    expect(leisureDiscoveryBounds('Київ')).toBeUndefined();
    expect(leisureDiscoveredCategory({ place_type: 'museum' }, 'food')).toBeNull();
    expect(leisureDiscoveredCategory({ place_type: 'italian_restaurant' }, 'food')).toBe('food');
    expect(
      leisureDiscoveredCategory(
        { place_type: 'cafe', business_status: 'CLOSED_PERMANENTLY' },
        'food',
      ),
    ).toBeNull();
    expect(
      leisureSourceCoverage([{ media: [{}], price: { min: 0 }, schedule: { kind: 'on-request' } }]),
    ).toEqual({ withMedia: 1, withPrice: 1, withTime: 0, needsCheck: 1 });
  });
});
