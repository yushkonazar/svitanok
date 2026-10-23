// The viewer is deployed on a separate static origin with no app bindings or credentials.
(() => {
  const ownUrl = new URL(window.location.href);
  let appOrigin = 'https://svitanok.yushko.dev';
  if (document.referrer && ['localhost', '127.0.0.1'].includes(ownUrl.hostname)) {
    const referrer = new URL(document.referrer);
    if (['localhost', '127.0.0.1'].includes(referrer.hostname) && referrer.port === ownUrl.port)
      appOrigin = referrer.origin;
  }
  const pins = new Map();
  let configured = false,
    parentOrigin = '',
    timeout;
  const notify = (type, extra = {}) => window.parent.postMessage({ type, ...extra }, parentOrigin);
  const fail = () => {
    clearTimeout(timeout);
    if (parentOrigin) notify('svitanok-map-error');
  };
  window.addEventListener('message', (event) => {
    // Only this document's embedding app may provide a key or read marker interactions.
    if (event.source !== window.parent || !event.data || event.origin !== appOrigin) return;
    const message = event.data;
    if (message.type === 'svitanok-map-active' && event.origin === parentOrigin) {
      pins.forEach((button, id) => button.classList.toggle('is-active', id === message.id));
      return;
    }
    if (
      configured ||
      message.type !== 'svitanok-map-config' ||
      typeof message.key !== 'string' ||
      typeof message.mapId !== 'string' ||
      !message.center ||
      !Number.isFinite(message.center.lat) ||
      !Number.isFinite(message.center.lon)
    )
      return;
    if (document.referrer && new URL(document.referrer).origin !== event.origin) return;
    configured = true;
    parentOrigin = event.origin;
    timeout = setTimeout(fail, 20_000);
    window.gm_authFailure = fail;
    window.svitanokMapReady = () => {
      try {
        const maps = window.google.maps;
        const map = new maps.Map(document.getElementById('map'), {
          center: { lat: message.center.lat, lng: message.center.lon },
          zoom: 12,
          mapId: message.mapId,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'cooperative',
        });
        const bounds = new maps.LatLngBounds();
        const points = Array.isArray(message.markers) ? message.markers.slice(0, 36) : [];
        for (const point of points) {
          if (
            !Number.isFinite(point.lat) ||
            !Number.isFinite(point.lon) ||
            typeof point.id !== 'string'
          )
            continue;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'pin';
          button.textContent = String(point.label ?? point.title).slice(0, 160);
          button.setAttribute('aria-label', String(point.title));
          button.classList.toggle('is-active', point.id === message.activeId);
          button.addEventListener('click', () => notify('svitanok-map-pick', { id: point.id }));
          pins.set(point.id, button);
          bounds.extend({ lat: point.lat, lng: point.lon });
          new maps.marker.AdvancedMarkerElement({
            map,
            position: { lat: point.lat, lng: point.lon },
            title: point.title,
            content: button,
          });
        }
        if (typeof message.polyline === 'string' && message.polyline.length <= 100_000) {
          const path = maps.geometry.encoding.decodePath(message.polyline);
          path.forEach((point) => bounds.extend(point));
          new maps.Polyline({ map, path, strokeColor: '#e76f51', strokeWeight: 4 });
          map.fitBounds(bounds, 40);
        } else if (points.length > 1) map.fitBounds(bounds, 40);
        else if (points[0]) {
          map.panTo({ lat: points[0].lat, lng: points[0].lon });
          map.setZoom(14);
        }
        clearTimeout(timeout);
        notify('svitanok-map-ready');
      } catch {
        fail();
      }
    };
    const script = document.createElement('script'),
      url = new URL('https://maps.googleapis.com/maps/api/js');
    url.search = new URLSearchParams({
      key: message.key,
      v: 'quarterly',
      language: 'uk',
      loading: 'async',
      libraries: 'marker,geometry',
      callback: 'svitanokMapReady',
    }).toString();
    script.src = url.href;
    script.async = true;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.onerror = fail;
    document.head.appendChild(script);
  });
})();
