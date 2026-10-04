import type { Stats, CheckinPoint } from '../../api/schema.ts';
import { shiftDate } from '../../../../core/finance/planning.mjs';

const METRICS = ['energy', 'mood', 'sleepH', 'dayScore'] as const;
type Metric = (typeof METRICS)[number];
const TITLES: Record<Metric, string> = {
  energy: 'Енергія',
  mood: 'Настрій',
  sleepH: 'Сон',
  dayScore: 'Оцінка дня',
};
const UNITS: Record<Metric, string> = {
  energy: '/ 5',
  mood: '/ 5',
  sleepH: 'год',
  dayScore: '/ 5',
};
function value(p: CheckinPoint, metric: Metric) {
  if (metric !== 'mood') return p[metric];
  const observed = p.moodCurve.filter((n): n is number => n !== null);
  return observed.length ? observed.reduce((a, b) => a + b, 0) / observed.length : null;
}
export function PeriodReview({
  s,
  days,
  setDays,
}: {
  s: Stats;
  days: number;
  setDays: (n: number) => void;
}) {
  const ordered = [...s.checkinSeries].sort((a, b) => a.d.localeCompare(b.d));
  const end = s.checkinRaw.to || ordered.at(-1)?.d;
  if (!end)
    return (
      <section className="renewal-card renewal-muted">
        Перші відповіді чек-іну відкриють історію стану. Пропуск не вважається нулем.
      </section>
    );
  const start = shiftDate(end, -days + 1),
    priorStart = shiftDate(start, -days);
  const current = ordered.filter((p) => p.d >= start && p.d <= end);
  const previous = ordered.filter((p) => p.d >= priorStart && p.d < start);
  const stats = (rows: CheckinPoint[], key: Metric) => {
    const values = rows.map((p) => value(p, key)).filter((n): n is number => n !== null);
    return {
      n: values.length,
      mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    };
  };
  return (
    <section className="renewal-card">
      <div className="renewal-section-head flex-wrap gap-2">
        <h2 className="text-lg font-bold">Що змінюється?</h2>
        <div className="renewal-segments">
          {[7, 30, 90].map((n) => (
            <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>
              {n}д
            </button>
          ))}
        </div>
      </div>
      <p className="renewal-muted">
        {start} — {end}. Порівняння з попередніми {days} днями.
      </p>
      <div className="renewal-metrics">
        {METRICS.map((m) => {
          const a = stats(current, m),
            b = stats(previous, m),
            delta = a.mean == null || b.mean == null ? null : a.mean - b.mean;
          return (
            <div className="renewal-metric text-left" key={m}>
              <span className="renewal-muted">{TITLES[m]}</span>
              <strong>
                {a.mean == null
                  ? '—'
                  : a.mean.toLocaleString('uk-UA', { maximumFractionDigits: 1 })}{' '}
                <small className="text-xs text-tx3">{UNITS[m]}</small>
              </strong>
              <small className="text-xs text-tx2">
                {delta == null
                  ? 'Ще немає бази порівняння'
                  : `${delta > 0 ? '↑ +' : delta < 0 ? '↓ ' : ''}${delta.toLocaleString('uk-UA', { maximumFractionDigits: 1 })} до попереднього періоду`}
              </small>
              <small className="text-[10px] text-tx3">
                {a.n} / {days} днів із відповіддю
              </small>
            </div>
          );
        })}
      </div>
      <details className="mt-3">
        <summary className="renewal-link cursor-pointer">Як читати ці числа</summary>
        <p className="renewal-muted mt-2">
          Енергія й настрій — середнє заповнених слотів доби. Пропуски не знижують середнє; число
          відповідей показує повноту. Різниця між періодами описує твої записи й не доводить причину
          змін.
        </p>
      </details>
    </section>
  );
}
