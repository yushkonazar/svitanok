import type { StateStore } from './types.js';
interface Plan {
  month: string;
  dates: Record<string, string>;
}
interface Seen {
  date: string;
  id: string;
}
/** Monthly reviewed-content queue. Never invents facts; daily retries keep their chosen item.
 * A finite reviewed pool cycles only after unused entries have been consumed. */
export function monthlyContent<T extends { sourceUrl: string }>(
  kind: string,
  date: string,
  catalog: T[],
  state: StateStore | undefined,
  idOf: (item: T) => string,
  fallback: (date: string) => T | null,
): T | null {
  if (!state || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fallback(date);
  const byId = new Map(catalog.map((n) => [idOf(n), n]));
  const history = state.get<Seen[]>(`dailyContentHistory:${kind}`) ?? [];
  const existing = history.find((n) => n.date === date);
  if (existing && byId.has(existing.id)) return byId.get(existing.id)!;
  const month = date.slice(0, 7);
  let plan = state.get<Plan>(`dailyContentPlan:${kind}`);
  if (plan?.month !== month) {
    const [year, monthNumber] = month.split('-').map(Number);
    const length = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
    const recent = new Map(history.map((n) => [n.id, n.date]));
    const dates: Record<string, string> = {};
    const used = new Set<string>();
    let previousSource = '';
    for (let day = 1; day <= length; day++) {
      const key = `${month}-${String(day).padStart(2, '0')}`;
      const remaining = catalog.filter((n) => !used.has(idOf(n)));
      const unseen = remaining.filter((n) => !recent.has(idOf(n)));
      const pool = unseen.length ? unseen : remaining;
      const varied = pool.filter((n) => n.sourceUrl !== previousSource);
      const candidates = varied.length ? varied : pool;
      candidates.sort(
        (a, b) =>
          (recent.get(idOf(a)) ?? '').localeCompare(recent.get(idOf(b)) ?? '') ||
          idOf(a).localeCompare(idOf(b)),
      );
      const baseline = fallback(key);
      const item =
        !history.length && baseline && !used.has(idOf(baseline)) ? baseline : candidates[0];
      if (!item) break;
      dates[key] = idOf(item);
      used.add(idOf(item));
      previousSource = item.sourceUrl;
    }
    plan = { month, dates };
    state.set(`dailyContentPlan:${kind}`, plan);
  }
  const item = byId.get(plan.dates[date] ?? '') ?? fallback(date);
  if (item)
    state.set(
      `dailyContentHistory:${kind}`,
      [...history.filter((n) => n.date !== date), { date, id: idOf(item) }]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-365),
    );
  return item;
}
