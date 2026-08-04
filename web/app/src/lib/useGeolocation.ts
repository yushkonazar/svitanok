import { useEffect, useState } from 'react';

export interface GeoCoords {
  lat: number;
  lon: number;
}

const STORAGE_KEY = 'svitanok:lastGeo';
// 2 знаки після коми ≈ до 1.1км (лишає — по довготі на широті України ще
// менше) — містова точність: гасить GPS/мережевий джиттер між замірами
// (typical accuracy 20-500м без enableHighAccuracy), але ловить реальний
// переїзд в інше місце. Те саме округлене значення йде і в queryKey
// useLiveWeather — «збігається» означає буквально «не змінилось».
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function readStored(): GeoCoords | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.lat === 'number' && typeof parsed?.lon === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(coords: GeoCoords | null): void {
  try {
    if (coords) localStorage.setItem(STORAGE_KEY, JSON.stringify(coords));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* приватний режим/квота сховища — тихо ігноруємо, це лише кеш зручності */
  }
}

/**
 * Координати браузера з памʼяттю між відкриттями (Блок «Погода»). Дозвіл на
 * геолокацію в Telegram Mini App «діє постійно» лише номінально — WebView
 * часто перестворюється при кожному відкритті, і холодний getCurrentPosition
 * (мережева/GPS локація) не завжди встигає відповісти за swift повторний
 * захід. Без памʼяті це виглядало як збій: людина, що вже дала дозвіл,
 * замість своєї локації бачила дефолтний Львів зі старим кешованим числом
 * (KV weatherLive, до 30 хв) — geo лишався null на весь сеанс.
 *
 * Тепер: на монтуванні ОДРАЗУ повертаємо останню збережену позицію (лінивий
 * useState) — жодного вікна з дефолтним фолбеком для того, хто вже дозволяв.
 * Паралельно тихо перепитуємо свіжий фікс; збігається в межах ~1км —
 * нічого не міняємо (не тригеримо зайвий рефетч погоди); відрізняється —
 * оновлюємо і стан, і localStorage. PERMISSION_DENIED (реальне відкликання
 * дозволу, на відміну від транзиєнтного таймауту/POSITION_UNAVAILABLE) чистить
 * збережене — інакше застаріле місце показувалось би вічно.
 */
export function useGeolocation(): GeoCoords | null {
  const [coords, setCoords] = useState<GeoCoords | null>(readStored);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        const next = { lat: round(pos.coords.latitude), lon: round(pos.coords.longitude) };
        setCoords((prev) => {
          if (prev && prev.lat === next.lat && prev.lon === next.lon) return prev;
          writeStored(next);
          return next;
        });
      },
      (err) => {
        if (cancelled) return;
        if (err.code === 1 /* PERMISSION_DENIED */) {
          writeStored(null);
          setCoords(null);
        }
        /* POSITION_UNAVAILABLE/TIMEOUT — транзиєнтне, лишаємось на останній
           відомій позиції (зі storage або null для нового користувача). */
      },
      // enableHighAccuracy:false — містова точність достатня для погоди,
      // мережева локація швидша й дешевша за GPS-фікс.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 15 * 60_000 },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return coords;
}
