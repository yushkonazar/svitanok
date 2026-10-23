import { placesSearch, routesEta } from '../adapters/maps.mjs';
import { resolveKnownTripCity, resolveTripCity } from './geography.mjs';

/** @param {string} name */
const words = (name) =>
  String(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\d]{3,}/gu) ?? [];
/** Avoid pinning a random hotel or a city centroid when the name is ambiguous.
 * @param {string} title @param {any[]} places @param {{lat:number,lon:number}} center */
export function matchTripMapPlace(title, places, center) {
  const wanted = words(title);
  if (!wanted.length) return null;
  const scored = places
    .filter(
      (p) =>
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        Math.abs(p.lat - center.lat) < 0.3 &&
        Math.abs(p.lon - center.lon) < 0.45,
    )
    .map((p) => {
      const actual = new Set(words(p.name));
      return { place: p, score: wanted.filter((w) => actual.has(w)).length / wanted.length };
    })
    .sort((a, b) => b.score - a.score);
  if (
    !scored[0] ||
    scored[0].score < 0.7 ||
    (scored[1] && scored[0].score - scored[1].score < 0.15)
  )
    return null;
  return scored[0].place;
}

/** One explicit map open, bounded to eight saved candidates. Nothing here writes owner facts.
 * @param {Env} env @param {any} current @param {string} kind @param {number} nowMs @param {string|null} [focusId] */
export async function tripMapData(env, current, kind, nowMs, focusId = null) {
  if (!['stay', 'transport', 'activity'].includes(kind))
    throw new Error('Обери мапу житла, дороги або місць.');
  const a = current.answers ?? {};
  const destination = String(a.to ?? '');
  const directions = kind === 'transport' && a.from_city && destination;
  const external = new URL(
    directions ? 'https://www.google.com/maps/dir/' : 'https://www.google.com/maps/search/',
  );
  external.searchParams.set('api', '1');
  if (directions) {
    external.searchParams.set('origin', String(a.from_city));
    external.searchParams.set('destination', destination);
    external.searchParams.set('travelmode', 'driving');
  } else external.searchParams.set('query', destination);
  if (!env.MAPS_BROWSER_API_KEY || !env.MAPS_MAP_ID)
    return {
      enabled: false,
      external_url: external.href,
      message: 'Вбудована мапа ще не підключена. Можна відкрити Google Maps.',
    };
  const geo =
    resolveKnownTripCity(destination, nowMs) ?? (await resolveTripCity(env, destination, nowMs));
  const center = geo?.place;
  if (!center)
    return {
      enabled: false,
      external_url: external.href,
      message: 'Уточни місто призначення, щоб показати мапу.',
    };
  /** @type {any[]} */
  const markers = [];
  /** @type {string[]} */
  const missing = [];
  let route = null;
  if (kind === 'transport') {
    const origin = (
      resolveKnownTripCity(String(a.from_city ?? ''), nowMs) ??
      (await resolveTripCity(env, String(a.from_city ?? ''), nowMs))
    )?.place;
    if (origin) {
      markers.push(
        { id: 'route-origin', title: a.from_city, lat: origin.lat, lon: origin.lon },
        { id: 'route-destination', title: destination, lat: center.lat, lon: center.lon },
      );
      if (env.MAPS_API_KEY) {
        try {
          route = await routesEta(
            env,
            {
              from: { lat: origin.lat, lon: origin.lon },
              to: { lat: center.lat, lon: center.lon },
              mode: 'car',
              geometry: true,
            },
            nowMs,
          );
        } catch {
          missing.push(
            'Не вдалося отримати лінію маршруту. Точки відправлення й прибуття збережені.',
          );
        }
      }
    }
  } else {
    const stage = current.planning?.stages.find((/** @type {any} */ s) => s.kind === kind);
    const fresh = (stage?.options ?? []).filter((/** @type {any} */ o) => !o.stale);
    const focus = fresh.find((/** @type {any} */ o) => o.id === focusId);
    const options = (
      focus ? [focus, ...fresh.filter((/** @type {any} */ o) => o.id !== focusId)] : fresh
    ).slice(0, 8);
    for (const option of options) {
      let position = option.coordinates;
      let mapsUrl = null;
      if (!position && env.MAPS_API_KEY) {
        try {
          const found = await placesSearch(
            env,
            { query: option.title, city: destination, near: center, limit: 3, scope: 'trip' },
            nowMs,
          );
          const matched = matchTripMapPlace(option.title, found.places, center);
          if (matched) {
            position = matched;
            mapsUrl = matched.maps_uri;
          }
        } catch {
          /* A failed/quota-limited candidate remains in the list without a guessed pin. */
        }
      }
      if (position)
        markers.push({
          id: option.id,
          title: option.title,
          lat: position.lat,
          lon: position.lon,
          source_url: mapsUrl ?? option.source_url,
          label:
            option.price?.total_confirmed && option.availability !== 'unverified'
              ? `${option.price.amount * option.price.quantity} ${option.price.currency}`
              : option.title,
        });
      else missing.push(option.title);
    }
  }
  return {
    enabled: true,
    api_key: env.MAPS_BROWSER_API_KEY,
    map_id: env.MAPS_MAP_ID,
    frame_url: 'https://maps.svitanok.yushko.dev/travel-map.html',
    center: { lat: center.lat, lon: center.lon },
    external_url: external.href,
    markers,
    route,
    missing,
    caption:
      kind === 'transport'
        ? route?.polyline
          ? 'Орієнтовний автомобільний маршрут Google. Розклад автобуса, його зупинки та проходження кордону перевіряй окремо.'
          : markers.length
            ? 'Показано пункти відправлення й прибуття. Щоб прокласти дорогу, відкрий Google Maps.'
            : 'Показано місто призначення. Уточни місце відправлення, щоб прокласти дорогу.'
        : 'Позначки зіставлені зі знайденими об’єктами. Наявність і ціну перевір на сайті житла або місця.',
  };
}
