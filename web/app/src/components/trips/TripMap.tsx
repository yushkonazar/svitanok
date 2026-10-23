import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchTripMap } from '../../api/trips.ts';
import { openLink } from '../../telegram.ts';

/** Only our separate static map host may receive a browser key. Never use a same-origin frame. */
export function trustedMapFrame(value?: string) {
  try {
    const url = new URL(value ?? '');
    if (url.username || url.password || url.origin === window.location.origin) return '';
    const production = url.href === 'https://maps.svitanok.yushko.dev/travel-map.html';
    const local =
      ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.port === window.location.port &&
      url.protocol === 'http:' &&
      url.pathname === '/app/travel-map.html';
    return production || local ? url.href : '';
  } catch {
    return '';
  }
}

/** Cross-origin isolation preserves the owner's session while allowing Google's nested frames. */
export function TripMap({
  id,
  kind,
  version,
  activeId,
  focusId,
  onPick,
}: {
  id: string;
  kind: string;
  version: string;
  activeId?: string;
  focusId?: string;
  onPick?: (id: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [mapError, setMapError] = useState(''),
    [ready, setReady] = useState(false);
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['travel-map', id, kind, version, focusId],
    queryFn: ({ signal }) => fetchTripMap(id, kind, signal, focusId),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const frameUrl = trustedMapFrame(data?.frame_url),
    frameOrigin = frameUrl ? new URL(frameUrl).origin : '';
  useEffect(() => {
    const deadline = data?.enabled
      ? setTimeout(
          () =>
            setMapError('Мапа не встигла завантажитися. Відкрий Google Maps за посиланням нижче.'),
          25_000,
        )
      : null;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== frameOrigin ||
        !event.data
      )
        return;
      if (event.data.type === 'svitanok-map-ready') {
        if (deadline) clearTimeout(deadline);
        setReady(true);
      }
      if (event.data.type === 'svitanok-map-error')
        setMapError('Не вдалося завантажити Google Maps. Можна відкрити зовнішню мапу.');
      if (
        event.data.type === 'svitanok-map-pick' &&
        data?.markers?.some((p) => p.id === event.data.id)
      )
        onPick?.(event.data.id);
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      if (deadline) clearTimeout(deadline);
    };
  }, [data, onPick, frameOrigin]);
  useEffect(() => {
    if (frameOrigin)
      frame.current?.contentWindow?.postMessage(
        { type: 'svitanok-map-active', id: activeId },
        frameOrigin,
      );
  }, [activeId, frameOrigin]);
  if (isPending)
    return (
      <p className="journey-map-note" role="status">
        Завантажую мапу…
      </p>
    );
  if (error)
    return (
      <div className="journey-map-note" role="alert">
        {error.message}
        <button onClick={() => void refetch()}>Спробувати ще раз</button>
      </div>
    );
  if (!data) return null;
  return (
    <section className="journey-map" aria-label="Мапа подорожі">
      {data.enabled && frameUrl && !mapError && (
        <>
          {!ready && <p role="status">Завантажую Google Maps…</p>}
          <iframe
            ref={frame}
            title="Google Maps"
            className="journey-map-canvas"
            src={frameUrl}
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() =>
              frame.current?.contentWindow?.postMessage(
                {
                  type: 'svitanok-map-config',
                  key: data.api_key,
                  mapId: data.map_id,
                  center: data.center,
                  activeId,
                  markers: data.markers?.map(({ id, title, label, lat, lon }) => ({
                    id,
                    title,
                    label,
                    lat,
                    lon,
                  })),
                  polyline: data.route?.polyline,
                },
                frameOrigin,
              )
            }
          />
        </>
      )}
      <p className="journey-map-note">
        {mapError ||
          (data.enabled && !frameUrl
            ? 'Адресу вбудованої мапи потрібно налаштувати. Можна відкрити Google Maps.'
            : data.message || data.caption)}
      </p>
      {data.route && (
        <p className="journey-map-note">
          ≈ {Math.round(data.route.distance_m / 1000)} км ·{' '}
          {Math.floor(data.route.duration_min / 60)} год {data.route.duration_min % 60} хв
          автомобілем, без окремої оцінки кордону.
        </p>
      )}
      {!!data.missing?.length && (
        <details>
          <summary>Не всі точки вдалося позначити ({data.missing.length})</summary>
          <ul>
            {data.missing.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </details>
      )}
      <button className="journey-text-button" onClick={() => openLink(data.external_url)}>
        Відкрити Google Maps ↗
      </button>
    </section>
  );
}
