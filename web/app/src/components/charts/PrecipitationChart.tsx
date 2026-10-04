import { useState } from 'react';
import type { WeatherLocation } from '../../api/briefing-schema.ts';

/** Each bar is an actual provider hour. Unknown values remain unknown, never dry. */
export function PrecipitationChart({ hourly }: { hourly: NonNullable<WeatherLocation['hourly']> }) {
  const [index, setIndex] = useState(0);
  const [unit, setUnit] = useState<'chance' | 'mm'>('chance');
  const points = hourly.filter((p) => p.popPercent != null || p.precipMm != null);
  if (!points.length) return null;
  const selected = points[Math.min(index, points.length - 1)];
  const maximum = unit === 'chance' ? 100 : Math.max(1, ...points.map((p) => p.precipMm ?? 0));
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return (
    <section className="renewal-rain" aria-label="Погодинний прогноз опадів">
      <div className="flex items-center justify-between gap-2">
        <span className="renewal-eyebrow">ОПАДИ ПО ГОДИНАХ</span>
        <span className="text-xs text-info">{hour(selected.h)}</span>
      </div>
      <div className="renewal-segments mt-3" aria-label="Шкала опадів">
        <button aria-pressed={unit === 'chance'} onClick={() => setUnit('chance')}>
          Імовірність, %
        </button>
        <button aria-pressed={unit === 'mm'} onClick={() => setUnit('mm')}>
          Кількість, мм
        </button>
      </div>
      <div className="renewal-rain-bars">
        {points.map((p, i) => (
          <button
            key={p.at ?? `${p.h}-${i}`}
            type="button"
            onClick={() => setIndex(i)}
            aria-pressed={i === index}
            aria-label={`${hour(p.h)}: ${p.popPercent == null ? 'імовірність невідома' : `${p.popPercent}%`}${p.precipMm == null ? '' : `, ${p.precipMm.toFixed(1)} мм`}`}
            className="renewal-rain-slot"
          >
            <span
              style={{
                height: `${Math.max(2, (((unit === 'chance' ? p.popPercent : p.precipMm) ?? 0) / maximum) * 65)}px`,
                opacity: i === index ? 1 : 0.48,
              }}
            />
            {(i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 5) === 0) && (
              <small>{String(p.h).padStart(2, '0')}</small>
            )}
          </button>
        ))}
      </div>
      <input
        className="w-full accent-[var(--color-info)]"
        type="range"
        min={0}
        max={points.length - 1}
        value={Math.min(index, points.length - 1)}
        onChange={(e) => setIndex(Number(e.target.value))}
        aria-label="Година прогнозу опадів"
        aria-valuetext={hour(selected.h)}
      />
      <div className="flex flex-wrap justify-between gap-2 text-xs text-tx2" aria-live="polite">
        <span>
          Імовірність:{' '}
          <b>{selected.popPercent == null ? 'немає даних' : `${selected.popPercent}%`}</b>
        </span>
        <span>
          Кількість:{' '}
          <b>{selected.precipMm == null ? 'немає даних' : `${selected.precipMm.toFixed(1)} мм`}</b>
        </span>
      </div>
      <p className="mt-2 text-[11px] text-tx3">
        Погодинний прогноз ·{' '}
        {unit === 'chance' ? 'імовірність опадів' : 'кількість опадів за годину'}. Це не хвилинний
        прогноз тривалості дощу.
      </p>
    </section>
  );
}
