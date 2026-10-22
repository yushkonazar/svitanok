import { mapsApiKey } from '../adapters/maps.mjs';
import { reserveQuota } from '../quota/quota.mjs';
import { recordUsage } from '../ops/usage-ledger.mjs';
import { boundedBytes } from './source-html.mjs';
import { cleanText, httpLink } from './model.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';

export const LEISURE_GOOGLE_DETAILS_MASK =
  'id,displayName,formattedAddress,location,googleMapsUri,primaryType,types,businessStatus,movedPlaceId,photos,rating,userRatingCount,priceRange,priceLevel,websiteUri,nationalPhoneNumber,internationalPhoneNumber,regularOpeningHours,currentOpeningHours,accessibilityOptions';
export const LEISURE_GOOGLE_EXTENDED_MASK =
  LEISURE_GOOGLE_DETAILS_MASK +
  ',outdoorSeating,reservable,parkingOptions,paymentOptions,servesBreakfast,servesBrunch,servesLunch,servesDinner,servesCoffee,servesDessert,servesCocktails,servesVegetarianFood,liveMusic,allowsDogs,goodForGroups,goodForChildren,restroom';
export const LEISURE_FOOD_SEARCH_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryType,places.types,places.businessStatus,places.rating,places.userRatingCount,places.priceRange,places.priceLevel,places.photos';
const API = 'https://places.googleapis.com/v1/';
const ID = /^[A-Za-z0-9_-]{1,300}$/;
const booleans = (/** @type {any} */ value) =>
  Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {}).filter(
      ([, v]) => typeof v === 'boolean',
    ),
  );
/** @param {Env} env @param {string} path @param {string|null} mask @param {string} sku @param {number} nowMs @param {any} [body] @param {string} [quotaKey] */
async function googleJson(
  env,
  path,
  mask,
  sku,
  nowMs,
  body = null,
  quotaKey = mask ? 'places_details' : 'places_photos',
) {
  const key = mapsApiKey(env),
    start = Date.now();
  await reserveQuota(env, quotaKey, nowMs);
  let ok = false;
  try {
    const response = await fetch(API + path, {
      // workerd supports manual/follow only; non-2xx (including redirects) is rejected below.
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: {
        'X-Goog-Api-Key': key,
        ...(mask ? { 'X-Goog-FieldMask': mask } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!response.ok) throw new Error('google-details-unavailable');
    const value = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 600_000)));
    ok = true;
    return value;
  } finally {
    await recordUsage(env, {
      provider: 'google',
      feature: 'leisure',
      sku,
      quantity: 1,
      unit: 'request',
      apiAttempts: 1,
      ok,
      at: new Date(start).toISOString(),
      durationMs: Date.now() - start,
    });
  }
}
/** Live display/planning data only: never saved into places, leisure_items, receipts or KV.
 * No reviews/AI summaries are ingested into preferences.
 * @param {Env} env @param {string} placeId @param {number} nowMs @param {boolean} [extended] */
export async function freshLeisurePlace(env, placeId, nowMs, extended = false) {
  if (!ID.test(placeId)) throw new Error('invalid-place-id');
  const p = await googleJson(
    env,
    `places/${placeId}?languageCode=uk&regionCode=UA`,
    extended ? LEISURE_GOOGLE_EXTENDED_MASK : LEISURE_GOOGLE_DETAILS_MASK,
    extended ? 'places-details-enterprise-atmosphere' : 'places-details-enterprise',
    nowMs,
  );
  if (p.id && p.id !== placeId) throw new Error('google-place-mismatch');
  return normalizeGoogleLeisurePlace(p, placeId, nowMs, extended);
}
/** @param {any} p @param {string} placeId @param {number} nowMs @param {boolean} extended */
export function normalizeGoogleLeisurePlace(p, placeId, nowMs, extended) {
  /** @type {Record<string,boolean>} */ const amenities = {};
  for (const key of [
    'outdoorSeating',
    'reservable',
    'servesBreakfast',
    'servesBrunch',
    'servesLunch',
    'servesDinner',
    'servesCoffee',
    'servesDessert',
    'servesCocktails',
    'servesVegetarianFood',
    'liveMusic',
    'allowsDogs',
    'goodForGroups',
    'goodForChildren',
    'restroom',
  ])
    if (typeof p[key] === 'boolean') amenities[key] = p[key];
  return {
    place_id: placeId,
    primaryType: cleanText(p.primaryType, 100),
    types: (Array.isArray(p.types) ? p.types : [])
      .filter((/** @type {any} */ t) => typeof t === 'string')
      .slice(0, 30),
    name: cleanText(p.displayName?.text, 180),
    address: cleanText(p.formattedAddress, 250) || null,
    lat: Number.isFinite(p.location?.latitude) ? p.location.latitude : null,
    lon: Number.isFinite(p.location?.longitude) ? p.location.longitude : null,
    maps_uri: httpLink(p.googleMapsUri),
    site: httpLink(p.websiteUri),
    phone: cleanText(p.internationalPhoneNumber || p.nationalPhoneNumber, 50) || null,
    hours: (Array.isArray(p.currentOpeningHours?.weekdayDescriptions)
      ? p.currentOpeningHours.weekdayDescriptions
      : (p.regularOpeningHours?.weekdayDescriptions ?? [])
    )
      .map((/** @type {any} */ v) => cleanText(v, 180))
      .slice(0, 7),
    periods: p.regularOpeningHours?.periods ?? [],
    currentPeriods: p.currentOpeningHours?.periods ?? [],
    specialDays: p.currentOpeningHours?.specialDays ?? [],
    currentHoursThrough: addDaysToDateKey(kyivDateKey(new Date(nowMs)), 6),
    businessStatus: ['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'].includes(
      p.businessStatus,
    )
      ? p.businessStatus
      : null,
    movedPlaceId:
      typeof p.movedPlaceId === 'string' && ID.test(p.movedPlaceId) ? p.movedPlaceId : null,
    rating: typeof p.rating === 'number' && p.rating >= 0 && p.rating <= 5 ? p.rating : null,
    userRatingCount:
      Number.isInteger(p.userRatingCount) && p.userRatingCount >= 0 ? p.userRatingCount : null,
    price_range: p.priceRange ?? null,
    priceLevel: typeof p.priceLevel === 'string' ? p.priceLevel : null,
    amenities,
    accessibility: booleans(p.accessibilityOptions),
    payment: booleans(p.paymentOptions),
    parking: booleans(p.parkingOptions),
    photos: (Array.isArray(p.photos) ? p.photos : [])
      .slice(0, 6)
      .filter((/** @type {any} */ photo) => validPhotoResource(photo.name, placeId))
      .map((/** @type {any} */ photo) => ({
        name: photo.name,
        authors: (Array.isArray(photo.authorAttributions) ? photo.authorAttributions : [])
          .slice(0, 10)
          .map((/** @type {any} */ a) => ({
            name: cleanText(a.displayName, 160),
            url: httpLink(String(a.uri ?? '').startsWith('//') ? 'https:' + a.uri : a.uri),
          })),
      })),
    fetched_at: new Date(nowMs).toISOString(),
    provider: 'Google Maps',
    extended,
  };
}
/** Live, display-only pool. No search result or score is written to a catalogue/cache.
 * @param {Env} env @param {string} query @param {string} city @param {number} nowMs @param {boolean} [parking] */
export async function freshLeisureFoodSearch(env, query, city, nowMs, parking = false) {
  const response = await googleJson(
    env,
    'places:searchText',
    LEISURE_FOOD_SEARCH_MASK + (parking ? ',places.parkingOptions' : ''),
    parking ? 'places-textsearch-enterprise-atmosphere' : 'places-textsearch-enterprise',
    nowMs,
    /** @type {any} */ ({
      textQuery: query + ' ' + city,
      languageCode: 'uk',
      regionCode: 'UA',
      pageSize: 20,
      minRating: 4,
      rankPreference: 'RELEVANCE',
      locationRestriction: {
        rectangle: {
          low: { latitude: 49.74, longitude: 23.84 },
          high: { latitude: 49.93, longitude: 24.17 },
        },
      },
    }),
    'places_text',
  );
  return (Array.isArray(response.places) ? response.places : [])
    .slice(0, 20)
    .filter((/** @type {any} */ p) => ID.test(p.id ?? ''))
    .map((/** @type {any} */ p) => normalizeGoogleLeisurePlace(p, p.id, nowMs, parking));
}
/** @param {unknown} name @param {string} placeId */
export function validPhotoResource(name, placeId) {
  return (
    typeof name === 'string' &&
    name.length <= 2000 &&
    name.startsWith(`places/${placeId}/photos/`) &&
    /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name)
  );
}
/** Fetch one requested, freshly supplied photo. Key never enters a URL or redirect.
 * @param {Env} env @param {string} placeId @param {string} name @param {number} nowMs */
export async function freshLeisurePhoto(env, placeId, name, nowMs) {
  if (!ID.test(placeId) || !validPhotoResource(name, placeId))
    throw new Error('invalid-photo-resource');
  const json = await googleJson(
    env,
    `${name}/media?maxWidthPx=1000&maxHeightPx=800&skipHttpRedirect=true`,
    null,
    'places-photos',
    nowMs,
  );
  let target;
  try {
    target = new URL(json.photoUri);
  } catch {
    throw new Error('invalid-photo-response');
  }
  const allowed = new Set([
    'lh3.googleusercontent.com',
    'lh4.googleusercontent.com',
    'lh5.googleusercontent.com',
    'lh6.googleusercontent.com',
  ]);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.port ||
    !allowed.has(target.hostname)
  )
    throw new Error('invalid-photo-response');
  const response = await fetch(target.href, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  const type = (response.headers.get('content-type') ?? '').split(';')[0];
  if (!response.ok || !/^image\/(?:jpeg|png|webp|avif|gif)$/.test(type ?? ''))
    throw new Error('invalid-photo-response');
  return { bytes: await boundedBytes(response, 3_000_000), type: type || 'image/jpeg' };
}
