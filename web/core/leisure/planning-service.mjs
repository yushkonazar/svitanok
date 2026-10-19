import { buildLeisureSuggestions, normalizeLeisureWindow, leisureLegKey } from './planning.mjs';
import { readLeisureWorkspace } from './store.mjs';
import { leisureId, LeisureError } from './model.mjs';
import { readCalendarRange } from '../../google.mjs';
import { placeDetails, routesEta } from '../adapters/maps.mjs';
import { forecastForDates } from '../adapters/weather.mjs';

/** Bounded, cached read operation. Does not create a plan, calendar event or notification.
 * @param {Env} env @param {any} input @param {number} [nowMs] */
export async function suggestLeisure(env, input, nowMs = Date.now()) {
  let window;
  try {
    window = normalizeLeisureWindow(input, nowMs);
  } catch (error) {
    throw new LeisureError(error instanceof Error ? error.message : 'Перевір дату й час.');
  }
  const workspace = await readLeisureWorkspace(env, nowMs, true);
  const version = JSON.stringify([
    input,
    workspace.items.map((i) => [i.id, i.checkedAt]),
    workspace.records.map((r) => [r.id, r.revision]),
    Math.floor(nowMs / 300000),
  ]);
  const cacheKey = 'leisure:suggestions:' + (await leisureId('window', version));
  const cached = await env.BRIEFING?.get(cacheKey, 'json').catch(() => null);
  if (cached) return cached;
  const deadline = Date.now() + 20000;
  const events = await readCalendarRange(env, window.from, window.to).catch(() => null);
  const facts = {
    calendarAvailable: events !== null,
    calendarEvents: events ?? [],
    routes: /** @type {Record<string,any>} */ ({}),
    boundaryRoutes: /** @type {Record<string,any>} */ ({}),
    forecasts: /** @type {any[]} */ ([]),
  };
  let result;
  try {
    result = buildLeisureSuggestions(workspace, input, nowMs, facts);
  } catch (error) {
    throw new LeisureError(error instanceof Error ? error.message : 'Перевір побажання до виходу.');
  }
  const chosen = new Set(
    result.days.flatMap((/** @type {any} */ d) =>
      d.plans.flatMap((/** @type {any} */ p) => p.stops.map((/** @type {any} */ s) => s.itemId)),
    ),
  );
  const outdoor = workspace.items.filter(
    (i) => chosen.has(i.id) && i.category === 'trip' && i.lat != null && i.lon != null,
  );
  for (const item of outdoor.slice(0, 1))
    if (Date.now() < deadline) {
      const dates = window.days
        .map((/** @type {any} */ d) => d.date)
        .filter(
          (/** @type {string} */ date) => Date.parse(date + 'T12:00Z') <= nowMs + 8 * 86400000,
        );
      if (!dates.length) continue;
      const forecast = await forecastForDates(env, { lat: item.lat, lon: item.lon }, dates).catch(
        () => ({ days: [] }),
      );
      facts.forecasts.push({ at: { lat: item.lat, lon: item.lon }, days: forecast.days });
    }
  // Details are quota-aware and reuse the adapter's cache. Never scan the whole catalog.
  for (const item of workspace.items.filter((i) => chosen.has(i.id) && i.placeId).slice(0, 8)) {
    if (Date.now() >= deadline) break;
    try {
      const detail = await placeDetails(env, item.placeId, nowMs);
      item.placeDetails = { ...detail.place, source: detail.source };
    } catch {
      /* Missing hours remain visibly unverified. */
    }
  }
  result = buildLeisureSuggestions(workspace, input, nowMs, facts);
  let calls = 0;
  for (const day of result.days)
    for (const plan of day.plans)
      for (let n = 1; n < plan.stops.length; n++) {
        const a = plan.stops[n - 1],
          b = plan.stops[n],
          key = leisureLegKey(a, b);
        if (facts.routes[key] || calls >= 10 || Date.now() >= deadline || !a.address || !b.address)
          continue;
        calls++;
        try {
          const route = await routesEta(
            env,
            {
              from: { address: a.address },
              to: { address: b.address },
              mode: window.transport,
              departAtMs: Date.parse(a.endAt),
            },
            nowMs,
          );
          facts.routes[key] = {
            available: true,
            minutes: route.duration_min,
            distanceM: route.distance_m,
          };
        } catch {
          facts.routes[key] = { available: false };
        }
      }
  if (window.startLocation)
    for (const day of result.days)
      for (const plan of day.plans)
        for (const direction of ['outbound', 'return']) {
          const s = direction === 'outbound' ? plan.stops[0] : plan.stops.at(-1),
            key = day.date + '|' + s.itemId + '|' + direction;
          if (facts.boundaryRoutes[key] || calls >= 10 || Date.now() >= deadline || !s.address)
            continue;
          calls++;
          try {
            const route = await routesEta(
              env,
              {
                from: { address: direction === 'outbound' ? window.startLocation : s.address },
                to: { address: direction === 'outbound' ? s.address : window.startLocation },
                mode: window.transport,
                departAtMs:
                  direction === 'outbound'
                    ? window.days.find((/** @type {any} */ d) => d.date === day.date)?.startAt
                    : Date.parse(s.endAt),
              },
              nowMs,
            );
            facts.boundaryRoutes[key] = {
              available: true,
              minutes: route.duration_min,
              distanceM: route.distance_m,
            };
          } catch {
            facts.boundaryRoutes[key] = { available: false };
          }
        }
  result = buildLeisureSuggestions(workspace, input, nowMs, facts);
  await env.BRIEFING?.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 }).catch(() => {});
  return result;
}
