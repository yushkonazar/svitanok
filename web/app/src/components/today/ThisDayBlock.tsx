import { useId, useRef, useState, type CSSProperties } from 'react';
import type { OnThisDayData } from '../../api/briefing-schema.ts';
import { openLink, haptic } from '../../telegram.ts';
import { WORLD_LAND } from '../../lib/worldLand.ts';
import {
  fitHistoryMap,
  mapLongitude,
  zoomHistoryMap,
  historyPlaceVisible,
} from '../../lib/historyMap.ts';
import { usePresentation } from '../../lib/presentation.ts';
import { useReducedMotion } from '../../lib/useReducedMotion.ts';
import { useMapCamera } from '../../lib/useMapCamera.ts';
import { Explanation } from '../ui/Explanation.tsx';
import { pluralUk } from '../../lib/plural.ts';

export function ThisDayBlock({ d }: { d: OnThisDayData }) {
  const [selection, setSelection] = useState({ index: 0, revision: 0 });
  const [scrubbing, setScrubbing] = useState(false);
  const [anchor, setAnchor] = useState<{ lat: number; lon: number } | undefined>();
  const lastHaptic = useRef<number | null>(null);
  const { calm } = usePresentation();
  const reducedMotion = useReducedMotion();
  const motion = !calm && !reducedMotion;
  const [mappedOnly, setMappedOnly] = useState(false);
  const [zoom, setZoom] = useState(1);
  const landId = useId();
  const allEvents = [...d.events].sort((a, b) => a.year - b.year);
  const mappedCount = allEvents.filter((e) => e.location).length;
  const events = mappedOnly && mappedCount > 0 ? allEvents.filter((e) => e.location) : allEvents;
  const index = Math.min(selection.index, Math.max(0, events.length - 1));
  const event = events[index];
  const fitted = fitHistoryMap(events.flatMap((e) => (e.location ? [e.location] : [])));
  const validAnchor = events.some(
    (e) => e.location?.lat === anchor?.lat && e.location?.lon === anchor?.lon,
  )
    ? anchor
    : undefined;
  const box = zoomHistoryMap(fitted, zoom, validAnchor);
  const camera = useMapCamera(box, motion);
  const scale = box.width / 360;
  function handleSelect(next: number, timeStamp: number) {
    if (next === index || next < 0 || next >= events.length) return;
    setSelection((current) =>
      current.index === next ? current : { index: next, revision: current.revision + 1 },
    );
    const place = events[next].location;
    if (place && zoom > 1 && !historyPlaceVisible(box, place)) setAnchor(place);
    if (lastHaptic.current == null || timeStamp - lastHaptic.current >= 100) {
      haptic('light');
      lastHaptic.current = timeStamp;
    }
  }
  const progress = events.length > 1 ? (index / (events.length - 1)) * 100 : 0;
  const tickIndices = [...new Set([0, Math.floor((events.length - 1) / 2), events.length - 1])];
  if (!event) return null;
  return (
    <section className="renewal-card" data-history-motion={motion}>
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
      <div className="history-map relative overflow-hidden rounded-2xl border border-glassb">
        <svg
          ref={camera}
          viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
          data-map-width={box.width}
          className="block w-full"
          role="group"
          aria-label="Мапа місць історичних подій"
        >
          <defs>
            <path
              id={landId}
              d={WORLD_LAND}
              fill="var(--history-map-land)"
              stroke="var(--history-map-shore)"
              strokeWidth=".7"
              vectorEffect="non-scaling-stroke"
              fillRule="evenodd"
            />
          </defs>
          {[-360, 0, 360].map((offset) => (
            <use key={offset} href={`#${landId}`} transform={`translate(${offset},0)`} />
          ))}
          {events.map((e, i) => {
            const place = e.location;
            return (
              place && (
                <g
                  key={`${e.year}-${i}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${e.year}: ${place.label}`}
                  aria-pressed={index === i}
                  onClick={(e) => handleSelect(i, e.timeStamp)}
                  onKeyDown={(key) => {
                    if (key.key === 'Enter' || key.key === ' ') {
                      key.preventDefault();
                      handleSelect(i, key.timeStamp);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  {[-360, 0, 360].map((offset) => (
                    <g key={offset} transform={'translate(' + offset + ',0)'}>
                      <circle
                        cx={mapLongitude(place.lon, box)}
                        cy={90 - place.lat}
                        r={13 * scale}
                        fill="transparent"
                      />
                      <circle
                        cx={mapLongitude(place.lon, box)}
                        cy={90 - place.lat}
                        r={(index === i ? 6 : 3.5) * scale}
                        fill={index === i ? 'var(--color-a2)' : 'var(--color-a1)'}
                        fillOpacity={index === i ? 1 : 0.65}
                      />
                      {index === i && (
                        <circle
                          cx={mapLongitude(place.lon, box)}
                          cy={90 - place.lat}
                          r={11 * scale}
                          fill="none"
                          stroke="var(--color-a2)"
                          strokeOpacity=".4"
                          strokeWidth={scale}
                        />
                      )}
                      {index === i && selection.revision > 0 && motion && (
                        <circle
                          key={selection.revision}
                          cx={mapLongitude(place.lon, box)}
                          cy={90 - place.lat}
                          r={11 * scale}
                          fill="none"
                          stroke="var(--color-a2)"
                          strokeWidth={scale}
                          className="history-pin-pulse"
                          aria-hidden="true"
                        />
                      )}
                    </g>
                  ))}
                </g>
              )
            );
          })}
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
            onClick={() => {
              setAnchor(event.location);
              setZoom(Math.max(fitted.width / 360, zoom / 1.5));
            }}
          >
            −
          </button>
          <button
            type="button"
            className="renewal-link"
            onClick={() => {
              setZoom(1);
              setAnchor(undefined);
            }}
          >
            Усі події
          </button>
          <button
            type="button"
            className="renewal-secondary"
            aria-label="Наблизити мапу"
            disabled={box.width <= 10}
            onClick={() => {
              setAnchor(event.location);
              setZoom(Math.min(fitted.width / 10, zoom * 1.5));
            }}
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
                setSelection({ index: 0, revision: 0 });
                setZoom(1);
                setAnchor(undefined);
              }}
            />
            Лише події з місцем
          </label>
        )}
      </div>
      <div className="renewal-section-head mt-4">
        <strong
          key={selection.revision}
          className={
            'font-mono text-3xl text-a2' + (selection.revision ? ' history-content-enter' : '')
          }
        >
          {event.year}
        </strong>
        <span className="renewal-muted">
          {index + 1} / {events.length}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="renewal-button shrink-0"
          aria-label="Попередня історична подія"
          disabled={index === 0}
          onClick={(e) => handleSelect(index - 1, e.timeStamp)}
        >
          ‹
        </button>
        <label
          className="history-timeline flex-1 min-w-0"
          style={{ '--timeline-progress': progress + '%' } as CSSProperties}
        >
          <span className="sr-only">Подія на часовій стрічці</span>
          <input
            className="history-timeline-input"
            type="range"
            min="0"
            max={events.length - 1}
            step="1"
            value={index}
            disabled={events.length < 2}
            aria-valuetext={`${event.year}: ${event.text}`}
            onFocus={() => setScrubbing(true)}
            onBlur={() => setScrubbing(false)}
            onPointerDown={() => setScrubbing(true)}
            onPointerUp={() => setScrubbing(false)}
            onPointerCancel={() => setScrubbing(false)}
            onKeyDown={() => setScrubbing(true)}
            onInput={(e) => handleSelect(Number(e.currentTarget.value), e.timeStamp)}
            onChange={(e) => handleSelect(Number(e.target.value), e.timeStamp)}
          />
          {scrubbing && (
            <span
              className="history-timeline-tooltip"
              aria-hidden="true"
              style={{ left: progress + '%', transform: 'translateX(-' + progress + '%)' }}
            >
              {event.year}
            </span>
          )}
          {events.length > 1 && (
            <span className="history-timeline-ticks" aria-hidden="true">
              {tickIndices.map((i) => {
                const at = (i / (events.length - 1)) * 100;
                return (
                  <span key={i} style={{ left: at + '%', transform: 'translateX(-' + at + '%)' }}>
                    {events[i].year}
                  </span>
                );
              })}
            </span>
          )}
        </label>
        <button
          className="renewal-button shrink-0"
          aria-label="Наступна історична подія"
          disabled={index === events.length - 1}
          onClick={(e) => handleSelect(index + 1, e.timeStamp)}
        >
          ›
        </button>
      </div>
      <p className="text-sm leading-relaxed mt-3" aria-live="polite" aria-atomic="true">
        <span
          key={selection.revision}
          className={selection.revision ? 'history-content-enter' : undefined}
        >
          {event.text}
        </span>
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
            onClick={(event) => handleSelect(i, event.timeStamp)}
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
