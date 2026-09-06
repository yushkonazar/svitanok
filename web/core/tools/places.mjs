// places.search / places.details / routes.eta (07 §4, етап 5 PR-1) -
// обгортки над adapters/maps.mjs для internal API. Текст закладів - зовнішній
// вміст (tainting у реєстрі), routes.eta - числа, без taint. Квота 100 % -
// чесна відмова з формулюванням S-1-14 («Довідник закладів тимчасово
// недоступний»), кеш - якщо є.

import {
  placesSearch,
  placeDetails,
  routesEta,
  QuotaExhaustedError,
  TRAVEL_MODES,
} from '../adapters/maps.mjs';
import { runFactsGet } from './facts.mjs';
import { runGeoLast } from './read.mjs';
import { wrapExternal } from './markup.mjs';

const LATLON_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** @param {unknown} e */
function quotaMessage(e) {
  if (e instanceof QuotaExhaustedError) {
    return new Error(
      `Довідник закладів тимчасово недоступний (${e.quotaKey} 100 % за місяць) - попроси назву/номер у власника`,
    );
  }
  return e;
}

/**
 * @param {Env} env
 * @param {{ query: string, city?: string, near?: { lat?: unknown, lon?: unknown }, limit?: number }} args
 * @param {number} nowMs
 */
export async function runPlacesSearch(env, args, nowMs) {
  const near =
    args.near && Number.isFinite(Number(args.near.lat)) && Number.isFinite(Number(args.near.lon))
      ? { lat: Number(args.near.lat), lon: Number(args.near.lon) }
      : null;
  let out;
  try {
    out = await placesSearch(
      env,
      { query: args.query, city: args.city ?? null, near, limit: args.limit },
      nowMs,
    );
  } catch (e) {
    throw quotaMessage(e);
  }
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
  let out;
  try {
    out = await placeDetails(env, args.place_id, nowMs);
  } catch (e) {
    throw quotaMessage(e);
  }
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
      is_favorite: p.is_favorite,
      rating_owner: p.rating_owner,
      details: wrapExternal('places', lines.join('\n'), p.place_id),
    },
  };
}

/**
 * Точка маршруту з рядка моделі: «lat,lon» · «place:<id>» · «home» (facts
 * place.home або перша з OWNER_LOCATIONS) · «here» (geo.last) · адреса.
 * @param {Env} env @param {string} raw
 * @returns {Promise<import('../adapters/maps.mjs').Waypoint>}
 */
export async function resolveWaypoint(env, raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('routes.eta: порожня точка');
  const ll = text.match(LATLON_RE);
  if (ll) return { lat: Number(ll[1]), lon: Number(ll[2]) };
  if (text.startsWith('place:')) return { place_id: text.slice('place:'.length) };
  if (text.toLowerCase() === 'here' || text.toLowerCase() === 'тут') {
    const geo = /** @type {any} */ ((await runGeoLast(env)).result);
    if (!geo.known) throw new Error('routes.eta: остання локація невідома - спитай, де власник');
    return { lat: geo.lat, lon: geo.lon };
  }
  if (text.toLowerCase() === 'home' || text.toLowerCase() === 'дім') {
    const fact = /** @type {any} */ (
      (await runFactsGet(env, { kind: 'place', key: 'home' })).result[0]
    );
    const v = fact?.value;
    if (v && Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lon))) {
      return { lat: Number(v.lat), lon: Number(v.lon) };
    }
    if (typeof v?.address === 'string' && v.address.trim()) return { address: v.address };
    const first = ownerHome(env);
    if (first) return first;
    throw new Error('routes.eta: дім невідомий - запиши facts place.home {lat, lon} або {address}');
  }
  return { address: text };
}

/** Перша локація з OWNER_LOCATIONS (та сама, що в погоді) як «дім» за замовчуванням. @param {Env} env */
function ownerHome(env) {
  try {
    const list = JSON.parse(String(env.OWNER_LOCATIONS ?? '[]'));
    const first = Array.isArray(list) ? list[0] : null;
    if (first && Number.isFinite(Number(first.lat)) && Number.isFinite(Number(first.lon))) {
      return { lat: Number(first.lat), lon: Number(first.lon) };
    }
  } catch {
    /* невалідний секрет - як «немає дому», про це вже кричить weather-geo */
  }
  return null;
}

/**
 * @param {Env} env
 * @param {{ from: string, to: string, mode: string, depart_at?: string }} args
 * @param {number} nowMs
 */
export async function runRoutesEta(env, args, nowMs) {
  const mode = /** @type {keyof typeof TRAVEL_MODES} */ (String(args.mode ?? '').toLowerCase());
  if (!(mode in TRAVEL_MODES)) {
    throw new Error(
      `routes.eta: mode «${args.mode}» - дозволені ${Object.keys(TRAVEL_MODES).join(', ')}`,
    );
  }
  const departAtMs = args.depart_at ? Date.parse(args.depart_at) : null;
  if (args.depart_at && !Number.isFinite(departAtMs)) {
    throw new Error('routes.eta: depart_at має бути ISO-8601');
  }
  const [from, to] = await Promise.all([
    resolveWaypoint(env, args.from),
    resolveWaypoint(env, args.to),
  ]);
  let out;
  try {
    out = await routesEta(env, { from, to, mode, departAtMs }, nowMs);
  } catch (e) {
    throw quotaMessage(e);
  }
  return {
    result: {
      ...out,
      distance_km: Math.round(out.distance_m / 100) / 10,
      text: `${out.duration_min} хв ${modeWord(mode)} (${(out.distance_m / 1000).toFixed(1)} км)`,
    },
  };
}

/** @param {keyof typeof TRAVEL_MODES} mode */
export function modeWord(mode) {
  return { walk: 'пішки', transit: 'транспортом', car: 'авто', bike: 'велосипедом' }[mode];
}
