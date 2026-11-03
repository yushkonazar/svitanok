export type MapBox = { x: number; y: number; width: number; height: number };
type Place = { lat: number; lon: number };
export function historyPlaceVisible(box: MapBox, place: Place) {
  const x = mapLongitude(place.lon, box),
    y = 90 - place.lat;
  return (
    x >= box.x + box.width * 0.12 &&
    x <= box.x + box.width * 0.88 &&
    y >= box.y + box.height * 0.12 &&
    y <= box.y + box.height * 0.88
  );
}
const world: MapBox = { x: 0, y: 0, width: 360, height: 180 };
/** Smallest longitude arc, including events on either side of the date line. */
export function fitHistoryMap(places: Place[]): MapBox {
  const valid = places.filter(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lon) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lon) <= 180,
  );
  if (!valid.length) return world;
  const xs = valid.map((p) => p.lon + 180).sort((a, b) => a - b);
  let gap = -1,
    start = xs[0]!;
  xs.forEach((x, i) => {
    const next = xs[(i + 1) % xs.length]! + (i === xs.length - 1 ? 360 : 0);
    if (next - x > gap) {
      gap = next - x;
      start = xs[(i + 1) % xs.length]!;
    }
  });
  const unwrapped = xs.map((x) => (x < start ? x + 360 : x));
  const ys = valid.map((p) => 90 - p.lat);
  const lo = Math.min(...unwrapped),
    hi = Math.max(...unwrapped),
    top = Math.min(...ys),
    bottom = Math.max(...ys);
  const width = Math.min(360, Math.max(40, (hi - lo) * 1.3 + 12, (bottom - top) * 2.6 + 12));
  if (width >= 280) return world;
  const height = width / 2,
    centerY = Math.min(180 - height / 2, Math.max(height / 2, (top + bottom) / 2));
  return { x: (lo + hi - width) / 2, y: centerY - height / 2, width, height };
}
export function mapLongitude(lon: number, box: MapBox) {
  const x = lon + 180,
    center = box.x + box.width / 2;
  return x + 360 * Math.round((center - x) / 360);
}
export function zoomHistoryMap(box: MapBox, zoom: number, place?: Place): MapBox {
  const width = Math.min(360, Math.max(10, box.width / zoom)),
    height = width / 2;
  const centerX = place && zoom > 1 ? mapLongitude(place.lon, box) : box.x + box.width / 2;
  const centerY = Math.max(
    height / 2,
    Math.min(180 - height / 2, place && zoom > 1 ? 90 - place.lat : box.y + box.height / 2),
  );
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}
