import { useEffect, useState } from 'react';
import { cloudGetItem, cloudSetItem, cloudRemoveItem, getTelegramLocation } from '../telegram.ts';

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
 * Діагностичний статус ЖИВОЇ спроби (не сховища). Стандартний
 * navigator.geolocation на пристрої власника мовчки НІКОЛИ не відповідав —
 * ні успіхом, ні помилкою, навіть довго після власного timeout: ознака, що
 * сам web Geolocation API заблокований на рівні WebView, в якому Telegram
 * рендерить Mini App (Permissions-Policy на iframe тощо), не відмова
 * дозволу користувачем. Статус рендериться в WeatherBlock маленьким
 * підписом — щоб бачити ТОЧНУ причину без доступу до консолі пристрою.
 */
export type GeoStatus = 'pending' | 'ok' | 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export interface GeoState {
  coords: GeoCoords | null;
  status: GeoStatus;
}

/** Фолбек для клієнтів без LocationManager (Bot API < 8.0) — стандартний Web
 *  Geolocation API. Обгорнутий у try/catch: якщо сам виклик кидає синхронно
 *  (WebView без належної реалізації), це раніше залишало статус 'pending'
 *  назавжди без жодного сигналу — саме так і виглядало на пристрої власника. */
function requestBrowserGeolocation(
  onSuccess: (c: GeoCoords) => void,
  onFail: (s: GeoStatus) => void,
): void {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    onFail('unsupported');
    return;
  }
  try {
    navigator.geolocation.getCurrentPosition(
      (pos) => onSuccess({ lat: round(pos.coords.latitude), lon: round(pos.coords.longitude) }),
      (err) => {
        if (err.code === 1 /* PERMISSION_DENIED */) onFail('denied');
        else if (err.code === 2 /* POSITION_UNAVAILABLE */) onFail('unavailable');
        else onFail('timeout');
      },
      // enableHighAccuracy:false — містова точність достатня для погоди,
      // мережева локація швидша й дешевша за GPS-фікс.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 15 * 60_000 },
    );
  } catch {
    onFail('unsupported');
  }
}

/**
 * Координати з памʼяттю між відкриттями (Блок «Погода»). Основний шлях —
 * Telegram LocationManager (Bot API 8.0+): дозвіл САМОГО Telegram (host app,
 * OS-рівень), в обхід web Geolocation API/Permissions-Policy WebView, де
 * стандартний navigator.geolocation мовчки ніколи не відповідав. Старий
 * клієнт без LocationManager — фолбек на navigator.geolocation.
 *
 * localStorage сам по собі ненадійний як памʼять МІЖ сеансами Mini App —
 * Telegram може чистити WebView-сховище між платформами/запусками (саме
 * тому в Bot API взагалі існує CloudStorage). На монтуванні ОДРАЗУ
 * повертаємо localStorage (лінивий useState, чисто для миттєвого першого
 * рендера), а паралельно читаємо CloudStorage — і якщо там щось є, а
 * локально порожньо, підхоплюємо хмарне значення (prev ?? cloud — не
 * перебиває вже наявне свіжіше). Тихо перепитуємо й свіжий фікс; збігається
 * в межах ~1км — нічого не міняємо; відрізняється — оновлюємо стан і
 * ОБИДВА сховища. Відмова дозволу чистить обидва — інакше застаріле місце
 * показувалось би вічно.
 */
export function useGeolocation(): GeoState {
  const [coords, setCoords] = useState<GeoCoords | null>(readLocal);
  const [status, setStatus] = useState<GeoStatus>('pending');

  useEffect(() => {
    let cancelled = false;

    cloudGetItem(STORAGE_KEY).then((raw) => {
      if (cancelled) return;
      const cloud = parseCoords(raw);
      if (cloud) setCoords((prev) => prev ?? cloud);
    });

    const apply = (next: GeoCoords) => {
      if (cancelled) return;
      setStatus('ok');
      setCoords((prev) => {
        if (prev && prev.lat === next.lat && prev.lon === next.lon) return prev;
        writeStored(next);
        return next;
      });
    };
    const fail = (s: GeoStatus) => {
      if (cancelled) return;
      setStatus(s);
      if (s === 'denied') {
        writeStored(null);
        setCoords(null);
      }
      /* unavailable/timeout/unsupported — транзиєнтне/платформне, лишаємось
         на останній відомій позиції (зі storage/cloud або null для нового
         користувача). */
    };

    const attempt = () => {
      getTelegramLocation().then((res) => {
        if (cancelled) return;
        if (res.ok) {
          apply({ lat: round(res.lat), lon: round(res.lon) });
          return;
        }
        if (res.reason !== 'unsupported') {
          fail(res.reason);
          return;
        }
        requestBrowserGeolocation(apply, fail);
      });
    };

    attempt();

    // openLocationSettings() відкриває системний екран Telegram, але НЕ
    // перезавантажує сторінку — WebView Mini App лишається живим, ефект з
    // порожнім deps-масивом виконався б рівно раз і назавжди застряг би на
    // старому статусі, навіть якщо власник щойно надав дозвіл. Перепитуємо
    // при поверненні у вкладку (той самий сигнал, що й повернення з фону).
    const onVisible = () => {
      if (document.visibilityState === 'visible') attempt();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { coords, status };
}
