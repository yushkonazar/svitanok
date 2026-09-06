// Google Maps Platform (ADR-011, 01 §2.3, 07 §4 places.*/routes.eta/geo.geocode,
// етап 5 PR-1): Places Text Search (New, SKU Pro), Place Details (New, SKU
// Enterprise - лише для ОБРАНОГО закладу), Routes computeRoutes, Geocoding.
// Один ключ MAPS_API_KEY (обмежений трьома API в консолі). Кожен успішний
// виклик - bumpQuota у quota_counters (01 §7: алерт 80 %, при 100 % виклику
// НЕМАЄ - S-1-14: Places живе з кешу `places`, Routes/Geocoding відмовляють
// явно). Кеш `places` (07 §1) - джерело для чату й ланцюга столика, тому
// details пишуть у нього телефон/сайт/години, а пошук - лише адресу й
// координати, не затираючи деталей.
//
// Field mask - контракт SKU: поле поза списком Pro/Enterprise тягне дорожчий
// SKU, тож маски тримаємо константами, не будуємо з аргументів.

import { bumpQuota, quotaExhausted, QUOTA_LIMITS } from '../quota/quota.mjs';

export const PLACES_SEARCH_MAX = 8;
/** Деталі закладу з кешу без походу в API, поки їм менше тижня. */
export const PLACE_DETAILS_FRESH_MS = 7 * 86_400_000;
const TIMEOUT_MS = 10_000;
const PLACES_API = 'https://places.googleapis.com/v1';
const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GEOCODE_API = 'https://maps.googleapis.com/maps/api/geocode/json';
/** Text Search: лише поля SKU Pro (id/displayName/formattedAddress/location/googleMapsUri). */
export const SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri';
/** Place Details: телефон/сайт/години - SKU Enterprise (свідомо, для обраного закладу). */
export const DETAILS_FIELD_MASK =
  'id,displayName,formattedAddress,location,nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,googleMapsUri';
export const ROUTES_FIELD_MASK = 'routes.duration,routes.distanceMeters';
/** Режими routes.eta (S-1-9: пішки/транспорт/авто) → travelMode Routes API. */
export const TRAVEL_MODES = /** @type {const} */ ({
  walk: 'WALK',
  transit: 'TRANSIT',
  car: 'DRIVE',
  bike: 'BICYCLE',
});
const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,300}$/;
/** Радіус locationBias для «near» (метри): місто, не квартал. */
const NEAR_RADIUS_M = 15_000;

/**
 * @typedef {{ place_id: string, name: string, address: string | null, lat: number | null,
 *   lon: number | null, maps_uri: string | null }} PlaceCandidate
 * @typedef {PlaceCandidate & { phone: string | null, site: string | null,
 *   hours: string[], rating_owner: number | null, is_favorite: boolean, visits: number }} PlaceDetails
 */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - кеш places недоступний');
  return env.DB;
}

/** Ключ - явна відмова без нього (00-README п.6: без тихої деградації). @param {Env} env */
export function mapsApiKey(env) {
  const key = String(env.MAPS_API_KEY ?? '').trim();
  if (!key) throw new Error('MAPS_API_KEY не задано в Cloudflare - Google Maps недоступний');
  return key;
}

/** Виняток «стеля 100 %» - викликачі відрізняють його від збою API. */
export class QuotaExhaustedError extends Error {
  /** @param {string} key */
  constructor(key) {
    super(`квота ${key} вичерпана на цей місяць (100 %)`);
    this.name = 'QuotaExhaustedError';
    this.quotaKey = key;
  }
}

/** Стеля з довідника; відсутній ключ - помилка коду, не «без ліміту». @param {string} key */
function limitOf(key) {
  const limit = QUOTA_LIMITS[key];
  if (!limit) throw new Error(`quota: немає стелі для ${key}`);
  return limit;
}

/** @param {Env} env @param {string} key @param {number} nowMs */
async function isExhausted(env, key, nowMs) {
  return quotaExhausted(env, key, limitOf(key), nowMs);
}

/** @param {Env} env @param {string} key @param {number} nowMs */
async function assertQuota(env, key, nowMs) {
  if (await isExhausted(env, key, nowMs)) throw new QuotaExhaustedError(key);
}

/** @param {Env} env @param {string} key @param {number} nowMs */
async function count(env, key, nowMs) {
  await bumpQuota(env, { key, amount: 1, limit: limitOf(key), nowMs });
}

/**
 * @param {string} url @param {RequestInit} init @param {string} what
 * @returns {Promise<any>}
 */
async function callJson(url, init, what) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // Тіло помилки Google містить message без ключа; 300 символів вистачає
    // для діагнозу (REQUEST_DENIED / API not enabled), і ключ у URL не
    // потрапляє в текст: він іде заголовком або зрізається нижче.
    throw new Error(
      `${what}: HTTP ${res.status} ${text.slice(0, 300).replace(/key=[^&\s"]+/g, 'key=***')}`,
    );
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${what}: відповідь не JSON`);
  }
}

// ── Places ─────────────────────────────────────────────────────────────────

/**
 * @param {any} p
 * @returns {PlaceCandidate | null}
 */
function candidateOf(p) {
  const id = typeof p?.id === 'string' ? p.id : '';
  if (!PLACE_ID_RE.test(id)) return null;
  const name = String(p.displayName?.text ?? '').trim();
  if (!name) return null;
  return {
    place_id: id,
    name,
    address: typeof p.formattedAddress === 'string' ? p.formattedAddress : null,
    lat: typeof p.location?.latitude === 'number' ? p.location.latitude : null,
    lon: typeof p.location?.longitude === 'number' ? p.location.longitude : null,
    maps_uri: typeof p.googleMapsUri === 'string' ? p.googleMapsUri : null,
  };
}

/**
 * Пошук закладів за текстом (S-1-1/S-1-3): ≤ 8 кандидатів у кеш `places`.
 * `near` - зсув до координат власника (geo.last), `city` - місто з тексту
 * («у Києві») дописується в запит: Places розуміє «Креденс, Львів» без
 * окремого геокодування. Квота 100 % → лише кеш за назвою (S-1-14), порожній
 * кеш → QuotaExhaustedError.
 * @param {Env} env
 * @param {{ query: string, near?: { lat: number, lon: number } | null, city?: string | null, limit?: number }} input
 * @param {number} nowMs
 * @returns {Promise<{ places: PlaceCandidate[], source: 'api' | 'cache' }>}
 */
export async function placesSearch(env, input, nowMs) {
  const query = String(input.query ?? '').trim();
  if (!query) throw new Error('places.search: порожній query');
  const limit = Math.min(PLACES_SEARCH_MAX, Math.max(1, Number(input.limit) || PLACES_SEARCH_MAX));
  const textQuery = input.city ? `${query}, ${String(input.city).trim()}` : query;
  if (await isExhausted(env, 'places_text', nowMs)) {
    const cached = await searchCache(env, query, limit);
    if (cached.length === 0) throw new QuotaExhaustedError('places_text');
    return { places: cached, source: 'cache' };
  }
  const key = mapsApiKey(env);
  /** @type {Record<string, unknown>} */
  const body = { textQuery, pageSize: limit, languageCode: 'uk', regionCode: 'UA' };
  if (input.near && Number.isFinite(input.near.lat) && Number.isFinite(input.near.lon)) {
    body.locationBias = {
      circle: {
        center: { latitude: input.near.lat, longitude: input.near.lon },
        radius: NEAR_RADIUS_M,
      },
    };
  }
  const json = await callJson(
    `${PLACES_API}/places:searchText`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(body),
    },
    'Places search',
  );
  await count(env, 'places_text', nowMs);
  const places = (Array.isArray(json.places) ? json.places : [])
    .map(candidateOf)
    .filter((/** @type {PlaceCandidate | null} */ p) => p != null)
    .slice(0, limit);
  const iso = new Date(nowMs).toISOString();
  for (const p of places) {
    // Пошук оновлює лише «зовнішні» поля; телефон/сайт/години з details і
    // оцінка/улюблене власника лишаються.
    await db(env)
      .prepare(
        `INSERT INTO places (place_id, name, address, lat, lon, maps_uri, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (place_id) DO UPDATE SET name = excluded.name, address = excluded.address,
           lat = excluded.lat, lon = excluded.lon, maps_uri = excluded.maps_uri,
           fetched_at = excluded.fetched_at`,
      )
      .bind(p.place_id, p.name, p.address, p.lat, p.lon, p.maps_uri, iso)
      .run();
  }
  return { places, source: 'api' };
}

/** Кеш за назвою (LIKE, без регістру для латиниці; кирилиця - як є). @param {Env} env @param {string} query @param {number} limit */
async function searchCache(env, query, limit) {
  const { results } = await db(env)
    .prepare(
      `SELECT place_id, name, address, lat, lon, maps_uri FROM places
       WHERE name LIKE ? ORDER BY is_favorite DESC, visits DESC, fetched_at DESC LIMIT ?`,
    )
    .bind(`%${query.replace(/[%_]/g, '')}%`, limit)
    .all();
  return /** @type {PlaceCandidate[]} */ (results ?? []).map((r) => ({
    place_id: String(r.place_id),
    name: String(r.name ?? ''),
    address: r.address == null ? null : String(r.address),
    lat: r.lat == null ? null : Number(r.lat),
    lon: r.lon == null ? null : Number(r.lon),
    maps_uri: r.maps_uri == null ? null : String(r.maps_uri),
  }));
}

/** @param {any} row @returns {PlaceDetails} */
function detailsOfRow(row) {
  /** @type {string[]} */
  let hours = [];
  try {
    const parsed = row.hours_json ? JSON.parse(String(row.hours_json)) : null;
    if (Array.isArray(parsed?.weekday)) hours = parsed.weekday.map(String);
  } catch {
    hours = [];
  }
  return {
    place_id: String(row.place_id),
    name: String(row.name ?? ''),
    address: row.address == null ? null : String(row.address),
    lat: row.lat == null ? null : Number(row.lat),
    lon: row.lon == null ? null : Number(row.lon),
    maps_uri: row.maps_uri == null ? null : String(row.maps_uri),
    phone: row.phone == null ? null : String(row.phone),
    site: row.site == null ? null : String(row.site),
    hours,
    rating_owner: row.rating_owner == null ? null : Number(row.rating_owner),
    is_favorite: Number(row.is_favorite) === 1,
    visits: Number(row.visits) || 0,
  };
}

/** Рядок кешу як є (null - немає). @param {Env} env @param {string} placeId */
export async function readPlace(env, placeId) {
  const row = await db(env)
    .prepare('SELECT * FROM places WHERE place_id = ?')
    .bind(placeId)
    .first();
  return row ? detailsOfRow(row) : null;
}

/** Час останнього details у hours_json ($.at): пошук теж пише fetched_at, тож свіжість деталей - окремо. @param {any} row */
function detailsAt(row) {
  try {
    const at = row?.hours_json ? JSON.parse(String(row.hours_json))?.at : null;
    return typeof at === 'string' ? Date.parse(at) : NaN;
  } catch {
    return NaN;
  }
}

/**
 * Деталі обраного закладу (S-1-7): телефон, сайт, години. Свіжий кеш (< 7 днів)
 * - без API; квота 100 % - кеш будь-якої давнини або QuotaExhaustedError.
 * @param {Env} env @param {string} placeId @param {number} nowMs
 * @returns {Promise<{ place: PlaceDetails, source: 'api' | 'cache' }>}
 */
export async function placeDetails(env, placeId, nowMs) {
  if (!PLACE_ID_RE.test(placeId)) throw new Error('places.details: некоректний place_id');
  const row = /** @type {any} */ (
    await db(env).prepare('SELECT * FROM places WHERE place_id = ?').bind(placeId).first()
  );
  const at = detailsAt(row);
  if (row && Number.isFinite(at) && nowMs - at < PLACE_DETAILS_FRESH_MS) {
    return { place: detailsOfRow(row), source: 'cache' };
  }
  if (await isExhausted(env, 'places_details', nowMs)) {
    if (row && Number.isFinite(at)) return { place: detailsOfRow(row), source: 'cache' };
    throw new QuotaExhaustedError('places_details');
  }
  const key = mapsApiKey(env);
  const json = await callJson(
    `${PLACES_API}/places/${encodeURIComponent(placeId)}?languageCode=uk&regionCode=UA`,
    { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_FIELD_MASK } },
    'Place details',
  );
  await count(env, 'places_details', nowMs);
  const base = candidateOf(json) ?? {
    place_id: placeId,
    name: String(row?.name ?? ''),
    address: row?.address ?? null,
    lat: row?.lat ?? null,
    lon: row?.lon ?? null,
    maps_uri: row?.maps_uri ?? null,
  };
  const phone =
    typeof json.internationalPhoneNumber === 'string'
      ? json.internationalPhoneNumber
      : typeof json.nationalPhoneNumber === 'string'
        ? json.nationalPhoneNumber
        : null;
  const site = typeof json.websiteUri === 'string' ? json.websiteUri : null;
  const weekday = Array.isArray(json.regularOpeningHours?.weekdayDescriptions)
    ? json.regularOpeningHours.weekdayDescriptions.map(String)
    : [];
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(
      `INSERT INTO places (place_id, name, address, lat, lon, phone, site, hours_json, maps_uri, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (place_id) DO UPDATE SET name = excluded.name, address = excluded.address,
         lat = excluded.lat, lon = excluded.lon, phone = excluded.phone, site = excluded.site,
         hours_json = excluded.hours_json, maps_uri = excluded.maps_uri, fetched_at = excluded.fetched_at`,
    )
    .bind(
      placeId,
      base.name,
      base.address,
      base.lat,
      base.lon,
      phone,
      site,
      JSON.stringify({ weekday, at: iso }),
      base.maps_uri,
      iso,
    )
    .run();
  const fresh = await db(env)
    .prepare('SELECT * FROM places WHERE place_id = ?')
    .bind(placeId)
    .first();
  return { place: detailsOfRow(fresh), source: 'api' };
}

// ── Routes ─────────────────────────────────────────────────────────────────

/** @typedef {{ lat: number, lon: number } | { place_id: string } | { address: string }} Waypoint */

/** @param {Waypoint} w */
function waypointBody(w) {
  if ('lat' in w) return { location: { latLng: { latitude: w.lat, longitude: w.lon } } };
  if ('place_id' in w) {
    if (!PLACE_ID_RE.test(w.place_id)) throw new Error('routes.eta: некоректний place_id');
    return { placeId: w.place_id };
  }
  const address = String(w.address ?? '').trim();
  if (!address) throw new Error('routes.eta: порожня адреса');
  return { address };
}

/**
 * Відстань і час (S-1-8/S-1-9, S-5-6). Авто з часом виїзду - з трафіком
 * (TRAFFIC_AWARE лише для DRIVE); час виїзду в минулому Routes відкидає,
 * тож він передається лише коли попереду.
 * @param {Env} env
 * @param {{ from: Waypoint, to: Waypoint, mode: keyof typeof TRAVEL_MODES, departAtMs?: number | null }} input
 * @param {number} nowMs
 * @returns {Promise<{ distance_m: number, duration_s: number, duration_min: number, mode: string }>}
 */
export async function routesEta(env, input, nowMs) {
  const travelMode = TRAVEL_MODES[input.mode];
  if (!travelMode) {
    throw new Error(
      `routes.eta: mode «${String(input.mode)}» - дозволені ${Object.keys(TRAVEL_MODES).join(', ')}`,
    );
  }
  await assertQuota(env, 'routes', nowMs);
  const key = mapsApiKey(env);
  /** @type {Record<string, unknown>} */
  const body = {
    origin: waypointBody(input.from),
    destination: waypointBody(input.to),
    travelMode,
    languageCode: 'uk',
    units: 'METRIC',
  };
  const departAtMs = input.departAtMs ?? null;
  if (
    departAtMs != null &&
    departAtMs > nowMs &&
    (travelMode === 'DRIVE' || travelMode === 'TRANSIT')
  ) {
    body.departureTime = new Date(departAtMs).toISOString();
    if (travelMode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';
  }
  const json = await callJson(
    ROUTES_API,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': ROUTES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    },
    'Routes',
  );
  await count(env, 'routes', nowMs);
  const route = Array.isArray(json.routes) ? json.routes[0] : null;
  const durationS = Number(String(route?.duration ?? '').replace(/s$/, ''));
  const distanceM = Number(route?.distanceMeters);
  if (!route || !Number.isFinite(durationS) || !Number.isFinite(distanceM)) {
    throw new Error('Routes: маршрут не знайдено');
  }
  return {
    distance_m: Math.round(distanceM),
    duration_s: Math.round(durationS),
    duration_min: Math.max(1, Math.round(durationS / 60)),
    mode: input.mode,
  };
}

// ── Geocoding ──────────────────────────────────────────────────────────────

/**
 * Місто/адреса → координати (07 §4 geo.geocode; замінює OpenWeather з етапу 1).
 * @param {Env} env @param {string} text @param {number} nowMs
 * @returns {Promise<{ found: false } | { found: true, lat: number, lon: number, name: string, locality: string | null }>}
 */
export async function geocodeAddress(env, text, nowMs) {
  const address = String(text ?? '').trim();
  if (!address) throw new Error('geo.geocode: порожній text');
  await assertQuota(env, 'geocoding', nowMs);
  const key = mapsApiKey(env);
  const url = new URL(GEOCODE_API);
  url.searchParams.set('address', address);
  url.searchParams.set('language', 'uk');
  url.searchParams.set('region', 'ua');
  url.searchParams.set('key', key);
  const json = await callJson(url.toString(), {}, 'Geocoding');
  const status = String(json.status ?? '');
  if (status === 'ZERO_RESULTS') {
    await count(env, 'geocoding', nowMs);
    return { found: false };
  }
  if (status !== 'OK') {
    throw new Error(`Geocoding: ${status} ${String(json.error_message ?? '').slice(0, 200)}`);
  }
  await count(env, 'geocoding', nowMs);
  const first = json.results?.[0];
  const lat = Number(first?.geometry?.location?.lat);
  const lon = Number(first?.geometry?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { found: false };
  const locality = Array.isArray(first.address_components)
    ? (first.address_components.find(
        (/** @type {any} */ c) => Array.isArray(c?.types) && c.types.includes('locality'),
      )?.long_name ?? null)
    : null;
  return {
    found: true,
    lat,
    lon,
    name: String(first.formatted_address ?? address),
    locality: locality == null ? null : String(locality),
  };
}
