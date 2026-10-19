import { kyivDateKey } from '../../kyiv-time.mjs';
import { leisureOpenDuring } from './planning.mjs';
/** Read-only comparison. A catalog refresh must never rewrite an approved outing.
 * @param {any} plan @param {any[]} items @param {number} nowMs */
export function leisurePlanChanges(plan, items, nowMs) {
  if (
    plan.discarded ||
    (plan.kind === 'plan' && plan.status !== 'planned') ||
    Date.parse(plan.endAt) <= nowMs
  )
    return [];
  const lookup = new Map(items.map((i) => [i.id, i])),
    changes = [];
  const statuses = /** @type {Record<string,string>} */ ({
    cancelled: 'скасовано',
    postponed: 'перенесено',
    'sold-out': 'квитки закінчилися',
  });
  for (const stop of plan.stops ?? []) {
    const item = lookup.get(stop.itemId),
      title = stop.title ?? item?.title ?? 'Варіант';
    if (!item) {
      changes.push(title + ': дані потребують повторної перевірки');
      continue;
    }
    if (['cancelled', 'postponed', 'sold-out'].includes(item.status))
      changes.push(title + ': ' + statuses[item.status]);
    const date = kyivDateKey(new Date(stop.startAt));
    if ((item.startDate && date < item.startDate) || (item.endDate && date > item.endDate))
      changes.push(title + ': змінилися дати');
    if (
      item.startAt &&
      item.startDate === item.endDate &&
      item.category !== 'cinema' &&
      Date.parse(item.startAt) !== Date.parse(stop.startAt)
    )
      changes.push(title + ': змінився час початку');
    if (
      stop.address &&
      item.address &&
      !stop.sessionId &&
      stop.address.trim() !== item.address.trim()
    )
      changes.push(title + ': змінилася адреса');
    if (item.source === 'Планета кіно' && stop.sessionId) {
      const session = item.sessions?.find((/** @type {any} */ s) => s.id === stop.sessionId);
      if (!session || Date.parse(session.startAt) !== Date.parse(stop.startAt))
        changes.push(title + ': обраний сеанс більше не підтверджений');
      else if (session.endAt && Date.parse(session.endAt) > Date.parse(stop.endAt))
        changes.push(title + ': потрібно більше часу на сеанс');
    }
    if (leisureOpenDuring(item, Date.parse(stop.startAt), Date.parse(stop.endAt)) === false)
      changes.push(title + ': зачинено в запланований час');
  }
  return [...new Set(changes)];
}
/** @param {any} previous @param {any} current */
export function leisureCatalogChanges(previous, current) {
  const changes = [];
  if (previous.status !== current.status) changes.push('Змінився статус');
  if (['startAt', 'endAt', 'startDate', 'endDate'].some((k) => previous[k] !== current[k]))
    changes.push('Оновлено дати й час');
  const sessions = (/** @type {any} */ item) =>
    JSON.stringify(
      (item.sessions ?? [])
        .map((/** @type {any} */ s) => [s.id, s.startAt, s.endAt])
        .sort((/** @type {any[]} */ a, /** @type {any[]} */ b) =>
          String(a[0]).localeCompare(String(b[0])),
        ),
    );
  if (sessions(previous) !== sessions(current)) changes.push('Оновлено сеанси');
  if (previous.address !== current.address) changes.push('Змінилася адреса');
  return changes;
}
