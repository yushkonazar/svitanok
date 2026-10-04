import { useState } from 'react';
import type { OnThisDayData } from '../../api/briefing-schema.ts';
import { openLink } from '../../telegram.ts';
import { WORLD_LAND } from '../../lib/worldLand.ts';

export function ThisDayBlock({ d }: { d: OnThisDayData }) {
  const [selected, select] = useState(0);
  const events = [...d.events].sort((a, b) => a.year - b.year);
  const index = Math.min(selected, Math.max(0, events.length - 1));
  const event = events[index];
  if (!event) return null;
  return (
    <section className="renewal-card">
      <div className="renewal-section-head">
        <div>
          <p className="renewal-eyebrow mb-2">У ЦЕЙ ДЕНЬ</p>
          <h2 className="text-lg font-bold">День на мапі історії</h2>
        </div>
        <span className="renewal-muted">{events.length} подій</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-glassb bg-bg">
        <svg
          viewBox="0 0 360 180"
          className="block w-full"
          role="group"
          aria-label="Мапа місць історичних подій"
        >
          <rect width="360" height="180" fill="var(--color-bg)" />
          <path
            d={WORLD_LAND}
            fill="color-mix(in srgb, var(--color-tx3) 18%, var(--color-bg2))"
            stroke="color-mix(in srgb, var(--color-tx2) 45%, transparent)"
            strokeWidth=".25"
            fillRule="evenodd"
          />
          {events.map(
            (e, i) =>
              e.location && (
                <g
                  key={`${e.year}-${i}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${e.year}: ${e.location.label}`}
                  aria-pressed={index === i}
                  onClick={() => select(i)}
                  onKeyDown={(key) => {
                    if (key.key === 'Enter' || key.key === ' ') {
                      key.preventDefault();
                      select(i);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <circle
                    cx={e.location.lon + 180}
                    cy={90 - e.location.lat}
                    r="11"
                    fill="transparent"
                  />
                  <circle
                    cx={e.location.lon + 180}
                    cy={90 - e.location.lat}
                    r={index === i ? 6 : 3.5}
                    fill={index === i ? 'var(--color-a2)' : 'var(--color-a1)'}
                    fillOpacity={index === i ? 1 : 0.65}
                  />
                  {index === i && (
                    <circle
                      cx={e.location.lon + 180}
                      cy={90 - e.location.lat}
                      r="11"
                      fill="none"
                      stroke="var(--color-a2)"
                      strokeOpacity=".4"
                    />
                  )}
                </g>
              ),
          )}
        </svg>
      </div>
      <div className="renewal-section-head mt-4">
        <strong className="font-mono text-3xl text-a2">{event.year}</strong>
        <span className="renewal-muted">
          {index + 1} / {events.length}
        </span>
      </div>
      <label className="block">
        <span className="sr-only">Подія на часовій стрічці</span>
        <input
          className="w-full accent-a2"
          type="range"
          min="0"
          max={events.length - 1}
          value={index}
          onChange={(e) => select(Number(e.target.value))}
        />
      </label>
      <p className="text-sm leading-relaxed mt-3">{event.text}</p>
      <p className="renewal-muted mt-2">
        {event.location
          ? event.location.kind === 'event'
            ? event.location.label
            : `Місце зі статті «${event.location.label}». Координати пов’язані зі статтею й можуть відрізнятися від точного місця події.`
          : 'Джерело не надало перевірених координат цієї події.'}
      </p>
      {event.url && (
        <button className="renewal-link mt-3" onClick={() => openLink(event.url!)}>
          Прочитати джерело ↗
        </button>
      )}
      {!!event.location && event.location.sourceUrl !== event.url && (
        <button className="renewal-link ml-3" onClick={() => openLink(event.location!.sourceUrl)}>
          Джерело місця ↗
        </button>
      )}
      <details className="mt-4">
        <summary className="renewal-link cursor-pointer">Усі події дня</summary>
        {events.map((e, i) => (
          <button
            key={`${e.year}-${i}`}
            className="renewal-list-row w-full text-left"
            onClick={() => select(i)}
            aria-pressed={i === index}
          >
            <b className="font-mono text-a2">{e.year}</b>
            <span className="text-xs leading-relaxed">{e.text}</span>
          </button>
        ))}
      </details>
      <p className="mt-3 text-[10px] text-tx3">Мапа: Natural Earth · public domain</p>
    </section>
  );
}
