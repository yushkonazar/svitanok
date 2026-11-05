import { adaptiveDay, adaptiveMetrics } from './adaptive-observations.mjs';
/** Append to a fresh period bucket, once per logical day. Text is counted,
 * never copied into the long-term archive. @param {KvBlob} target @param {string} date @param {KvBlob} record */
export function appendStateArchive(target, date, record) {
  const day = adaptiveDay(date, record),
    confirmed = ['morning', 'afternoon', 'evening'].filter(
      (s) => /** @type {KvBlob} */ (day)[s].confirmed,
    ).length;
  if (!confirmed) return;
  const metrics = adaptiveMetrics([day]),
    observations = target.observationsV3 ?? {
      metrics: {},
      days: 0,
      confirmedSlots: 0,
      from: date,
      to: date,
    };
  observations.days = (observations.days ?? 0) + 1;
  observations.confirmedSlots = (observations.confirmedSlots ?? 0) + confirmed;
  observations.from = observations.from && observations.from < date ? observations.from : date;
  observations.to = observations.to && observations.to > date ? observations.to : date;
  for (const [key, value] of Object.entries(metrics)) {
    const prior = observations.metrics[key] ?? {
      n: 0,
      counts: {},
      sum: 0,
      numericN: 0,
      average: null,
      labels: {},
      labelCounts: {},
    };
    prior.n += value.n;
    prior.sum += value.sum ?? 0;
    prior.numericN += value.numericN ?? 0;
    prior.average = prior.numericN ? prior.sum / prior.numericN : null;
    prior.labels ??= {};
    prior.labelCounts ??= {};
    const [slot, field] = key.split('.');
    for (const [id, count] of Object.entries(value.counts ?? {})) {
      prior.counts[id] = (prior.counts[id] ?? 0) + Number(count);
      const label = record[slot ?? '']?.optionLabelsV4?.[field ?? '']?.[id] ?? value.labels?.[id];
      if (typeof label !== 'string') continue;
      prior.labels[id] = label;
      const variants = prior.labelCounts[id] ?? {};
      variants[label] = (variants[label] ?? 0) + Number(count);
      prior.labelCounts[id] = variants;
    }
    prior.label = value.label;
    observations.metrics[key] = prior;
  }
  target.observationsV3 = observations;
}
/** Complete archive months remain authoritative. Only a fully covered month,
 * or the current growing month, may be supplied from primary records.
 * @param {KvBlob[]} months @param {KvBlob} records @param {string} from @param {string} to */
export function stateHistoryMonths(months, records, from, to) {
  const current = to.slice(0, 7),
    map = new Map(
      months
        .filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m.month) && m.month <= current)
        .map((m) => [m.month, { ...m }]),
    );
  /** @type {KvBlob} */ const fresh = {};
  for (const [date, record] of Object.entries(records)) {
    if (date > to || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const month = date.slice(0, 7);
    const target = fresh[month] ?? { month };
    appendStateArchive(target, date, record);
    fresh[month] = target;
  }
  for (const [month, bucket] of Object.entries(fresh)) {
    if (!bucket.observationsV3) continue;
    const fullStart = `${month}-01`,
      next = new Date(fullStart + 'T12:00:00Z');
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(0);
    const fullEnd = next.toISOString().slice(0, 10),
      covered = !!from && from <= fullStart && (month === current || fullEnd <= to);
    const prior = map.get(month);
    if ((prior?.observationsV3 && month !== current) || !covered) continue;
    if (
      prior?.observationsV3 &&
      (prior.observationsV3.confirmedSlots ?? 0) > bucket.observationsV3.confirmedSlots
    )
      continue;
    map.set(month, { ...prior, month, observationsV3: bucket.observationsV3 });
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}
/** @param {KvBlob} month @param {string} id */
function monthValue(month, id) {
  const metrics = month.observationsV3?.metrics ?? {};
  /** @type {{sum:number,n:number}[]} */ const parts = [];
  if (id === 'energy' || id === 'mood')
    for (const slot of ['morning', 'afternoon', 'evening']) {
      const m = metrics[`${slot}.${id}`];
      parts.push({ sum: m?.sum ?? 0, n: m?.numericN ?? 0 });
    }
  else if (id === 'sleep') {
    const sum =
      ['V3', 'V4'].reduce((s, v) => s + (metrics[`morning.sleepMinutes${v}`]?.sum ?? 0), 0) / 60;
    const n = ['V3', 'V4'].reduce(
      (s, v) =>
        s +
        (metrics[`morning.sleepMinutes${v}`]?.numericN ?? 0) +
        (metrics[`morning.sleepMode${v}`]?.counts?.none ?? 0),
      0,
    );
    parts.push({ sum, n });
  } else
    for (const version of ['V3', 'V4']) {
      const m = metrics[`evening.satisfaction${version}`];
      parts.push({ sum: m?.sum ?? 0, n: m?.numericN ?? 0 });
    }
  const known = parts.filter((p) => p.n > 0),
    n = parts.reduce((s, p) => s + p.n, 0);
  // Slot-balanced state ratings; numeric means for sleep and satisfaction.
  const value =
    id === 'energy' || id === 'mood'
      ? known.length
        ? known.reduce((s, p) => s + p.sum / p.n, 0) / known.length
        : null
      : n
        ? known.reduce((s, p) => s + p.sum, 0) / n
        : null;
  return { value, n, parts };
}
/** Weighted from sums and denominators, never averages of monthly averages.
 * @param {KvBlob[]} months @param {string} id @param {string} to @param {'all'|'year'} [range] */
export function stateHistorySeries(months, id, to, range = 'all') {
  const selected = months.filter(
    (m) => m.month <= to.slice(0, 7) && (range === 'all' || m.month.slice(0, 4) === to.slice(0, 4)),
  );
  const series = selected.map((m) => ({
    month: m.month,
    date: `${m.month}-01`,
    ...monthValue(m, id),
  }));
  const width = Math.max(0, ...series.map((m) => m.parts.length));
  const totals = Array.from({ length: width }, (_, i) =>
    series.reduce(
      (p, m) => ({ sum: p.sum + (m.parts[i]?.sum ?? 0), n: p.n + (m.parts[i]?.n ?? 0) }),
      { sum: 0, n: 0 },
    ),
  );
  const known = totals.filter((p) => p.n > 0),
    n = totals.reduce((s, p) => s + p.n, 0);
  const value =
    id === 'energy' || id === 'mood'
      ? known.length
        ? known.reduce((s, p) => s + p.sum / p.n, 0) / known.length
        : null
      : n
        ? totals.reduce((s, p) => s + p.sum, 0) / n
        : null;
  const observed = series.filter((item) => item.n > 0);
  return { series, value, n, from: observed[0]?.month ?? null, to: observed.at(-1)?.month ?? null };
}
