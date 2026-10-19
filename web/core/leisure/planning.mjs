import {
  leisureLocalInstant,
  leisureAvailableOn,
  leisureOccurrencesOn,
  leisureSlotMatches,
} from './schedule.mjs';
import { leisureCostRange } from './content-facts.mjs';
export { leisureLocalInstant } from './schedule.mjs';
import { kyivDateKey, kyivClock } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { leisureIdentity, leisureReactionHidden, leisureDecisionIndex } from './identity.mjs';

const MINUTE = 60000,
  DAY = 86400000;
/** @param {any} input @param {number} nowMs */
export function normalizeLeisureWindow(input, nowMs) {
  if (!input || typeof input !== 'object') throw new Error('Обери дату й час для виходу.');
  const from = String(input.from ?? input.date ?? ''),
    to = String(input.to ?? from);
  const startTime = String(input.startTime ?? '17:30'),
    endTime = String(input.endTime ?? '22:00');
  const start = leisureLocalInstant(from, startTime),
    end = leisureLocalInstant(to, endTime);
  const count = Math.round((Date.parse(to + 'T12:00Z') - Date.parse(from + 'T12:00Z')) / DAY) + 1;
  if (count < 1 || count > 14) throw new Error('Обери від одного до 14 днів.');
  if (from < kyivDateKey(new Date(nowMs)))
    throw new Error('Для виходу обери сьогодні або майбутній день.');
  if (!['walk', 'car', 'transit'].includes(input.transport ?? 'car'))
    throw new Error('Обери спосіб пересування.');
  const budgetMinor =
    input.budgetMinor == null || input.budgetMinor === '' ? null : Number(input.budgetMinor);
  if (
    budgetMinor != null &&
    (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0 || budgetMinor > 100000000)
  )
    throw new Error('Перевір бюджет на двох.');
  const days = [];
  for (let date = from; date <= to; date = addDaysToDateKey(date, 1)) {
    const perDay = input.perDay?.[date] ?? {},
      a = leisureLocalInstant(date, perDay.startTime ?? startTime),
      b = leisureLocalInstant(date, perDay.endTime ?? endTime);
    if (b <= a) throw new Error('Завершення має бути пізніше початку в межах дня.');
    if (b - a > 16 * 60 * MINUTE) throw new Error('Обери до 16 годин для одного виходу.');
    days.push({ date, startAt: a, endAt: b });
  }
  if (!days.some((d) => d.endAt > nowMs) || start > end)
    throw new Error('Обери майбутній проміжок.');
  return {
    from,
    to,
    startTime,
    endTime,
    transport: input.transport ?? 'car',
    budgetMinor,
    pace: input.pace === 'relaxed' ? 'relaxed' : 'balanced',
    allowNew: input.allowNew === true,
    includeFamiliar: input.includeFamiliar === true,
    startLocation: String(input.startLocation ?? '')
      .trim()
      .slice(0, 200),
    days,
  };
}
/** @param {any} item @param {number} startMs @param {number} endMs @returns {boolean|null} */
export function leisureOpenDuring(item, startMs, endMs) {
  if (['CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY'].includes(item.placeDetails?.businessStatus))
    return false;
  const date = kyivDateKey(new Date(startMs));
  const current = item.placeDetails?.currentPeriods;
  if (Array.isArray(current) && date <= item.placeDetails?.currentHoursThrough) {
    const dated = current.filter((p) => p.open?.date && p.close?.date);
    if (dated.length) {
      return dated.some((p) => {
        const key = (/** @type {any} */ d) =>
          `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
        try {
          const a = leisureLocalInstant(
              key(p.open.date),
              `${String(p.open.hour ?? 0).padStart(2, '0')}:${String(p.open.minute ?? 0).padStart(2, '0')}`,
            ),
            b = leisureLocalInstant(
              key(p.close.date),
              `${String(p.close.hour ?? 0).padStart(2, '0')}:${String(p.close.minute ?? 0).padStart(2, '0')}`,
            );
          // Truncated current periods cannot prove a visit outside their known boundary.
          return startMs >= a && endMs <= b;
        } catch {
          return false;
        }
      });
    }
  }
  const periods = item.placeDetails?.periods ?? item.openingPeriods;
  if (!Array.isArray(periods) || !periods.length) return null;
  const weekday = new Date(date + 'T12:00Z').getUTCDay();
  const start =
    weekday * 1440 +
    Number(kyivClock(startMs).slice(0, 2)) * 60 +
    Number(kyivClock(startMs).slice(3));
  const end = start + (endMs - startMs) / MINUTE;
  for (const period of periods) {
    const open = period.open,
      close = period.close;
    if (!open || !Number.isInteger(open.day)) continue;
    if (!close) return true; // provider's 24/7 period
    let a = open.day * 1440 + Number(open.hour ?? 0) * 60 + Number(open.minute ?? 0),
      b = close.day * 1440 + Number(close.hour ?? 0) * 60 + Number(close.minute ?? 0);
    if (b <= a) b += 10080;
    if ((start >= a && end <= b) || (start + 10080 >= a && end + 10080 <= b)) return true;
  }
  return false;
}
/** @param {any} a @param {any} b */
export function leisureLegKey(a, b) {
  return [
    a.itemId,
    a.sessionId ?? '',
    b.itemId,
    b.sessionId ?? '',
    String(a.endAt ?? '').slice(0, 13),
  ].join('|');
}
/** @param {any} a @param {any} b */
function distance(a, b) {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null;
  const rad = Math.PI / 180,
    x = (b.lat - a.lat) * rad,
    y = (b.lon - a.lon) * rad;
  return (
    6371000 *
    2 *
    Math.atan2(
      Math.sqrt(
        Math.sin(x / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(y / 2) ** 2,
      ),
      Math.sqrt(
        1 -
          (Math.sin(x / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(y / 2) ** 2),
      ),
    )
  );
}
/** @param {any} item @param {number} start @param {number} end @param {any} [session] */
function stop(item, start, end, session = null) {
  return {
    itemId: item.id,
    sessionId: session?.id ?? null,
    title: item.title,
    category: item.category,
    address: session?.address || item.address || null,
    venueId: item.venueId ?? null,
    sourceUrl: session?.url || item.sourceUrl,
    lat: item.lat ?? null,
    lon: item.lon ?? null,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    tickets: false,
    reservation: false,
  };
}
/** Deterministic, bounded candidate generation; external facts are supplied by the service.
 * @param {any} workspace @param {any} raw @param {number} nowMs @param {any} [facts] */
export function buildLeisureSuggestions(workspace, raw, nowMs, facts = {}) {
  const window = normalizeLeisureWindow(raw, nowMs);
  if (
    raw.lockedStop &&
    (!raw.anchorId ||
      raw.lockedStop.itemId !== raw.anchorId ||
      !Number.isFinite(Date.parse(raw.lockedStop.startAt)) ||
      !Number.isFinite(Date.parse(raw.lockedStop.endAt)))
  )
    throw new Error('Перевір основну активність для заміни.');
  const records = /** @type {any[]} */ (workspace.records ?? []),
    items = /** @type {any[]} */ (workspace.items ?? []),
    lookup = new Map(items.map((i) => [i.id, i]));
  const decisions = leisureDecisionIndex(items, [
    ...(workspace.discoveryDecisions ?? []).map((/** @type {any} */ r) => ({
      ...r,
      kind: 'discovery',
    })),
    ...records,
  ]);
  const reactions = new Map(
    items.map((i) => [i.id, decisions.get(i.identityKey ?? leisureIdentity(i))]),
  );
  const saved = new Set(workspace.saved ?? []);
  const ranking = new Map(
    /** @type {any[]} */ (workspace.edition?.rankings ?? []).map((r) => [r.id, r.score]),
  );
  const visited = new Set(
    records
      .filter((r) => r.kind === 'visit' || (r.kind === 'familiarity' && !r.cleared))
      .map((r) => r.itemId),
  );
  const eligible = items.filter((i) => {
    const reaction = reactions.get(i.id);
    return (
      i.category !== 'podcast' &&
      !['cancelled', 'sold-out', 'postponed', 'schedule-pending'].includes(i.status) &&
      !leisureReactionHidden(reaction ?? {}, nowMs) &&
      (reaction?.verdict === 'interested' || saved.has(i.id) || window.allowNew) &&
      (!visited.has(i.id) || reaction?.revisit || window.includeFamiliar)
    );
  });
  if (
    raw.preferredFoodId &&
    !eligible.some((i) => i.id === raw.preferredFoodId && i.category === 'food')
  )
    throw new Error('Обери заклад із доступних варіантів.');
  const value = (/** @type {any} */ i) =>
    (reactions.get(i.id)?.interestLevel === 'priority'
      ? 45
      : reactions.get(i.id)?.verdict === 'interested'
        ? 20
        : 0) + Math.min(10, Number(ranking.get(i.id) ?? 0) / 5);
  const route = (/** @type {any} */ a, /** @type {any} */ b) => {
    const exact = facts.routes?.[leisureLegKey(a, b)];
    if (exact?.available)
      return { minutes: Math.ceil(exact.minutes), distanceM: exact.distanceM, verified: true };
    const metres = distance(a, b);
    return {
      minutes:
        metres == null
          ? 30
          : Math.max(
              5,
              Math.ceil(
                (metres /
                  (window.transport === 'walk' ? 65 : window.transport === 'car' ? 350 : 180)) *
                  1.4,
              ),
            ),
      distanceM: metres,
      verified: false,
    };
  };
  const days = window.days.map((day) => {
    const span = day.endAt - day.startAt,
      pause = window.pace === 'relaxed' ? 20 : 15;
    const candidates = /** @type {any[]} */ ([]),
      foods = eligible
        .filter((i) => i.category === 'food')
        .sort((a, b) => value(b) - value(a))
        .slice(0, 24);
    const onDate = (/** @type {any} */ i) => leisureAvailableOn(i, day.date);
    const add = (
      /** @type {string} */ title,
      /** @type {any[]} */ stops,
      /** @type {string} */ anchor,
    ) => {
      if (!stops.length) return;
      const sorted = [...stops].sort((a, b) => a.startAt.localeCompare(b.startAt));
      const warnings = [],
        weather = [],
        legs = [],
        reasons = [];
      let cost = 0,
        upperCost = 0,
        openUpper = false,
        unknown = 0,
        score = 0;
      for (const s of sorted) {
        const item = lookup.get(s.itemId),
          a = Date.parse(s.startAt),
          b = Date.parse(s.endAt);
        if (a < Math.max(day.startAt, nowMs) || b > day.endAt || b <= a) return;
        if (!leisureSlotMatches(item, a, b)) return;
        if (
          /** @type {any[]} */ (facts.calendarEvents ?? []).some(
            (e) => !e.transparent && e.startMs < b && e.endMs > a,
          )
        )
          return;
        const hours = leisureOpenDuring(item, a, b);
        if (hours === false) return;
        if (['food', 'place', 'trip'].includes(item.category) && hours == null)
          warnings.push('Години «' + item.title + '» потрібно підтвердити');
        if (
          !['food', 'place', 'trip', 'cinema'].includes(item.category) &&
          !item.endAt &&
          !item.durationMinutes &&
          !leisureOccurrencesOn(item, day.date).some(
            (o) => o.endAt && a >= o.startAt && b <= o.endAt,
          )
        )
          warnings.push('Тривалість «' + item.title + '» орієнтовна');
        if (
          item.startAt &&
          item.schedule?.kind !== 'recurring' &&
          kyivDateKey(new Date(item.startAt)) !== day.date
        )
          warnings.push('Години «' + item.title + '» саме цього дня потрібно підтвердити');
        if (!reactions.get(item.id) && !saved.has(item.id))
          warnings.push('Додано новий, ще не оцінений варіант');
        score += value(item);
        if (
          item.category === 'trip' ||
          /park|garden|hiking|campground/.test(item.placeType ?? '')
        ) {
          const area = /** @type {any[]} */ (facts.forecasts ?? []).find(
              (f) => (distance(item, f.at) ?? Infinity) < 30000,
            ),
            forecast = area?.days.find((/** @type {any} */ f) => f.date === day.date);
          if (forecast) {
            const hours = (area?.hourly ?? []).filter(
              (/** @type {any} */ h) => h.at < b && h.at + 3600000 > a,
            );
            const rain = hours.length
              ? Math.max(...hours.map((/** @type {any} */ h) => h.pop ?? 0))
              : forecast.pop;
            const wind = hours.length
              ? Math.max(...hours.map((/** @type {any} */ h) => h.wind ?? 0))
              : forecast.wind;
            const description = hours.length ? hours[0].desc : forecast.desc;
            const temps = hours.map((/** @type {any} */ h) => h.temp);
            weather.push(
              (hours.length
                ? Math.min(...temps) + '…' + Math.max(...temps)
                : forecast.min + '…' + forecast.max) +
                ' °C · ' +
                description +
                (hours.length ? ' · на час прогулянки' : ' · денний прогноз'),
            );
            if ((rain ?? 0) >= 0.5 || /дощ|гроза|злива|сніг|шторм/i.test(description)) {
              warnings.push(
                'Погода може ускладнити прогулянку: ' +
                  description +
                  (rain != null ? ' · імовірність опадів ' + Math.round(rain * 100) + '%' : ''),
              );
              score -= 15;
            }
            if (wind >= 10) {
              warnings.push('Сильний вітер: ' + Math.round(wind) + ' м/с');
              score -= 10;
            }
            if (
              forecast.sunset &&
              b > forecast.sunset &&
              /park|garden|hiking/.test(item.placeType ?? '')
            )
              warnings.push('Частина прогулянки припадає на час після заходу сонця');
            for (const alert of area?.alerts ?? [])
              if (alert.start < b && alert.end > a) {
                warnings.push('Попередження погоди: ' + alert.event);
                score -= 20;
              }
          } else
            warnings.push(
              Date.parse(day.date + 'T12:00Z') -
                Date.parse(kyivDateKey(new Date(nowMs)) + 'T12:00Z') >
                7 * DAY
                ? 'Прогноз погоди буде ближче до дати'
                : 'Прогноз погоди для цієї локації не підтверджений',
            );
        }
        if (reactions.get(item.id)?.interestLevel === 'priority')
          reasons.push('Твій пріоритет: ' + item.title);
        const session = /** @type {any[]} */ (item.sessions ?? []).find(
          (v) => v.id === s.sessionId,
        );
        const price = leisureCostRange(item, session);
        if (price.unknown) unknown++;
        cost += price.min;
        if (price.max == null) openUpper = true;
        else upperCost += price.max;
        if (price.approximate)
          warnings.push(
            'Ціни Google — приблизний орієнтир витрат, сума замовлення може відрізнятися',
          );
      }
      if (window.budgetMinor != null && cost > window.budgetMinor) return;
      if (unknown && window.budgetMinor != null)
        warnings.push('Частина цін невідома — відповідність бюджету ще не підтверджена');
      if (window.budgetMinor != null && !unknown && (openUpper || upperCost > window.budgetMinor))
        warnings.push('Верхня межа витрат може перевищити бюджет — перевір ціни перед вибором');
      if (window.transport !== 'walk')
        warnings.push(
          'Вартість дороги й паркування не врахована' +
            (window.budgetMinor != null ? ' — загальний бюджет ще не підтверджений' : ''),
        );
      if (facts.calendarAvailable === false) warnings.push('Календар не вдалося перевірити');
      for (let n = 1; n < sorted.length; n++) {
        const a = sorted[n - 1],
          b = sorted[n],
          travel = route(a, b),
          gap = (Date.parse(b.startAt) - Date.parse(a.endAt)) / MINUTE;
        if (gap < travel.minutes + pause) return;
        if (!travel.verified) warnings.push('Час дороги орієнтовний');
        if (
          /** @type {any[]} */ (facts.calendarEvents ?? []).some(
            (e) =>
              !e.transparent && e.startMs < Date.parse(b.startAt) && e.endMs > Date.parse(a.endAt),
          )
        )
          return;
        legs.push({
          from: a.itemId,
          to: b.itemId,
          minutes: travel.minutes,
          distanceM: travel.distanceM,
          verified: travel.verified,
        });
        score -= travel.minutes * 0.2;
      }
      if (window.startLocation) {
        for (const direction of ['outbound', 'return']) {
          const s = direction === 'outbound' ? sorted[0] : sorted.at(-1),
            travel = facts.boundaryRoutes?.[day.date + '|' + s.itemId + '|' + direction];
          const minutes = travel?.available ? Math.ceil(travel.minutes) : 30;
          const a =
              direction === 'outbound'
                ? Date.parse(s.startAt) - minutes * MINUTE
                : Date.parse(s.endAt),
            b =
              direction === 'outbound'
                ? Date.parse(s.startAt)
                : Date.parse(s.endAt) + minutes * MINUTE;
          if (a < Math.max(day.startAt, nowMs) || b > day.endAt) return;
          if (
            /** @type {any[]} */ (facts.calendarEvents ?? []).some(
              (e) => !e.transparent && e.startMs < b && e.endMs > a,
            )
          )
            return;
          if (!travel?.available)
            warnings.push(
              'Дорога ' +
                (direction === 'outbound' ? 'від місця старту' : 'назад') +
                ' орієнтовна: закладено 30 хв',
            );
          legs.push({
            from: direction === 'outbound' ? 'origin' : s.itemId,
            to: direction === 'outbound' ? s.itemId : 'origin',
            minutes,
            distanceM: travel?.distanceM ?? null,
            verified: travel?.available === true,
            boundary: direction,
          });
        }
      }
      if (sorted.some((s) => s.category === 'trip') && !window.startLocation)
        warnings.push('Укажи місце старту, щоб перевірити дорогу до поїздки й назад');
      score -= warnings.length * 3;
      if (!reasons.length) reasons.push('Із твоєї колекції цікавого');
      if (sorted.length > 1) reasons.push('Послідовні активності з часом на дорогу та паузу');
      const signature = leisureIdentity(lookup.get(anchor)) + '|' + day.date;
      const candidate = {
        id: 'suggestion-' + day.date + '-' + anchor,
        date: day.date,
        title,
        stops: sorted,
        legs,
        reasons: [...new Set(reasons)],
        warnings: [...new Set(warnings)],
        weather: [...new Set(weather)],
        knownCostMinor: cost,
        costRange: { min: cost, max: openUpper || unknown ? null : upperCost },
        unknownPrices: unknown,
        transport: window.transport,
        confidence: warnings.length ? 'needs-check' : 'checked',
        score: Math.round(score),
        signature,
        anchorId: anchor,
        alternatives: [],
      };
      const previous = candidates.findIndex((c) => c.signature === signature);
      if (previous < 0) candidates.push(candidate);
      else if (candidate.score > candidates[previous].score) candidates[previous] = candidate;
    };
    const withFood = (/** @type {any} */ item, /** @type {any} */ main, festival = false) => {
      if (
        raw.lockedStop &&
        item.id === raw.anchorId &&
        (main.startAt !== new Date(raw.lockedStop.startAt).toISOString() ||
          main.endAt !== new Date(raw.lockedStop.endAt).toISOString() ||
          (main.sessionId ?? null) !== (raw.lockedStop.sessionId ?? null))
      )
        return;
      if (!raw.preferredFoodId)
        add(festival ? 'Фестиваль без поспіху' : item.title, [main], item.id);
      if (festival) return;
      const nearby = [...foods]
        .filter((f) => f.id !== item.id && (!raw.preferredFoodId || f.id === raw.preferredFoodId))
        .sort(
          (a, b) =>
            value(b) -
            (distance(main, b) ?? 5000) / 500 -
            (value(a) - (distance(main, a) ?? 5000) / 500),
        )
        .slice(0, 6);
      for (const food of nearby) {
        const duration = (window.pace === 'relaxed' ? 90 : 60) * MINUTE;
        const dummy = stop(food, day.startAt, day.startAt + duration),
          travel = route(main, dummy).minutes + pause;
        const after = Date.parse(main.endAt) + travel * MINUTE;
        if (after + duration <= day.endAt)
          add(
            item.category === 'cinema'
              ? 'Кіно й час за столиком'
              : item.category === 'concert'
                ? 'Концерт і вечеря'
                : 'Враження й кава',
            [main, stop(food, after, after + duration)],
            item.id,
          );
        const before = Date.parse(main.startAt) - travel * MINUTE;
        if (before - duration >= Math.max(day.startAt, nowMs))
          add(
            item.category === 'concert' ? 'Вечеря перед концертом' : 'Зустріч і ' + item.title,
            [stop(food, before - duration, before), main],
            item.id,
          );
      }
    };
    const anchors = eligible
      .filter((i) => i.category !== 'food' && onDate(i) && (!raw.anchorId || i.id === raw.anchorId))
      .sort((a, b) => value(b) - value(a))
      .slice(0, 32);
    for (const item of anchors) {
      if (item.category === 'cinema' && item.sessions?.length) {
        for (const session of /** @type {any[]} */ (item.sessions ?? [])
          .filter((s) => kyivDateKey(new Date(s.startAt)) === day.date)
          .filter(
            (s) =>
              !workspace.settings?.cinemas ||
              workspace.settings.cinemas.includes(
                s.cinemaSlug === 'king-cross-leopolis' ? 'king-cross' : s.cinemaSlug,
              ),
          )
          .slice(0, 24)) {
          const a = Date.parse(session.startAt),
            b = session.endAt
              ? Date.parse(session.endAt)
              : item.durationMinutes
                ? a + item.durationMinutes * MINUTE
                : NaN;
          if (Number.isFinite(b) && a >= Math.max(day.startAt, nowMs) && b <= day.endAt)
            withFood(item, stop(item, a, b, session));
        }
      } else if (leisureOccurrencesOn(item, day.date).length) {
        for (const occurrence of leisureOccurrencesOn(item, day.date)) {
          const flexible = item.schedule?.timeMode === 'window';
          const a = flexible
            ? Math.max(occurrence.startAt, day.startAt, nowMs)
            : occurrence.startAt;
          const defaultEnd =
            a + (item.durationMinutes ?? (item.category === 'festival' ? 240 : 90)) * MINUTE;
          const b = flexible
            ? Math.min(occurrence.endAt ?? defaultEnd, defaultEnd, day.endAt)
            : (occurrence.endAt ?? defaultEnd);
          if (b - a < 30 * MINUTE) continue;
          withFood(item, stop(item, a, b), item.category === 'festival' && b - a >= span * 0.65);
        }
      } else {
        if (item.category === 'cinema') continue; // No guessed cinema sessions.
        const duration =
          (item.durationMinutes ??
            (item.category === 'festival'
              ? Math.min(span / MINUTE, 300)
              : item.category === 'trip'
                ? 180
                : 90)) * MINUTE;
        const origin = facts.boundaryRoutes?.[day.date + '|' + item.id + '|outbound'];
        const a =
          raw.lockedStop && raw.anchorId === item.id
            ? Date.parse(raw.lockedStop.startAt)
            : Math.max(day.startAt, Math.ceil(nowMs / (15 * MINUTE)) * 15 * MINUTE) +
              (window.startLocation
                ? (origin?.available ? Math.ceil(origin.minutes) : 30) * MINUTE
                : 0);
        if (a + duration <= day.endAt)
          withFood(
            item,
            stop(item, a, a + duration),
            item.category === 'festival' && duration >= span * 0.65,
          );
      }
    }
    // A quiet evening is a real option even when no fixed-time event is available.
    for (const food of foods.slice(0, 4)) {
      if (raw.anchorId) break;
      const origin = facts.boundaryRoutes?.[day.date + '|' + food.id + '|outbound'];
      const a =
          Math.max(day.startAt, Math.ceil(nowMs / (15 * MINUTE)) * 15 * MINUTE) +
          (window.startLocation
            ? (origin?.available ? Math.ceil(origin.minutes) : 30) * MINUTE
            : 0),
        duration = (window.pace === 'relaxed' ? 120 : 90) * MINUTE;
      if (a + duration <= day.endAt)
        add('Час разом у бажаному закладі', [stop(food, a, a + duration)], food.id);
    }
    candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const selected = [],
      families = new Set(),
      limit =
        candidates.filter((c) => c.stops.some((/** @type {any} */ s) => s.category !== 'food'))
          .length >= 4
          ? 5
          : 3;
    for (const c of candidates) {
      const anchor = lookup.get(c.anchorId),
        family = anchor.category === 'food' ? 'quiet-food' : leisureIdentity(anchor);
      if (families.has(family)) continue;
      families.add(family);
      c.alternatives = foods
        .filter((f) => !c.stops.some((/** @type {any} */ s) => s.itemId === f.id))
        .slice(0, 8)
        .map((f) => ({
          id: f.id,
          title: f.title,
          priority: reactions.get(f.id)?.interestLevel === 'priority',
        }));
      selected.push(c);
      if (selected.length === limit) break;
    }
    const cinemaPending =
      eligible.some((i) => i.category === 'cinema') &&
      !eligible.some(
        (i) =>
          i.category === 'cinema' &&
          /** @type {any[]} */ (i.sessions ?? []).some(
            (s) => kyivDateKey(new Date(s.startAt)) === day.date,
          ),
      );
    return {
      date: day.date,
      plans: selected,
      notes: [
        ...(cinemaPending ? ['Сеанси кіно на цей день ще не підтверджені'] : []),
        ...(!selected.length
          ? [
              'Немає придатних поєднань у цьому проміжку. Спробуй змінити години або дозволити нові місця.',
            ]
          : []),
      ],
    };
  });
  const best = days
    .filter((d) => d.plans.length)
    .sort((a, b) => b.plans[0].score - a.plans[0].score)[0];
  return {
    generatedAt: new Date(nowMs).toISOString(),
    window,
    days,
    recommendedDate: best?.date ?? null,
    recommendedReason: !best
      ? null
      : days.filter((d) => d.plans[0]?.score === best.plans[0].score).length > 1
        ? 'Можливості рівноцінні — можна обрати ранішу зручну дату.'
        : best.plans[0].reasons.slice(0, 2).join('. '),
    sources: workspace.edition?.sources ?? [],
    note: window.startLocation
      ? 'Враховано дорогу від місця старту й назад. Перед погодженням перевіримо актуальність плану.'
      : 'Час до першої зупинки й після останньої уточнюється окремо. Перед погодженням перевіримо актуальність плану.',
  };
}
