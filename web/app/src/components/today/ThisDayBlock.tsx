import { useId, useState } from 'react';
import type { OnThisDayData } from '../../api/briefing-schema.ts';
import { openLink } from '../../telegram.ts';
import { WORLD_LAND } from '../../lib/worldLand.ts';
import { fitHistoryMap, mapLongitude, zoomHistoryMap } from '../../lib/historyMap.ts';
import { Explanation } from '../ui/Explanation.tsx';
import { pluralUk } from '../../lib/plural.ts';

export function ThisDayBlock({ d }: { d: OnThisDayData }) {
  const [selected, select] = useState(0);
  const [mappedOnly, setMappedOnly] = useState(false);
  const [zoom, setZoom] = useState(1);
  const landId = useId();
  const allEvents = [...d.events].sort((a, b) => a.year - b.year);
  const mappedCount = allEvents.filter((e) => e.location).length;
  const events = mappedOnly && mappedCount > 0 ? allEvents.filter((e) => e.location) : allEvents;
  const index = Math.min(selected, Math.max(0, events.length - 1));
  const event = events[index];
  const fitted = fitHistoryMap(events.flatMap((e) => (e.location ? [e.location] : [])));
  const box = zoomHistoryMap(fitted, zoom, event?.location);
  const scale = box.width / 360;
  if (!event) return null;
  return (
    <section className="renewal-card">
      <div className="renewal-section-head">
        <div>
          <p className="renewal-eyebrow mb-2">У ЦЕЙ ДЕНЬ</p>
          <h2 className="text-lg font-bold">День на мапі історії</h2>
        </div>
        <span className="renewal-muted">
          {events.length} {pluralUk(events.length, ['подія', 'події', 'подій'])}
        </span>
      </div>
      <Explanation className="mb-3">
        Події цього дня за роками. Обери позначку на мапі або пересунь часову стрічку — опис і
        джерело зміняться разом.
      </Explanation>
      <div className="relative overflow-hidden rounded-2xl border border-glassb bg-bg">
        <svg
          viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
          data-map-width={box.width}
          className="block w-full"
          role="group"
          aria-label="Мапа місць історичних подій"
        >
          <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="var(--color-bg)" />
          <defs>
            <path
              id={landId}
              d={WORLD_LAND}
              fill="color-mix(in srgb, var(--color-tx3) 18%, var(--color-bg2))"
              stroke="color-mix(in srgb, var(--color-tx2) 45%, transparent)"
              strokeWidth=".25"
              fillRule="evenodd"
            />
          </defs>
          {[-360, 0, 360].map((offset) => (
            <use key={offset} href={`#${landId}`} transform={`translate(${offset},0)`} />
          ))}
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
                    cx={mapLongitude(e.location.lon, box)}
                    cy={90 - e.location.lat}
                    r={13 * scale}
                    fill="transparent"
                  />
                  <circle
                    cx={mapLongitude(e.location.lon, box)}
                    cy={90 - e.location.lat}
                    r={(index === i ? 6 : 3.5) * scale}
                    fill={index === i ? 'var(--color-a2)' : 'var(--color-a1)'}
                    fillOpacity={index === i ? 1 : 0.65}
                  />
                  {index === i && (
                    <circle
                      cx={mapLongitude(e.location.lon, box)}
                      cy={90 - e.location.lat}
                      r={11 * scale}
                      fill="none"
                      stroke="var(--color-a2)"
                      strokeOpacity=".4"
                      strokeWidth={scale}
                    />
                  )}
                </g>
              ),
          )}
        </svg>
        {!event.location && (
          <p
            className="absolute bottom-2 inset-x-2 rounded-xl bg-bg2/95 px-3 py-2 text-xs text-tx2"
            role="status"
          >
            Для події {event.year} поки не вдалося визначити місце на мапі. Опис доступний нижче.
          </p>
        )}
      </div>
      {mappedCount > 0 && (
        <div className="history-map-controls">
          <button
            type="button"
            className="renewal-secondary"
            aria-label="Віддалити мапу"
            disabled={box.width >= 360}
            onClick={() => setZoom(Math.max(fitted.width / 360, zoom / 1.5))}
          >
            −
          </button>
          <button type="button" className="renewal-link" onClick={() => setZoom(1)}>
            Усі події
          </button>
          <button
            type="button"
            className="renewal-secondary"
            aria-label="Наблизити мапу"
            disabled={box.width <= 10}
            onClick={() => setZoom(Math.min(fitted.width / 10, zoom * 1.5))}
          >
            +
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-tx2">
        <span>
          З місцем: {mappedCount} / {allEvents.length}
        </span>
        {mappedCount > 0 && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="accent-a2"
              checked={mappedOnly}
              onChange={(e) => {
                setMappedOnly(e.target.checked);
                select(0);
              }}
            />
            Лише події з місцем
          </label>
        )}
      </div>
      <div className="renewal-section-head mt-4">
        <strong className="font-mono text-3xl text-a2">{event.year}</strong>
        <span className="renewal-muted">
          {index + 1} / {events.length}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="renewal-button shrink-0"
          aria-label="Попередня історична подія"
          disabled={index === 0}
          onClick={() => select(index - 1)}
        >
          ‹
        </button>
        <label className="block flex-1 min-w-0">
          <span className="sr-only">Подія на часовій стрічці</span>
          <input
            className="w-full accent-a2"
            type="range"
            min="0"
            max={events.length - 1}
            step="1"
            value={index}
            disabled={events.length < 2}
            aria-valuetext={`${event.year}: ${event.text}`}
            onInput={(e) => select(Number(e.currentTarget.value))}
            onChange={(e) => select(Number(e.target.value))}
          />
        </label>
        <button
          className="renewal-button shrink-0"
          aria-label="Наступна історична подія"
          disabled={index === events.length - 1}
          onClick={() => select(index + 1)}
        >
          ›
        </button>
      </div>
      <p className="text-sm leading-relaxed mt-3" aria-live="polite" aria-atomic="true">
        {event.text}
      </p>
      {event.location && (
        <p className="renewal-muted mt-2">
          {event.location.kind === 'associated_article' ? 'Пов’язане місце' : 'Місце події'} ·{' '}
          {event.location.label}
        </p>
      )}
      <Explanation className="mt-2">
        {event.location
          ? event.location.kind === 'event_place'
            ? `Місце проведення — ${event.location.label}. Позначка показує місце з джерела, не обов’язково точну адресу.`
            : event.location.kind === 'event'
              ? event.location.label
              : `Місце зі статті «${event.location.label}». Координати пов’язані зі статтею й можуть відрізнятися від точного місця події.`
          : 'Місце ще не визначено: у доступних даних немає однозначного зв’язку події з координатами.'}
      </Explanation>
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
