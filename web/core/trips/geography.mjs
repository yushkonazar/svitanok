import { tripZone } from './time.mjs';

// GeoNames records checked through Open-Meteo on 2026-10-21. Exact city
// aliases only: a country never determines a timezone and addresses stay local.
const SEED = [
  [3067696, 'Прага', 'Prague', 'CZ', 'Чехія', 'Europe/Prague', 50.08804, 14.42076],
  [702550, 'Львів', 'Lviv', 'UA', 'Україна', 'Europe/Kyiv', 49.83826, 24.02324],
  [703448, 'Київ', 'Kyiv', 'UA', 'Україна', 'Europe/Kyiv', 50.45466, 30.5238],
  [2761369, 'Відень', 'Vienna', 'AT', 'Австрія', 'Europe/Vienna', 48.20849, 16.37208],
  [709701, 'Яремче', 'Yaremche', 'UA', 'Україна', 'Europe/Kyiv', 48.44886, 24.55335],
  [710719, 'Чернівці', 'Chernivtsi', 'UA', 'Україна', 'Europe/Kyiv', 48.29045, 25.93241],
  [
    707471,
    'Івано-Франківськ',
    'Ivano-Frankivsk',
    'UA',
    'Україна',
    'Europe/Kyiv',
    48.92312,
    24.71248,
  ],
  [756135, 'Варшава', 'Warsaw', 'PL', 'Польща', 'Europe/Warsaw', 52.22977, 21.01178],
].map(([id, name, alias, country_code, country, timezone, latitude, longitude]) => ({
  id,
  name,
  alias,
  country_code,
  country,
  timezone,
  latitude,
  longitude,
  source: `https://www.geonames.org/${id}/`,
  checked_at: '2026-10-21',
}));
/** @param {unknown} value */
const key = (value) =>
  String(value ?? '')
    .trim()
    .toLocaleLowerCase('uk')
    .replace(/’/g, "'");
/** @param {any} raw @param {number} nowMs @returns {any} */
function location(raw, nowMs) {
  if (
    !Number.isInteger(raw?.id) ||
    !/^[A-Z]{2}$/.test(raw.country_code ?? '') ||
    !raw.timezone ||
    !Number.isFinite(raw.latitude) ||
    !Number.isFinite(raw.longitude)
  )
    return null;
  try {
    tripZone(raw.timezone);
  } catch {
    return null;
  }
  return {
    id: String(raw.id),
    name: String(raw.name).slice(0, 100),
    country: String(raw.country ?? raw.country_code).slice(0, 80),
    country_code: raw.country_code,
    timezone: raw.timezone,
    lat: raw.latitude,
    lon: raw.longitude,
    region: String(raw.admin1 ?? '').slice(0, 100),
    source: raw.source ?? `https://www.geonames.org/${raw.id}/`,
    checked_at: raw.checked_at ?? new Date(nowMs).toISOString(),
  };
}

/** Resolve city names, never personal street addresses. Unknown/ambiguous is explicit.
 * @param {string} city @param {number} nowMs */
export function resolveKnownTripCity(city, nowMs) {
  const seed = SEED.find((r) => key(r.name) === key(city) || key(r.alias) === key(city));
  return seed ? { status: 'resolved', place: location(seed, nowMs), candidates: [] } : null;
}
/** @param {Env} env @param {string} city @param {number} nowMs */
export async function resolveTripCity(env, city, nowMs) {
  const normalized = key(city),
    known = resolveKnownTripCity(city, nowMs);
  if (known) return known;
  if (!normalized || normalized.length > 100 || /\d|вул\.|street|@|https?:/iu.test(normalized))
    return { status: 'unknown', place: null, candidates: [] };
  const cacheKey = `trip:city:v1:${encodeURIComponent(normalized)}`;
  try {
    const cached = /** @type {any} */ (await env.BRIEFING?.get(cacheKey, 'json'));
    if (cached && Number(cached.expires_at) > nowMs) return cached.value;
  } catch {
    /* A cache failure does not block planning. */
  }
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', city);
  url.searchParams.set('count', '5');
  url.searchParams.set('language', 'uk');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3500), redirect: 'error' });
    if (!response.ok) throw new Error('Geocoding unavailable');
    const body = /** @type {any} */ (await response.json());
    const candidates = (Array.isArray(body.results) ? body.results : [])
      .map((/** @type {any} */ r) => location(r, nowMs))
      .filter(Boolean);
    const exact = candidates.filter((/** @type {any} */ r) => key(r.name) === normalized);
    const place = candidates.length === 1 ? candidates[0] : exact.length === 1 ? exact[0] : null;
    const value = {
      status: place ? 'resolved' : candidates.length ? 'ambiguous' : 'unknown',
      place,
      candidates: place ? [] : candidates,
    };
    await env.BRIEFING?.put(
      cacheKey,
      JSON.stringify({ expires_at: nowMs + 30 * 86400000, value }),
      { expirationTtl: 30 * 86400 },
    ).catch(() => {});
    return value;
  } catch {
    return { status: 'unavailable', place: null, candidates: [] };
  }
}

/** Only a city candidate previously returned by our resolver can be selected.
 * @param {Env} env @param {Record<string,any>} answers @param {Record<string,any>} previous @param {Record<string,any>} patch @param {number} nowMs @param {boolean} readOnly */
export async function enrichTripGeography(env, answers, previous, patch, nowMs, readOnly = false) {
  const out = { ...answers };
  const targets = /** @type {[string,string,string][]} */ ([
    ['to', 'destination', 'timezone'],
    ['from_city', 'origin', 'departure_timezone'],
  ]);
  for (const [field, geoKey, zoneField] of targets) {
    if (!out[field]) continue;
    let geo = out._geo?.[geoKey];
    if (geo?.query !== out[field] || (!geo?.place && Object.hasOwn(patch, field))) {
      const resolved = readOnly
        ? resolveKnownTripCity(out[field], nowMs)
        : await resolveTripCity(env, out[field], nowMs);
      if (resolved) geo = { ...resolved, query: out[field] };
    }
    const choice = geoKey === 'destination' ? patch.destination_choice : patch.origin_choice;
    if (choice) {
      const selected = geo?.candidates?.find((/** @type {any} */ p) => p.id === choice);
      if (!selected) throw new Error('Вибір міста застарів. Відкрий актуальне питання.');
      geo = { ...geo, status: 'resolved', place: selected, candidates: [] };
    }
    out._geo = { ...out._geo, [geoKey]: geo };
    if (geo?.place) {
      if (!out[zoneField]) out[zoneField] = geo.place.timezone;
      if (geoKey === 'destination' && !out.country_code) out.country_code = geo.place.country_code;
      if (geoKey === 'destination' && !out.country && out.international !== false) {
        out.country = geo.place.country;
        out.country_code = geo.place.country_code;
      }
    }
  }
  const dest = out._geo?.destination?.place,
    origin = out._geo?.origin?.place;
  if (dest && origin && out.international == null)
    out.international = dest.country_code !== origin.country_code;
  return out;
}
