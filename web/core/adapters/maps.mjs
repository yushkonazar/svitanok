// Google Maps Platform (ADR-011, 01 §2.3, 07 §4 places.*/routes.eta/geo.geocode,
// етап 5 PR-1): Places Text Search (New, SKU Pro), Place Details (New, SKU
// Enterprise - лише для ОБРАНОГО закладу), Routes computeRoutes, Geocoding.
// Один ключ MAPS_API_KEY (обмежений трьома API в консолі). Кожен успішний
// виклик - countQuota у quota_counters (01 §7: алерт 80 %, при 100 % виклику
// НЕМАЄ - S-1-14: Places живе з кешу `places`, Routes/Geocoding відмовляють
// явно). Кеш `places` (07 §1) - джерело для чату й ланцюга столика: details
// пишуть телефон/сайт/години і fetched_at, пошук - лише адресу й координати
// (новий рядок - з fetched_at пошуку, hours_json порожній = деталей ще не
// було), не затираючи ані деталей, ані оцінки/улюбленого власника.
//
// Field mask - контракт SKU: поле поза списком Pro/Enterprise тягне дорожчий
// SKU, тож маски тримаємо константами, не будуємо з аргументів.

import { assertQuota, countQuota, quotaLimitOf, quotaUsed } from '../quota/quota.mjs';

export { QuotaExhaustedError } from '../quota/quota.mjs';

export const PLACES_SEARCH_MAX = 8;
/** Деталі закладу з кешу без походу в API, поки їм менше тижня. */
export const PLACE_DETAILS_FRESH_MS = 7 * 86_400_000;
const TIMEOUT_MS = 10_000;
const PLACES_API = 'https://places.googleapis.com/v1';
const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GEOCODE_API = 'https://maps.googleapis.com/maps/api/geocode/json';
/** Мова/регіон відповідей - власник один, українською; константа, не конфіг. */
const LANGUAGE = 'uk';
const REGION = 'UA';
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
});
const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,300}$/;
/** Радіус locationBias для «near» (метри): місто, не квартал. */
const NEAR_RADIUS_M = 15_000;

/**
 * @typedef {{ place_id: string, name: string, address: string | null, lat: number | null,
 *   lon: number | null, maps_uri: string | null }} PlaceCandidate
 * @typedef {PlaceCandidate & { phone: string | null, site: string | null,
 *   hours: string[], rating_owner: number | null, is_favorite: boolean, visits: number,
 *   fetched_at: string | null }} PlaceDetails
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

/**
 * fetch + таймаут + тіло → JSON. Текст помилки - без URL (у Geocoding ключ
 * іде query-параметром, бо legacy-API іншого способу не має) і без ключа з
 * тіла відповіді Google.
 * @param {string} url @param {RequestInit} init @param {string} what
 * @returns {Promise<any>}
 */
async function callJson(url, init, what) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (/** @type {any} */ e) {
    throw new Error(`${what}: мережа - ${String(e?.name ?? e)}`, { cause: e });
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
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

/** Рядок `places` → PlaceDetails (кандидат - його підмножина). @param {any} row @returns {PlaceDetails} */
function detailsOfRow(row) {
  /** @type {string[]} */
  let hours = [];
  if (row.hours_json) {
    try {
      const parsed = JSON.parse(String(row.hours_json));
      if (Array.isArray(parsed?.weekday)) hours = parsed.weekday.map(String);
    } catch {
      console.error(`places: битий hours_json у ${String(row.place_id)}`);
    }
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
    fetched_at: row.fetched_at == null ? null : String(row.fetched_at),
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
  const limit = Math.min(
    PLACES_SEARCH_MAX,
    Math.max(1, Math.floor(Number(input.limit) || PLACES_SEARCH_MAX)),
  );
  const key = mapsApiKey(env);
  const textQuery = input.city ? `${query}, ${String(input.city).trim()}` : query;
  if ((await quotaUsed(env, 'places_text', nowMs)) >= quotaLimitOf('places_text')) {
    const cached = await searchCache(env, query, limit);
    if (cached.length === 0) await assertQuota(env, 'places_text', nowMs);
    return { places: cached, source: 'cache' };
  }
  /** @type {Record<string, unknown>} */
  const body = { textQuery, pageSize: limit, languageCode: LANGUAGE, regionCode: REGION };
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
  await countQuota(env, 'places_text', nowMs);
  /** @type {PlaceCandidate[]} */
  const places = [];
  for (const raw of Array.isArray(json.places) ? json.places : []) {
    const p = candidateOf(raw);
    if (p && places.length < limit) places.push(p);
  }
  if (places.length) {
    const iso = new Date(nowMs).toISOString();
    // Пошук оновлює лише «зовнішні» поля; телефон/сайт/години з details,
    // fetched_at деталей і оцінка/улюблене власника лишаються.
    const stmt = db(env).prepare(
      `INSERT INTO places (place_id, name, address, lat, lon, maps_uri, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (place_id) DO UPDATE SET name = excluded.name, address = excluded.address,
         lat = excluded.lat, lon = excluded.lon, maps_uri = excluded.maps_uri`,
    );
    await db(env).batch(
      places.map((p) => stmt.bind(p.place_id, p.name, p.address, p.lat, p.lon, p.maps_uri, iso)),
    );
  }
  return { places, source: 'api' };
}

/** Кеш за назвою (LIKE, без регістру для латиниці; кирилиця - як є). @param {Env} env @param {string} query @param {number} limit */
async function searchCache(env, query, limit) {
  const { results } = await db(env)
    .prepare(
      `SELECT * FROM places WHERE name LIKE ? ORDER BY is_favorite DESC, visits DESC, fetched_at DESC LIMIT ?`,
    )
    .bind(`%${query.replace(/[%_]/g, '')}%`, limit)
    .all();
  return (results ?? []).map((r) => {
    const { place_id, name, address, lat, lon, maps_uri } = detailsOfRow(r);
    return { place_id, name, address, lat, lon, maps_uri };
  });
}

/**
 * Деталі обраного закладу (S-1-7): телефон, сайт, години. Деталі є, якщо
 * hours_json не порожній (details пише його завжди, хоч і з порожнім
 * списком); свіжі (< 7 днів за fetched_at) - без API. Квота 100 % - будь-який
 * рядок кешу (хоч лише з пошуку) або QuotaExhaustedError.
 * @param {Env} env @param {string} placeId @param {number} nowMs
 * @returns {Promise<{ place: PlaceDetails, source: 'api' | 'cache' }>}
 */
export async function placeDetails(env, placeId, nowMs) {
  if (!PLACE_ID_RE.test(placeId)) throw new Error('places.details: некоректний place_id');
  const key = mapsApiKey(env);
  const row = /** @type {any} */ (
    await db(env).prepare('SELECT * FROM places WHERE place_id = ?').bind(placeId).first()
  );
  const hasDetails = row != null && row.hours_json != null;
  const fetchedMs = row?.fetched_at ? Date.parse(String(row.fetched_at)) : NaN;
  if (hasDetails && Number.isFinite(fetchedMs) && nowMs - fetchedMs < PLACE_DETAILS_FRESH_MS) {
    return { place: detailsOfRow(row), source: 'cache' };
  }
  if ((await quotaUsed(env, 'places_details', nowMs)) >= quotaLimitOf('places_details')) {
    if (row) return { place: detailsOfRow(row), source: 'cache' };
    await assertQuota(env, 'places_details', nowMs);
  }
  const json = await callJson(
    `${PLACES_API}/places/${encodeURIComponent(placeId)}?languageCode=${LANGUAGE}&regionCode=${REGION}`,
    { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_FIELD_MASK } },
    'Place details',
  );
  await countQuota(env, 'places_details', nowMs);
  // Відповідь без назви (заклад зник/змінив id) - назва з кешу; немає й
  // її - помилка, а не порожній рядок у кеші.
  const base = candidateOf(json) ?? (row ? detailsOfRow(row) : null);
  if (!base) throw new Error(`Place details: заклад ${placeId} без назви`);
  const phone =
    typeof json.internationalPhoneNumber === 'string'
      ? json.internationalPhoneNumber
      : typeof json.nationalPhoneNumber === 'string'
        ? json.nationalPhoneNumber
        : null;
  const site = typeof json.websiteUri === 'string' ? json.websiteUri : null;
  const hours = Array.isArray(json.regularOpeningHours?.weekdayDescriptions)
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
      JSON.stringify({ weekday: hours }),
      base.maps_uri,
      iso,
    )
    .run();
  return {
    place: {
      place_id: placeId,
      name: base.name,
      address: base.address,
      lat: base.lat,
      lon: base.lon,
      maps_uri: base.maps_uri,
      phone,
      site,
      hours,
      rating_owner: row?.rating_owner == null ? null : Number(row.rating_owner),
      is_favorite: Number(row?.is_favorite) === 1,
      visits: Number(row?.visits) || 0,
      fetched_at: iso,
    },
    source: 'api',
  };
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
 * тож він передається лише коли попереду, а в результаті `traffic` каже,
 * чи його враховано.
 * @param {Env} env
 * @param {{ from: Waypoint, to: Waypoint, mode: keyof typeof TRAVEL_MODES, departAtMs?: number | null }} input
 * @param {number} nowMs
 * @returns {Promise<{ distance_m: number, duration_s: number, duration_min: number, mode: string, traffic: boolean }>}
 */
export async function routesEta(env, input, nowMs) {
  const travelMode = TRAVEL_MODES[input.mode];
  if (!travelMode) {
    throw new Error(
      `routes.eta: mode «${String(input.mode)}» - дозволені ${Object.keys(TRAVEL_MODES).join(', ')}`,
    );
  }
  const key = mapsApiKey(env);
  await assertQuota(env, 'routes', nowMs);
  /** @type {Record<string, unknown>} */
  const body = {
    origin: waypointBody(input.from),
    destination: waypointBody(input.to),
    travelMode,
    languageCode: LANGUAGE,
    units: 'METRIC',
  };
  const departAtMs = input.departAtMs ?? null;
  const timed =
    departAtMs != null &&
    departAtMs > nowMs &&
    (travelMode === 'DRIVE' || travelMode === 'TRANSIT');
  if (timed) {
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
  await countQuota(env, 'routes', nowMs);
  const route = Array.isArray(json.routes) ? json.routes[0] : null;
  const durationMatch = /^(\d+(?:\.\d+)?)s$/.exec(String(route?.duration ?? ''));
  const distanceM = Number(route?.distanceMeters);
  if (!route || !durationMatch || !Number.isFinite(distanceM)) {
    throw new Error('Routes: маршрут не знайдено');
  }
  const durationS = Number(durationMatch[1]);
  return {
    distance_m: Math.round(distanceM),
    duration_s: Math.round(durationS),
    duration_min: Math.max(1, Math.round(durationS / 60)),
    mode: input.mode,
    traffic: timed && travelMode === 'DRIVE',
  };
}

// ── Geocoding ──────────────────────────────────────────────────────────────

/**
 * Місто/адреса → координати (07 §4 geo.geocode; замінює OpenWeather з етапу 1
 * лише в інструменті - /locate і зворотне геокодування Mini App лишаються на
 * безкоштовному OpenWeather). `name` - коротка назва (locality), як було в
 * контракті; повна адреса - `address`.
 * @param {Env} env @param {string} text @param {number} nowMs
 * @returns {Promise<{ found: false } | { found: true, lat: number, lon: number, name: string, address: string, locality: string | null }>}
 */
export async function geocodeAddress(env, text, nowMs) {
  const address = String(text ?? '').trim();
  if (!address) return { found: false };
  const key = mapsApiKey(env);
  await assertQuota(env, 'geocoding', nowMs);
  const url = new URL(GEOCODE_API);
  url.searchParams.set('address', address);
  url.searchParams.set('language', LANGUAGE);
  url.searchParams.set('region', REGION.toLowerCase());
  // Legacy Geocoding API приймає ключ лише query-параметром; callJson не
  // кладе URL у текст помилок, а тіло відповіді ріже `key=`.
  url.searchParams.set('key', key);
  const json = await callJson(url.toString(), {}, 'Geocoding');
  const status = String(json.status ?? '');
  if (status !== 'OK' && status !== 'ZERO_RESULTS') {
    throw new Error(`Geocoding: ${status} ${String(json.error_message ?? '').slice(0, 200)}`);
  }
  // ZERO_RESULTS - теж платний виклик.
  await countQuota(env, 'geocoding', nowMs);
  const first = json.results?.[0];
  const lat = Number(first?.geometry?.location?.lat);
  const lon = Number(first?.geometry?.location?.lng);
  if (status === 'ZERO_RESULTS' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { found: false };
  }
  const formatted = String(first.formatted_address ?? address);
  const locality = Array.isArray(first.address_components)
    ? (first.address_components.find(
        (/** @type {any} */ c) => Array.isArray(c?.types) && c.types.includes('locality'),
      )?.long_name ?? null)
    : null;
  return {
    found: true,
    lat,
    lon,
    name: locality == null ? formatted : String(locality),
    address: formatted,
    locality: locality == null ? null : String(locality),
  };
}
