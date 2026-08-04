import { useEffect, useState } from 'react';
import { cloudGetItem, cloudSetItem, cloudRemoveItem } from '../telegram.ts';

export interface GeoCoords {
  lat: number;
  lon: number;
}

const STORAGE_KEY = 'svitanok:lastGeo';
// 2 знаки після коми ≈ до 1.1км (по довготі на широті України ще менше) —
// містова точність: гасить GPS/мережевий джиттер між замірами (typical
// accuracy 20-500м без enableHighAccuracy), але ловить реальний переїзд в
// інше місце. Те саме округлене значення йде і в queryKey useLiveWeather —
// «збігається» означає буквально «не змінилось».
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseCoords(raw: string | null): GeoCoords | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.lat === 'number' && typeof parsed?.lon === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function readLocal(): GeoCoords | null {
  try {
    return parseCoords(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Пише в ОБИДВА сховища: localStorage — миттєвий синхронний кеш для першого
 *  рендера; CloudStorage — фактичне джерело істини між сесіями (синк на боці
 *  Telegram, не WebView-сховище). */
function writeStored(coords: GeoCoords | null): void {
  try {
    if (coords) localStorage.setItem(STORAGE_KEY, JSON.stringify(coords));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* приватний режим/квота сховища — тихо ігноруємо, localStorage тут лише кеш зручності */
  }
  if (coords) cloudSetItem(STORAGE_KEY, JSON.stringify(coords));
  else cloudRemoveItem(STORAGE_KEY);
}

/**
 * Координати браузера з памʼяттю між відкриттями (Блок «Погода»). Дозвіл на
 * геолокацію в Telegram Mini App «діє постійно» лише номінально — WebView
 * часто перестворюється при кожному відкритті, і холодний getCurrentPosition
 * не завжди встигає відповісти за швидкий повторний захід. Гірше того:
 * localStorage сам по собі ненадійний як памʼять МІЖ сеансами Mini App —
 * Telegram може чистити WebView-сховище між платформами/запусками (саме
 * тому в Bot API взагалі існує CloudStorage). Локальний тест підтвердив:
 * localStorage-only фікс не пережив повторне відкриття — застосунок знову
 * відкотився на дефолтний Львів.
 *
 * Тепер: на монтуванні ОДРАЗУ повертаємо localStorage (лінивий useState, чисто
 * для миттєвого першого рендера), а паралельно читаємо CloudStorage — і якщо
 * там щось є, а локально порожньо (саме той випадок, коли WebView-сховище не
 * пережило перезапуск), підхоплюємо хмарне значення (prev ?? cloud — не
 * перебиває вже наявне свіжіше). Тихо перепитуємо й свіжий GPS-фікс;
 * збігається в межах ~1км — нічого не міняємо; відрізняється — оновлюємо
 * стан і ОБИДВА сховища. PERMISSION_DENIED (реальне відкликання дозволу, на
 * відміну від транзиєнтного таймауту/POSITION_UNAVAILABLE) чистить обидва —
 * інакше застаріле місце показувалось би вічно.
 */
export function useGeolocation(): GeoCoords | null {
  const [coords, setCoords] = useState<GeoCoords | null>(readLocal);

  useEffect(() => {
    let cancelled = false;

    cloudGetItem(STORAGE_KEY).then((raw) => {
      if (cancelled) return;
      const cloud = parseCoords(raw);
      if (cloud) setCoords((prev) => prev ?? cloud);
    });

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
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
             відомій позиції (зі storage/cloud або null для нового користувача). */
        },
        // enableHighAccuracy:false — містова точність достатня для погоди,
        // мережева локація швидша й дешевша за GPS-фікс.
        { enableHighAccuracy: false, timeout: 10_000, maximumAge: 15 * 60_000 },
      );
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return coords;
}
