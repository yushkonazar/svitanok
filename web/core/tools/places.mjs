// places.search / places.details / routes.eta (07 §4, етап 5 PR-1) -
// обгортки над adapters/maps.mjs для internal API. Текст закладів - зовнішній
// вміст (tainting у реєстрі), routes.eta - числа, без taint. Квота 100 % -
// QuotaExhaustedError із текстом для власника (S-1-14) прямо з quota.mjs.

import { placesSearch, placeDetails, routesEta, TRAVEL_MODES } from '../adapters/maps.mjs';
import { formatDurationLabel } from '../../agent-core.mjs';
import { configuredLocations } from '../../weather-geo.mjs';
import { runFactsGet } from './facts.mjs';
import { runGeoLast } from './read.mjs';
import { wrapExternal } from './markup.mjs';
import { safeHttpUrl } from './url.mjs';

const LATLON_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
/** ISO-8601 зі зсувом або Z: без зони Date.parse у Workers читає як UTC, а власник живе в Києві. */
const ISO_WITH_ZONE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
/** Локація старша за це - не «тут» (S-1-2: > 6 год → спитати, де власник). */
export const HERE_MAX_AGE_MS = 6 * 3_600_000;

/**
 * @param {Env} env
 * @param {{ query: string, city?: string, near?: { lat?: unknown, lon?: unknown }, limit?: number }} args
 * @param {number} nowMs
 */
export async function runPlacesSearch(env, args, nowMs) {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return { result: { found: 0, note: 'порожній query - потрібна назва або тип закладу' } };
  }
  const near =
    args.near && Number.isFinite(Number(args.near.lat)) && Number.isFinite(Number(args.near.lon))
      ? { lat: Number(args.near.lat), lon: Number(args.near.lon) }
      : null;
  const out = await placesSearch(
    env,
    { query, city: args.city ?? null, near, limit: args.limit },
    nowMs,
  );
  if (out.places.length === 0) {
    return {
      result: {
        found: 0,
        source: out.source,
        note: 'не знайдено - попроси назву точніше, адресу або посилання на карту (S-1-4)',
      },
    };
  }
  const lines = out.places.map(
    (p, i) => `${i + 1}. ${p.name}${p.address ? ` · ${p.address}` : ''} (place_id: ${p.place_id})`,
  );
  return {
    result: {
      found: out.places.length,
      source: out.source,
      places: wrapExternal('places', lines.join('\n')),
    },
  };
}

/**
 * @param {Env} env
 * @param {{ place_id: string }} args
 * @param {number} nowMs
 */
export async function runPlacesDetails(env, args, nowMs) {
  const out = await placeDetails(env, args.place_id, nowMs);
  const p = out.place;
  const lines = [
    p.name,
    p.address ? `Адреса: ${p.address}` : null,
    `Телефон: ${p.phone ?? 'у довіднику немає'}`,
    p.site ? `Сайт: ${p.site}` : null,
    p.hours.length ? `Години: ${p.hours.join('; ')}` : 'Години: невідомі',
    p.maps_uri ? `Карта: ${p.maps_uri}` : null,
  ].filter(Boolean);
  return {
    result: {
      place_id: p.place_id,
      source: out.source,
      has_phone: p.phone != null,
      // ⚠️ Сайт - ОКРЕМИМ полем, не лише рядком усередині `<external>`
      // (ідея №3). Адреса сайту потрібна ядру й Дослідникові як дані; змушувати
      // модель вигрібати URL із плямованого тексту означало б покладатись на
      // те, що вона його не перебреше. Через той самий фільтр, що й у
      // `places.menu` (ревʼю): непослідовність тут була б дірою, а не стилем.
      site: safeHttpUrl(p.site),
      is_favorite: p.is_favorite,
      rating_owner: p.rating_owner,
      details: wrapExternal('places', lines.join('\n'), p.place_id),
    },
  };
}

/**
 * Точка маршруту з рядка моделі: «lat,lon» · «place:<id>» · «home» (facts
 * place.home, інакше перша з OWNER_LOCATIONS) · «here» (geo.last не старша
 * за 6 год) · адреса.
 * @param {Env} env @param {string} raw @param {number} nowMs
 * @returns {Promise<import('../adapters/maps.mjs').Waypoint>}
 */
export async function resolveWaypoint(env, raw, nowMs) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('routes.eta: порожня точка');
  const ll = text.match(LATLON_RE);
  if (ll) return { lat: Number(ll[1]), lon: Number(ll[2]) };
  if (text.startsWith('place:')) return { place_id: text.slice('place:'.length) };
  const lower = text.toLowerCase();
  if (lower === 'here' || lower === 'тут') return resolveHere(env, nowMs);
  if (lower === 'home' || lower === 'дім') return resolveHome(env);
  return { address: text };
}

/** @param {Env} env @param {number} nowMs */
async function resolveHere(env, nowMs) {
  const geo = /** @type {any} */ ((await runGeoLast(env, nowMs)).result);
  if (!geo.known) throw new Error('routes.eta: остання локація невідома - спитай, де власник');
  if (geo.ageMs != null && geo.ageMs > HERE_MAX_AGE_MS) {
    throw new Error(
      `routes.eta: остання локація старша за ${Math.round(geo.ageMs / 3_600_000)} год - спитай, де власник`,
    );
  }
  return { lat: geo.lat, lon: geo.lon };
}

/** @param {Env} env */
async function resolveHome(env) {
  const fact = /** @type {any} */ (
    (await runFactsGet(env, { kind: 'place', key: 'home' })).result[0]
  );
  const v = fact?.value;
  if (v && Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lon))) {
    return { lat: Number(v.lat), lon: Number(v.lon) };
  }
  if (typeof v?.address === 'string' && v.address.trim()) return { address: v.address };
  const first = configuredLocations(env)?.[0];
  if (first) return { lat: first.lat, lon: first.lon };
  throw new Error('routes.eta: дім невідомий - запиши facts place.home {lat, lon} або {address}');
}

/**
 * @param {Env} env
 * @param {{ from: string, to: string, mode: string, depart_at?: string }} args
 * @param {number} nowMs
 */
export async function runRoutesEta(env, args, nowMs) {
  const mode = /** @type {keyof typeof TRAVEL_MODES} */ (String(args.mode ?? '').toLowerCase());
  if (!Object.hasOwn(TRAVEL_MODES, mode)) {
    throw new Error(
      `routes.eta: mode «${args.mode}» - дозволені ${Object.keys(TRAVEL_MODES).join(', ')}`,
    );
  }
  let departAtMs = null;
  if (args.depart_at) {
    departAtMs = Date.parse(args.depart_at);
    if (!ISO_WITH_ZONE_RE.test(args.depart_at.trim()) || !Number.isFinite(departAtMs)) {
      throw new Error(
        'routes.eta: depart_at має бути ISO-8601 зі зсувом (напр. 2026-09-07T18:00:00+03:00)',
      );
    }
  }
  const [from, to] = await Promise.all([
    resolveWaypoint(env, args.from, nowMs),
    resolveWaypoint(env, args.to, nowMs),
  ]);
  const out = await routesEta(env, { from, to, mode, departAtMs }, nowMs);
  return {
    result: {
      ...out,
      distance_km: Math.round(out.distance_m / 100) / 10,
      text: `${formatDurationLabel(out.duration_min)} ${modeWord(mode)} (${(out.distance_m / 1000).toFixed(1)} км)${out.traffic ? ', з трафіком' : ''}`,
    },
  };
}

/** @param {keyof typeof TRAVEL_MODES} mode */
export function modeWord(mode) {
  return { walk: 'пішки', transit: 'транспортом', car: 'авто' }[mode];
}
