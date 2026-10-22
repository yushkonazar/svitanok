import { lodgingSearchTerms, serviceUrl } from './links.mjs';
import { resolveKnownTripCity } from './geography.mjs';
import { recordUsage } from '../ops/usage-ledger.mjs';

/** Demand localises names and addresses, including a fallback when a translation is absent.
 * @param {any} value */
function bookingText(value) {
  return typeof value === 'string'
    ? value
    : ([value?.['en-gb'], value?.fallback, value?.['en-us']].find(
        (text) => typeof text === 'string' && text.trim(),
      ) ?? '');
}

/** Read-only Demand v3.2 search/look/redirect. No order, account login or payment endpoint.
 * @param {Env} env @param {any} answers @param {number} nowMs @param {string|null} [page] */
export async function searchBookingStays(env, answers, nowMs, page = null) {
  if (!env.BOOKING_API_TOKEN || !env.BOOKING_AFFILIATE_ID) return null;
  const country = String(env.BOOKING_BOOKER_COUNTRY ?? '').toLowerCase();
  const terms = lodgingSearchTerms(answers);
  const place =
    answers._geo?.destination?.place ?? resolveKnownTripCity(terms.destination, nowMs)?.place;
  if (
    !/^[a-z]{2}$/.test(country) ||
    !terms.checkin ||
    !terms.checkout ||
    terms.checkout <= terms.checkin ||
    !place
  )
    throw new Error('booking-search-needs-context');
  const ages = String(answers.children_ages ?? '')
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number);
  if (
    terms.children &&
    (ages.length !== terms.children ||
      ages.some((age) => !Number.isInteger(age) || age < 0 || age > 17))
  )
    throw new Error('booking-search-needs-child-ages');
  const base =
    env.BOOKING_API_ENV === 'production'
      ? 'https://demandapi.booking.com/3.2'
      : 'https://demandapi-sandbox.booking.com/3.2';
  /** @param {string} path @param {unknown} body */
  const call = async (path, body) => {
    let ok = false;
    const started = Date.now();
    try {
      const res = await fetch(`${base}/${path}`, {
        method: 'POST',
        // workerd supports manual/follow, not Node's redirect:error. Reject the
        // 3xx response below without sending partner credentials to its target.
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${env.BOOKING_API_TOKEN}`,
          'X-Affiliate-Id': String(env.BOOKING_AFFILIATE_ID),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`booking-http-${res.status}`);
      const value = /** @type {any} */ (await res.json());
      if (
        path === 'accommodations/constants'
          ? !Array.isArray(value.data?.accommodation_types)
          : !Array.isArray(value.data)
      )
        throw new Error('booking-invalid-response');
      ok = true;
      return value;
    } finally {
      await recordUsage(env, {
        provider: 'booking',
        feature: 'travel-search',
        sku: `booking/${path}`,
        quantity: 1,
        unit: 'request',
        apiAttempts: 1,
        ok,
        at: new Date(started).toISOString(),
        durationMs: Date.now() - started,
      });
    }
  };
  /** @type {Record<string, unknown>} */
  const filters = { dormitories: 'exclude' };
  if (answers.lodging_layout === 'apartment') {
    const constants = await call('accommodations/constants', {
      constants: ['accommodation_types'],
      languages: ['en-gb'],
    });
    const apartment = constants.data.accommodation_types.find((/** @type {any} */ type) =>
      /^apartments?$/i.test(bookingText(type.name)),
    );
    if (!Number.isInteger(apartment?.id)) throw new Error('booking-layout-not-supported');
    filters.accommodation_types = [apartment.id];
  }
  const found = await call('accommodations/search', {
    booker: { country, platform: 'mobile' },
    checkin: terms.checkin,
    checkout: terms.checkout,
    guests: {
      number_of_adults: terms.adults,
      number_of_rooms: terms.rooms,
      ...(terms.children ? { children: ages } : {}),
    },
    coordinates: { latitude: place.lat, longitude: place.lon, radius: 15 },
    currency: /^[A-Z]{3}$/.test(answers.budget_currency ?? '') ? answers.budget_currency : 'EUR',
    extras: ['products', 'extra_charges'],
    rows: 10,
    filters,
    ...(/центр|center|centre/iu.test(String(answers.lodging_preference ?? ''))
      ? { sort: { by: 'distance', direction: 'ascending' } }
      : {}),
    ...(page ? { page } : {}),
  });
  const rows = found.data.slice(0, 10).filter((/** @type {any} */ row) => Number.isInteger(row.id));
  if (!rows.length)
    return { options: [], summary: 'Booking не повернув доступних варіантів за цими параметрами.' };
  const details = await call('accommodations/details', {
    accommodations: rows.map((/** @type {any} */ row) => row.id),
    languages: ['en-gb'],
    extras: ['photos', 'policies'],
  });
  const options = rows.flatMap((/** @type {any} */ row) => {
    const detail = details.data.find((/** @type {any} */ d) => d.id === row.id);
    const source = serviceUrl(
      row.url?.web ?? row.url ?? detail?.url?.web ?? detail?.url,
      'booking.com',
    );
    const name = bookingText(detail?.name);
    if (!source || !name) return [];
    const amount = Number(row.price?.total?.booker_currency),
      currency = row.currency?.booker;
    const total = Number.isFinite(amount) && amount > 0 && /^[A-Z]{3}$/.test(currency ?? '');
    const policies = (row.products ?? []).map(
      (/** @type {any} */ p) => p.policies?.cancellation ?? null,
    );
    const samePolicy = new Set(policies.map((/** @type {any} */ p) => JSON.stringify(p))).size <= 1;
    const cancellation = samePolicy ? policies[0] : null;
    const images = Array.isArray(detail.photos?.photos)
      ? detail.photos.photos
      : Array.isArray(detail.photos)
        ? detail.photos
        : [];
    const score = detail.rating;
    return [
      {
        id: `booking-${row.id}`,
        kind: 'stay',
        title: name,
        provider: 'Booking.com',
        source_url: source.href,
        checked_at: new Date(nowMs).toISOString(),
        availability: env.BOOKING_API_ENV === 'production' ? 'provider_quote' : 'unverified',
        price: total
          ? {
              amount,
              currency,
              unit: 'stay',
              quantity: 1,
              total_confirmed: true,
              includes: `${terms.people} гостей, ${terms.rooms} кімн., ${terms.checkin} — ${terms.checkout}`,
              excludes: 'Умовні збори й остаточні умови перевір на Booking.',
            }
          : null,
        dates: `${terms.checkin} — ${terms.checkout}`,
        schedule: '',
        location: bookingText(detail.location?.address),
        coordinates:
          detail.location?.coordinates?.latitude != null
            ? {
                lat: detail.location.coordinates.latitude,
                lon: detail.location.coordinates.longitude,
              }
            : detail.location?.latitude != null
              ? { lat: detail.location.latitude, lon: detail.location.longitude }
              : null,
        photos: images
          .sort(
            (/** @type {any} */ a, /** @type {any} */ b) =>
              Number(b.main_photo === true) - Number(a.main_photo === true),
          )
          .slice(0, 6)
          .map((/** @type {any} */ p) => ({
            url: p.url?.standard ?? p.url?.large ?? p.url?.thumbnail,
          })),
        rating:
          score?.review_score != null
            ? {
                value: score.review_score,
                scale: 10,
                count: score.number_of_reviews,
                source: 'Booking.com',
              }
            : null,
        highlights: [
          `${terms.people} гостей · ${terms.rooms} кімн.`,
          ...(env.BOOKING_API_ENV === 'production' ? [] : ['Тестові дані Booking sandbox']),
        ],
        cancellation: !samePolicy
          ? 'Умови відрізняються для номерів; перевір на Booking.'
          : cancellation?.free_cancellation_until
            ? `Безкоштовно до ${cancellation.free_cancellation_until}`
            : cancellation?.type === 'non_refundable'
              ? 'Без повернення оплати; перевір умови обраного номера.'
              : '',
        tradeoffs: '',
        missing: total ? '' : 'Повну ціну не отримано.',
      },
    ];
  });
  return {
    options,
    next_page:
      typeof found.metadata?.next_page === 'string'
        ? found.metadata.next_page.slice(0, 2000)
        : null,
    summary:
      env.BOOKING_API_ENV === 'production'
        ? 'Варіанти Booking за датами й складом групи. Остаточні умови — на сторінці бронювання.'
        : 'Тестові приклади Booking sandbox, не справжні пропозиції для бронювання.',
  };
}
