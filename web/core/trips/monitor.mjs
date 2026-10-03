import { geocodeAddress, routesEta } from '../adapters/maps.mjs';
import { chainTarget } from '../chains/state.mjs';
import { shouldDeliverProactive } from '../assistant-controls.mjs';
import { tripLocalParts, tripZone } from './time.mjs';
import { weatherQuotaConsume } from '../weather-quota/client.mjs';

/** Bounded thresholds, not a verdict that travel is safe.
 * @param {any} data @param {number} nowMs @param {string} zone */
export function tripWeatherWarnings(data, nowMs, zone) {
  const out = [];
  for (const alert of (Array.isArray(data?.alerts) ? data.alerts : []).slice(0, 4)) {
    if (Number(alert.end) * 1000 > nowMs && Number(alert.start) * 1000 <= nowMs + 24 * 3_600_000)
      out.push(
        `Погодне попередження: ${String(alert.event ?? 'перевір умови').slice(0, 100)} (${String(alert.sender_name ?? 'джерело OpenWeather').slice(0, 80)}).`,
      );
  }
  const today = tripLocalParts(nowMs, zone).date;
  const day = (Array.isArray(data?.daily) ? data.daily : []).find(
    (/** @type {any} */ d) =>
      Number.isFinite(Number(d.dt)) && tripLocalParts(Number(d.dt) * 1000, zone).date === today,
  );
  if (day) {
    if (Number(day.wind_gust ?? day.wind_speed) >= 15)
      out.push('Прогноз сильного вітру: від 15 м/с. Перевір умови маршруту.');
    if (Number(day.rain) >= 20)
      out.push('Прогноз значного дощу: від 20 мм за добу. Перевір план прогулянок.');
    if (Number(day.temp?.max) >= 35 || Number(day.temp?.min) <= -15)
      out.push('Прогноз крайніх температур. Перевір умови й підготовку.');
  }
  return out.slice(0, 4);
}

/** Uses existing provider and shared atomic quota; no new subscription.
 * @param {Env} env @param {string} place @param {number} nowMs @param {string} zone */
async function weather(env, place, nowMs, zone) {
  if (!env.WEATHER_API_KEY || !env.WEATHER_QUOTA) return [];
  const geo = await geocodeAddress(env, place, nowMs);
  if (!geo.found) return [];
  const quota = await weatherQuotaConsume(
    env,
    null,
    tripLocalParts(nowMs, 'Europe/Kyiv').date,
    1,
    150,
  );
  if (!quota.ok) return [];
  const url = new URL('https://api.openweathermap.org/data/3.0/onecall');
  for (const [k, v] of Object.entries({
    lat: geo.lat,
    lon: geo.lon,
    appid: env.WEATHER_API_KEY,
    units: 'metric',
    lang: 'ua',
    exclude: 'current,minutely,hourly',
  }))
    url.searchParams.set(k, String(v));
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Прогноз недоступний.');
  return tripWeatherWarnings(await response.json(), nowMs, zone);
}

/** Active trips only; explicit opt-in, quiet hours, quotas and atomic outbox.
 * @param {Env} env @param {number} nowMs @param {{weather?:typeof weather,route?:typeof routesEta}} deps */
export async function tripMonitorTask(env, nowMs = Date.now(), deps = {}) {
  if (!env.DB || !(await shouldDeliverProactive(env, 'nudge', nowMs)).deliver)
    return { checked: 0, sent: 0 };
  const earliest = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
  const latest = new Date(nowMs + 86_400_000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT t.id,t.to_text,t.date_from,t.date_to,t.cost_json,c.state_json FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.status='active' AND c.status IN ('running','waiting') AND json_extract(t.cost_json,'$.travel.monitor.enabled')=1 AND t.date_from<=? AND (t.date_to>=? OR (t.date_to IS NULL AND t.date_from>=?)) AND COALESCE(json_extract(t.cost_json,'$.travel.monitor_tick.next_at'),0)<=? ORDER BY COALESCE(json_extract(t.cost_json,'$.travel.monitor_tick.next_at'),0),t.date_from LIMIT 50`,
  )
    .bind(latest, earliest, earliest, nowMs)
    .all();
  let checked = 0,
    sent = 0;
  for (const row of results ?? []) {
    if (checked >= 10) break;
    try {
      const costs = JSON.parse(String(row.cost_json)),
        state = JSON.parse(String(row.state_json));
      const travel = costs.travel,
        settings = travel.monitor;
      if (!settings.consent) continue;
      const zone = tripZone(settings.timezone),
        local = tripLocalParts(nowMs, zone);
      const hour = Number(local.clock.slice(0, 2));
      if (
        hour < 8 ||
        hour >= 22 ||
        local.date < String(row.date_from) ||
        (row.date_to && local.date > String(row.date_to))
      )
        continue;
      const last = travel.monitor_tick ?? {};
      const tick =
        last.day === local.date ? { ...last } : { day: local.date, checks: 0, alerts: 0 };
      if (Number(last.next_at ?? 0) > nowMs || Number(tick.checks) >= 4) continue;
      const token = crypto.randomUUID();
      const nextTick = {
        ...tick,
        token,
        checks: Number(tick.checks ?? 0) + 1,
        next_at: nowMs + Math.max(6, Number(settings.interval_hours) || 6) * 3_600_000,
      };
      const claimed = JSON.stringify({ ...costs, travel: { ...travel, monitor_tick: nextTick } });
      const claim = await env.DB.prepare(
        "UPDATE trips SET cost_json=? WHERE id=? AND cost_json IS ? AND status='active'",
      )
        .bind(claimed, row.id, row.cost_json)
        .run();
      if (Number(claim.meta?.changes ?? 0) !== 1) continue;
      checked++;
      const signals = [];
      if (settings.weather) {
        try {
          signals.push(...(await (deps.weather ?? weather)(env, String(row.to_text), nowMs, zone)));
        } catch {
          /* Retry at the next bounded slot, not a technical alert. */
        }
      }
      const legs = Array.isArray(travel.legs) ? travel.legs : [];
      const upcoming = legs
        .filter(
          (/** @type {any} */ l) =>
            l.kind === 'travel' && l.start_ms > nowMs && l.start_ms <= nowMs + 24 * 3_600_000,
        )
        .sort((/** @type {any} */ a, /** @type {any} */ b) => a.start_ms - b.start_ms)[0];
      if (
        settings.road &&
        upcoming?.mode === 'car' &&
        upcoming.from &&
        upcoming.to &&
        upcoming.start_ms - nowMs <= 3 * 3_600_000
      ) {
        try {
          const eta = await (deps.route ?? routesEta)(
            env,
            { from: { address: upcoming.from }, to: { address: upcoming.to }, mode: 'car' },
            nowMs,
          );
          const planned = (upcoming.end_ms - upcoming.start_ms) / 60_000;
          if (eta && eta.duration_min >= planned + 30)
            signals.push(
              `Дорога «${upcoming.title}» зараз довша за закладений час щонайменше на 30 хв. Перевір час виїзду. Це оцінка маршруту, не твоя жива геолокація.`,
            );
        } catch {
          /* Quota/provider failure is not a road incident. */
        }
      }
      if (
        settings.service &&
        upcoming?.source_url &&
        ['plane', 'train', 'bus'].includes(upcoming.mode)
      )
        signals.push(
          `Перевір рейс «${upcoming.title}» у перевізника: ${upcoming.source_url}\nАвтоматичного live-статусу рейсу немає.`,
        );
      const signature = signals.join('\n');
      if (!signature || signature === last.signature || Number(tick.alerts) >= 2) continue;
      // Re-read after network: disabling monitoring or cancellation takes effect immediately.
      for (let retry = 0; retry < 3; retry++) {
        const live = await env.DB.prepare(
          `SELECT t.cost_json,c.status AS chain_status FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.id=? AND t.status='active'`,
        )
          .bind(row.id)
          .first();
        if (!live || !['running', 'waiting'].includes(String(live.chain_status))) break;
        const current = JSON.parse(String(live.cost_json));
        if (
          !current.travel?.monitor?.enabled ||
          current.travel.monitor_tick?.token !== token ||
          current.travel.monitor.changed_at !== settings.changed_at
        )
          break;
        const final = JSON.stringify({
          ...current,
          travel: {
            ...current.travel,
            monitor_tick: { ...nextTick, alerts: Number(tick.alerts ?? 0) + 1, signature },
          },
        });
        const target = chainTarget(env, state);
        const queuedAt = new Date(nowMs).toISOString();
        const payload = JSON.stringify({
          text: `🧳 ${String(row.to_text)}\n${signature}\nПеревірено ${local.clock} (${zone}).`,
        });
        const batch = await env.DB.batch([
          env.DB.prepare(
            "UPDATE trips SET cost_json=? WHERE id=? AND cost_json IS ? AND status='active'",
          ).bind(final, row.id, live.cost_json),
          env.DB.prepare(
            `INSERT OR IGNORE INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status) SELECT ?,?,?,'send',?,0,?,'pending' FROM trips WHERE id=? AND cost_json=? AND status='active'`,
          ).bind(
            `trip-monitor:${row.id}:${token}`,
            String(target.chatId),
            target.threadId ?? null,
            payload,
            queuedAt,
            row.id,
            final,
          ),
        ]);
        if (Number(batch[0]?.meta?.changes ?? 0) === 1) {
          sent++;
          break;
        }
      }
    } catch {
      console.error('trip-monitor: bounded check unavailable');
    }
  }
  return { checked, sent };
}
