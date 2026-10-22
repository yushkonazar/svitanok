import { chainTarget } from '../chains/state.mjs';
import { tripLocalParts, tripZone } from './time.mjs';
import { tripDayPlan } from './companion.mjs';
import { tripSupportButtons } from './support.mjs';
import { shouldDeliverProactive } from '../assistant-controls.mjs';
import { resolveTripCity } from './geography.mjs';
import { forecastForDates, forecastLine } from '../adapters/weather.mjs';
import { weatherQuotaConsume } from '../weather-quota/client.mjs';

/** Fresh rendering also guards queued messages after cancellation, task completion, or pause.
 * @param {Env} env @param {any} notice @param {number} nowMs @param {boolean} withWeather */
export async function renderTripNotice(env, notice, nowMs, withWeather = false) {
  if (
    !env.DB ||
    !notice ||
    typeof notice.trip_id !== 'string' ||
    !['morning', 'evening', 'deadline'].includes(notice.kind)
  )
    return null;
  const row = await env.DB.prepare(
    "SELECT t.*,c.state_json,c.status AS chain_status FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.id=? AND t.status IN ('active','done')",
  )
    .bind(notice.trip_id)
    .first();
  if (!row || !['running', 'waiting', 'done'].includes(String(row.chain_status))) return null;
  const costs = JSON.parse(String(row.cost_json ?? '{}')),
    state = JSON.parse(String(row.state_json)),
    travel = costs.travel ?? {},
    prefs = travel.preferences ?? {};
  if (
    prefs.paused ||
    prefs.support_level === 'plan' ||
    !(await shouldDeliverProactive(env, 'nudge', nowMs)).deliver
  )
    return null;
  const local = tripLocalParts(nowMs, tripZone(prefs.timezone ?? state.preferences?.timezone));
  if (local.date !== notice.date) return null;
  const hour = Number(local.clock.slice(0, 2));
  if (hour < 8 || hour >= 22) return null;
  let text;
  if (notice.kind === 'deadline') {
    const tasks = (travel.tasks ?? []).filter(
      (/** @type {any} */ t) =>
        (notice.task_ids ?? []).includes(t.id) && t.status === 'open' && t.due_at,
    );
    const bookings = (travel.bookings ?? []).filter(
      (/** @type {any} */ b) =>
        (notice.booking_ids ?? []).includes(b.id) &&
        ['selected', 'owner_booked', 'provider_confirmed'].includes(b.status) &&
        b.cancel_by &&
        Date.parse(b.cancel_by) > nowMs,
    );
    if (!tasks.length && !bookings.length) return null;
    const clock = (/** @type {string} */ at) => {
      const p = tripLocalParts(
        Date.parse(at),
        tripZone(prefs.timezone ?? state.preferences?.timezone),
      );
      return `${p.date} ${p.clock}`;
    };
    text = [
      `🧳 ${row.to_text} · справи зі строком`,
      ...tasks.map((/** @type {any} */ t) => `☐ ${t.title} · до ${clock(t.due_at)}`),
      ...bookings.map(
        (/** @type {any} */ b) =>
          `Умови скасування «${b.title}» · до ${clock(b.cancel_by)}${b.source_url ? `\n${b.source_url}` : ''}`,
      ),
    ].join('\n');
  } else {
    if (
      row.status !== 'active' ||
      travel.progress?.stage === 'home' ||
      prefs[notice.kind] === false ||
      state.preferences?.support_level === 'reminders' ||
      prefs.support_level === 'reminders'
    )
      return null;
    text =
      notice.kind === 'morning'
        ? `🧭 ${tripDayPlan(state, costs, local.date, nowMs)}`
        : `📖 ${row.to_text} · як минув день? Можеш зберегти враження, відвідані місця й незавершені плани. Етап прибуття підтверджується лише твоїми словами.`;
  }
  // This flag can only be set through the authenticated owner UI's dedicated
  // weather-consent action, whose checkbox discloses sharing the destination
  // city coordinates with OpenWeather. Neither model tools nor default support
  // preferences can grant it. Missing, revoked or legacy consent means no call.
  if (
    notice.kind === 'morning' &&
    withWeather &&
    prefs.weather_share_city === true &&
    prefs.weather_consent?.source === 'owner_ui' &&
    env.WEATHER_API_KEY &&
    env.WEATHER_QUOTA
  ) {
    try {
      const geo = await resolveTripCity(env, String(row.to_text), nowMs);
      if (geo.place) {
        const quota = await weatherQuotaConsume(
          env,
          null,
          tripLocalParts(nowMs, 'Europe/Kyiv').date,
          1,
          150,
        );
        if (quota.ok) {
          const forecast = await forecastForDates(
            env,
            { lat: geo.place.lat, lon: geo.place.lon },
            [local.date],
            tripZone(prefs.timezone ?? state.preferences?.timezone),
          );
          text += forecast.days.length
            ? `\nПогода: ${forecast.days.map(forecastLine).join('; ')}\nДжерело: OpenWeather, перевірено ${local.clock}.`
            : '\nПрогноз зараз недоступний. Перевір його перед виходом.';
        }
      }
    } catch {
      text += '\nПрогноз зараз недоступний. Перевір його перед виходом.';
    }
  }
  return {
    text: String(text).slice(0, 3900),
    reply_markup: { inline_keyboard: tripSupportButtons(String(row.workflow_id)) },
  };
}

/** Version 3 daily support is rolling rather than a 30-day snapshot. Existing workflows keep replay order.
 * @param {Env} env @param {number} nowMs */
export async function tripCompanionTask(env, nowMs = Date.now()) {
  if (!env.DB || !(await shouldDeliverProactive(env, 'nudge', nowMs)).deliver) return { sent: 0 };
  const { results } = await env.DB.prepare(
    "SELECT t.*,c.state_json,c.status AS chain_status FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.status IN ('active','done') AND c.status IN ('running','waiting','done') ORDER BY t.date_from DESC LIMIT 100",
  )
    .bind()
    .all();
  let sent = 0;
  for (const row of results ?? []) {
    if (sent >= 10) break;
    try {
      const state = JSON.parse(String(row.state_json)),
        costs = JSON.parse(String(row.cost_json ?? '{}')),
        travel = costs.travel ?? {},
        prefs = travel.preferences ?? {};
      if (prefs.paused || (prefs.support_level ?? state.preferences?.support_level) === 'plan')
        continue;
      const local = tripLocalParts(nowMs, tripZone(prefs.timezone ?? state.preferences?.timezone)),
        hour = Number(local.clock.slice(0, 2));
      if (hour < 8 || hour >= 22) continue;
      const tasks = (travel.tasks ?? [])
        .filter(
          (/** @type {any} */ t) =>
            t.status === 'open' &&
            t.due_at &&
            Date.parse(t.due_at) <= nowMs + 24 * 3_600_000 &&
            Date.parse(t.due_at) > nowMs - 3 * 86_400_000,
        )
        .slice(0, 6);
      const bookings = (travel.bookings ?? [])
        .filter(
          (/** @type {any} */ b) =>
            ['selected', 'owner_booked', 'provider_confirmed'].includes(b.status) &&
            b.cancel_by &&
            Date.parse(b.cancel_by) > nowMs &&
            Date.parse(b.cancel_by) <= nowMs + 24 * 3_600_000,
        )
        .slice(0, 4);
      const notices = [];
      if (tasks.length || bookings.length)
        notices.push({
          trip_id: String(row.id),
          kind: 'deadline',
          date: local.date,
          task_ids: tasks.map((/** @type {any} */ t) => t.id),
          booking_ids: bookings.map((/** @type {any} */ b) => b.id),
        });
      const end = state.date_to ? String(state.date_to) : null;
      if (
        state.support_version === 3 &&
        row.status === 'active' &&
        local.date >= state.date_from &&
        (!end || local.date <= end) &&
        travel.progress?.stage !== 'home'
      ) {
        if (hour >= 9 && hour < 13)
          notices.push({ trip_id: String(row.id), kind: 'morning', date: local.date });
        if (local.clock >= '20:30' && hour < 22)
          notices.push({ trip_id: String(row.id), kind: 'evening', date: local.date });
      }
      for (const notice of notices) {
        const key = `${notice.date}:${notice.kind}`;
        if (travel.notices?.[key]) continue;
        if (!(await renderTripNotice(env, notice, nowMs))) continue;
        const markers = Object.fromEntries(
          Object.entries({ ...travel.notices, [key]: new Date(nowMs).toISOString() }).slice(-90),
        );
        const next = JSON.stringify({ ...costs, travel: { ...travel, notices: markers } }),
          target = chainTarget(env, state),
          token = crypto.randomUUID();
        const saved = await env.DB.batch([
          env.DB.prepare(
            "UPDATE trips SET cost_json=? WHERE id=? AND cost_json IS ? AND status IN ('active','done')",
          ).bind(next, row.id, row.cost_json ?? null),
          env.DB.prepare(
            "INSERT OR IGNORE INTO outbox(id,chat_id,thread_id,kind,payload_json,attempts,next_at,status) SELECT ?,?,?,'send',?,0,?,'pending' FROM trips WHERE id=? AND cost_json=? AND status IN ('active','done')",
          ).bind(
            `trip-companion:${row.id}:${token}`,
            String(target.chatId),
            target.threadId ?? null,
            JSON.stringify({ trip_notice: notice }),
            new Date(nowMs).toISOString(),
            row.id,
            next,
          ),
        ]);
        if (Number(saved[0]?.meta?.changes ?? 0) === 1) {
          sent++;
          break;
        }
      }
    } catch {
      console.error('trip-companion: saved plan unavailable');
    }
  }
  return { sent };
}
